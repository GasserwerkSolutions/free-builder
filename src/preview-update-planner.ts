import { MAX_TESTIMONIALS, getAtPath, type BuilderDraftV2, type BuilderStaff, type ManualTestimonial } from "./domain.js";
import type { DraftEffect, DraftMutation, EditableFieldPath, StaffEditableField } from "./draft-mutations.js";
import type { PreviewOperation, PreviewRegion, PreviewTarget } from "./preview-contract.js";
import { PREVIEW_REGIONS } from "./preview-contract.js";
import { renderPreviewRegions, type PreviewRenderOptions } from "./preview-renderer.js";

export type PreviewUpdateFullReason = "draft-replace" | "layout" | "metadata" | "unsupported";

export type PreviewUpdatePlan =
  | { kind: "full"; revision: number; reason: PreviewUpdateFullReason }
  | { kind: "noop"; revision: number }
  | { kind: "patch"; revision: number; operations: readonly PreviewOperation[] };

/**
 * Which parts of the page a change reaches.
 *
 * This module is the single declaration of that dependency, and it is checked mechanically rather
 * than by reading: tests/preview-coverage.test.mjs replays every mutation kind, applies the plan to
 * the previous render and demands that the result equals a fresh full render. A region that really
 * changes but is not named here therefore fails the build — it can no longer be caught only by the
 * preview document rejecting the bundle.
 *
 * KNOWN AND DELIBERATE GAP — the document <head>. Title, meta description and the JSON-LD block are
 * derived from the draft (salon name, city, hero subtitle, opening hours, services, team) but are
 * never patched: they live outside every region, nothing in the preview shows them, and each full
 * render as well as every export rebuilds them from scratch. So the head of a patched preview
 * document can lag behind its body until the next rebuild. That is a preview-only, invisible drift;
 * making it visible would mean either patching head nodes (a second, differently shaped protocol) or
 * rebuilding on every metadata-bearing edit (which is most of them). If the head ever becomes
 * observable — a preview that shows the browser tab, a search-preview panel — this is the note that
 * says the drift is real and has to be closed then.
 */

/**
 * Fields that appear exactly once in the rendered page as plain text. Only those can be patched as
 * text; everything else goes through a region replacement, because a text patch that misses a second
 * occurrence would leave the preview showing two different truths.
 */
const TEXT_FIELDS: Partial<Record<EditableFieldPath, PreviewRegion>> = {
  "copy.heroLabel": "hero",
  "copy.heroTitle": "hero",
  "copy.heroSubtitle": "hero",
  "copy.servicesTitle": "services",
  "copy.servicesSubtitle": "services",
  "copy.bookingTitle": "booking",
  "copy.bookingSubtitle": "booking",
};

/**
 * Fields with more than one occurrence, or one that changes structure — and whose set of regions is
 * the same no matter what the rest of the draft looks like. The three fields that do depend on the
 * draft (`salon.name`, `testimonials.enabled` and the two theme colours) are decided in the switch.
 */
const REGION_FIELDS: Partial<Record<EditableFieldPath, readonly PreviewRegion[]>> = {
  "salon.tagline": ["intro", "footer"],
  "salon.phone": ["hero", "details"],
  "salon.email": ["details"],
  // The draft stores an Instagram address only as "" or as a URL the page will actually link, so any
  // accepted change to it moves the contact block.
  "salon.instagram": ["details"],
  "salon.address": ["intro", "details"],
  "salon.postalCode": ["intro", "details"],
  "salon.city": ["intro", "details"],
};

/** The staff fields the website prints. `email` is booking data and appears nowhere on the page. */
const RENDERED_STAFF_FIELDS = new Set<StaffEditableField>(["name", "role", "bio", "active"]);

function isStaffVisible(person: BuilderStaff): boolean { return person.active && Boolean(person.name.trim()); }
function visibleStaffCount(draft: Readonly<BuilderDraftV2>): number { return draft.staff.filter(isStaffVisible).length; }
function isTestimonialFilled(item: ManualTestimonial): boolean { return Boolean(item.quote.trim() && item.name.trim()); }
function filledTestimonialCount(draft: Readonly<BuilderDraftV2>): number {
  return draft.testimonials.items.filter(isTestimonialFilled).slice(0, MAX_TESTIMONIALS).length;
}
function visibleTestimonialCount(draft: Readonly<BuilderDraftV2>): number {
  return draft.testimonials.enabled ? filledTestimonialCount(draft) : 0;
}

/** Does anybody the page shows offer this service? Only then does its name reach the team block. */
function staffShowsService(draft: Readonly<BuilderDraftV2>, serviceClientId: string): boolean {
  return draft.staff.some((person) => isStaffVisible(person) && person.serviceClientIds.includes(serviceClientId));
}

/**
 * A section that goes from "not on the page" to "on the page" (or back) is not a replacement.
 *
 * The header navigation shows a "Team" and a "Stimmen" link exactly while those sections exist, so
 * such a transition always changes two regions at once — and one of them does not exist in the
 * document yet, which no `replace-region` can express. The only correct answer is a rebuild, and the
 * planner has to give it here rather than let the preview document discover the missing region.
 */
function presenceFlipped(before: number, after: number): boolean { return (before > 0) !== (after > 0); }

type CollectOutcome = PreviewUpdateFullReason | null;

export function planPreviewUpdate(mutations: readonly DraftMutation[], draft: Readonly<BuilderDraftV2>, renderOptions: PreviewRenderOptions): PreviewUpdatePlan {
  const revision = mutations.reduce((latest, mutation) => Math.max(latest, mutation.revision), renderOptions.revision);
  const regions = new Set<PreviewRegion>();
  const texts = new Map<string, Extract<PreviewOperation, { type: "patch-text" }>>();
  let patchTheme = false;

  for (const mutation of mutations) {
    const effect = mutation.effect;
    switch (effect.type) {
      case "draft-replace": return { kind: "full", revision, reason: "draft-replace" };
      case "unverified-batch": return { kind: "full", revision, reason: "unsupported" };
      case "theme-set": {
        // A preset carries fonts, background, surface and radius — that is a whole new stylesheet,
        // not two custom properties. Only a bare colour change stays patchable.
        if (effect.changed.some((key) => key !== "primary" && key !== "accent")) return { kind: "full", revision, reason: "metadata" };
        patchTheme = true;
        break;
      }
      case "field-set": {
        // The two colour inputs are bound fields, so they arrive as field-set and not as theme-set
        // (only a preset produces that). Both end in the same two custom properties.
        if (effect.field === "theme.primary" || effect.field === "theme.accent") { patchTheme = true; break; }
        if (effect.field === "salon.name") {
          regions.add("header"); regions.add("details"); regions.add("footer");
          // The intro strip prints the salon name only as a stand-in for a missing tagline.
          if (!draft.salon.tagline) regions.add("intro");
          break;
        }
        if (effect.field === "testimonials.enabled") {
          // The toggle switches the whole block on or off. With something to show that is a section
          // appearing or disappearing; with nothing to show the page does not move at all.
          if (filledTestimonialCount(draft) > 0) return { kind: "full", revision, reason: "layout" };
          break;
        }
        const regional = REGION_FIELDS[effect.field];
        if (regional) { regional.forEach((region) => regions.add(region)); break; }
        const textRegion = TEXT_FIELDS[effect.field];
        if (!textRegion) return { kind: "full", revision, reason: "unsupported" };
        // Going from or to empty can add or drop the surrounding markup, so only a present-to-present
        // edit is a pure text change.
        if (effect.previousPresence === "present" && effect.nextPresence === "present") {
          addText(texts, { kind: "field", field: effect.field }, String(getAtPath(draft, effect.field) ?? ""));
        } else {
          regions.add(textRegion);
        }
        break;
      }
      case "service-field-set": {
        regions.add("services");
        // Of the eight service fields only the name leaves the price list: the team block prints the
        // names of the services a person may perform. Everything else stays inside "services".
        if (effect.field === "name" && staffShowsService(draft, effect.serviceClientId)) regions.add("team");
        break;
      }
      case "collection-insert":
      case "collection-remove":
      case "collection-move": {
        const outcome = collectCollectionChange(effect, draft, regions);
        if (outcome) return { kind: "full", revision, reason: outcome };
        break;
      }
      case "testimonial-field-set": {
        const outcome = collectTestimonialField(effect, draft, regions);
        if (outcome) return { kind: "full", revision, reason: outcome };
        break;
      }
      case "staff-field-set": {
        const outcome = collectStaffField(effect, draft, regions);
        if (outcome) return { kind: "full", revision, reason: outcome };
        break;
      }
      case "staff-services-set": {
        const person = draft.staff.find((item) => item.clientId === effect.staffClientId);
        // The assignment is printed inside that person's card, so it only shows for a visible person.
        if (person && isStaffVisible(person)) regions.add("team");
        break;
      }
      case "business-hours-set": regions.add("details"); break;
      // Personal working hours are a booking truth, not a website one — nothing on the page shows them.
      case "staff-hours-set": break;
    }
  }

  // A region replacement already carries the new text, so a text patch inside it would be a duplicate
  // write to a node that no longer exists.
  for (const [key, operation] of texts) {
    const region = regionForTarget(operation.target);
    if (region && regions.has(region)) texts.delete(key);
  }

  const operations: PreviewOperation[] = [];
  const ordered = PREVIEW_REGIONS.filter((region) => regions.has(region));
  if (ordered.length) {
    let rendered: ReadonlyMap<PreviewRegion, string>;
    try {
      rendered = renderPreviewRegions(ordered, draft, { ...renderOptions, revision });
    } catch {
      // The region is gone from the new render: the section disappeared. Only a rebuild can express
      // that, so stop planning and let the caller render everything.
      return { kind: "full", revision, reason: "layout" };
    }
    for (const region of ordered) {
      const html = rendered.get(region);
      if (!html) return { kind: "full", revision, reason: "unsupported" };
      operations.push({ type: "replace-region", region, html });
    }
  }
  if (patchTheme) operations.push({ type: "patch-theme", primary: draft.theme.primary, accent: draft.theme.accent });
  operations.push(...[...texts.values()].sort((left, right) => targetKey(left.target).localeCompare(targetKey(right.target))));
  return operations.length ? { kind: "patch", revision, operations } : { kind: "noop", revision };
}

/**
 * Insert / remove / move inside one of the three editable collections.
 *
 * Everything here is decided from the draft *after* the change plus what the effect remembers of the
 * state before it. Where that is not enough to tell "nothing moved" from "a section appeared", the
 * answer is a rebuild — never a bundle that happens to work.
 */
function collectCollectionChange(effect: Extract<DraftEffect, { type: "collection-insert" | "collection-remove" | "collection-move" }>, draft: Readonly<BuilderDraftV2>, regions: Set<PreviewRegion>): CollectOutcome {
  if (effect.collection === "services") {
    regions.add("services");
    if (effect.type === "collection-move") return null;
    if (effect.type === "collection-insert") {
      if (staffShowsService(draft, effect.clientId)) regions.add("team");
      return null;
    }
    // A removal has already been erased from every assignment, so who used to offer it can no longer
    // be read off the draft. Whenever there is a team block at all, it is requested with it.
    if (visibleStaffCount(draft) > 0) regions.add("team");
    return null;
  }

  if (effect.collection === "staff") {
    const countAfter = visibleStaffCount(draft);
    const person = draft.staff.find((item) => item.clientId === effect.clientId);
    if (effect.type === "collection-insert") {
      // A fresh card carries no name yet, so it shows nothing until it is filled in.
      if (!person || !isStaffVisible(person)) return null;
      if (presenceFlipped(countAfter - 1, countAfter)) return "layout";
      regions.add("team");
      return null;
    }
    if (effect.type === "collection-remove") {
      // The person is gone, so whether they were on the page cannot be read off the draft any more.
      // With nobody left the section is gone too, and that is not a replacement.
      if (countAfter === 0) return "layout";
      regions.add("team");
      return null;
    }
    // Reordering shows only when the moved person is on the page next to at least one other.
    if (person && isStaffVisible(person) && countAfter > 1) regions.add("team");
    return null;
  }

  const countAfter = visibleTestimonialCount(draft);
  if (effect.type === "collection-insert") {
    // Adding an entry also switches the section on, and an entry can be added while it is off. Either
    // way the block may have just appeared, and the resulting draft no longer says which it was.
    if (countAfter > 0) return "layout";
    return null;
  }
  if (effect.type === "collection-remove") {
    if (countAfter === 0) return "layout";
    regions.add("voices");
    return null;
  }
  const item = draft.testimonials.items.find((entry) => entry.clientId === effect.clientId);
  if (item && draft.testimonials.enabled && isTestimonialFilled(item) && countAfter > 1) regions.add("voices");
  return null;
}

function collectStaffField(effect: Extract<DraftEffect, { type: "staff-field-set" }>, draft: Readonly<BuilderDraftV2>, regions: Set<PreviewRegion>): CollectOutcome {
  const person = draft.staff.find((item) => item.clientId === effect.staffClientId);
  if (!person) return "unsupported";
  const visibleAfter = isStaffVisible(person);
  // Two of the five fields decide whether the person is on the page at all; for the others the
  // effect's own before/after presence is the only thing that moved.
  const visibleBefore = effect.field === "active"
    ? effect.previousPresence === "present" && Boolean(person.name.trim())
    : effect.field === "name"
      ? person.active && effect.previousPresence === "present"
      : visibleAfter;
  const countAfter = visibleStaffCount(draft);
  const countBefore = countAfter - (visibleAfter ? 1 : 0) + (visibleBefore ? 1 : 0);
  if (presenceFlipped(countBefore, countAfter)) return "layout";
  if (RENDERED_STAFF_FIELDS.has(effect.field) && (visibleBefore || visibleAfter)) regions.add("team");
  return null;
}

function collectTestimonialField(effect: Extract<DraftEffect, { type: "testimonial-field-set" }>, draft: Readonly<BuilderDraftV2>, regions: Set<PreviewRegion>): CollectOutcome {
  const item = draft.testimonials.items.find((entry) => entry.clientId === effect.testimonialClientId);
  if (!item) return "unsupported";
  const enabled = draft.testimonials.enabled;
  const visibleAfter = enabled && isTestimonialFilled(item);
  // A quote without a name (or the other way round) is not printed, so either field can take the
  // whole entry off the page.
  const visibleBefore = effect.field === "quote"
    ? enabled && effect.previousPresence === "present" && Boolean(item.name.trim())
    : effect.field === "name"
      ? enabled && Boolean(item.quote.trim()) && effect.previousPresence === "present"
      : visibleAfter;
  const countAfter = visibleTestimonialCount(draft);
  const countBefore = countAfter - (visibleAfter ? 1 : 0) + (visibleBefore ? 1 : 0);
  if (presenceFlipped(countBefore, countAfter)) return "layout";
  if (visibleBefore || visibleAfter) regions.add("voices");
  return null;
}

function addText(targets: Map<string, Extract<PreviewOperation, { type: "patch-text" }>>, target: PreviewTarget, value: string): void {
  targets.set(targetKey(target), { type: "patch-text", target, value });
}

function targetKey(target: PreviewTarget): string { return JSON.stringify(target); }

function regionForTarget(target: PreviewTarget): PreviewRegion | null {
  if (target.kind === "service") return "services";
  if (target.kind === "testimonial") return "voices";
  if (target.kind === "staff") return "team";
  // Only a TEXT_FIELDS entry can ever become a text patch in the first place.
  if (target.kind === "field") return TEXT_FIELDS[target.field] ?? null;
  return null;
}
