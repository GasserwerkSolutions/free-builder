import type {
  BuilderAssetRef,
  BuilderDraftV2,
  BuilderService,
  BuilderStaff,
  ManualTestimonial,
  WeeklySchedule,
} from "./domain-model.js";
import { cloneDraft, getAtPath, normalizeEmail, normalizeInstagramUrl, normalizePhone, setAtPath } from "./domain-helpers.js";
import type { PreviewTarget } from "./preview-contract.js";

// Intent -> verified effect.
//
// Every mutation has to declare up front what it intends to change. The effect is only handed back
// once the real before/after snapshots prove that exactly the declared change happened; anything
// else throws. A silent cross-field write therefore never reaches the draft, the autosave or the
// undo stack. The declared scope is also what keeps the server contract intact at runtime: a
// business-hours edit that also touched a person's working hours is rejected, because those are two
// separate truths in this model.

export type ContentPresence = "empty" | "present" | "invalid";
export type ReplaceReason = "import" | "reset" | "recovery";
export type DraftMutationSource = "user" | "undo" | "redo" | ReplaceReason;
/**
 * `target` is runtime metadata, never draft content: it says which editor field this step was about,
 * so a later undo/redo can put the user back in front of it. Nothing persists it and no draft field
 * carries it — the draft contract is untouched by its existence.
 */
export type HistoryDescriptor = { key?: string; label: string; target?: PreviewTarget };

type SalonKey = keyof BuilderDraftV2["salon"];
type CopyKey = keyof BuilderDraftV2["copy"];

/** Scalar draft fields that the editor binds directly to a single input. */
export type EditableFieldPath =
  | `salon.${SalonKey}`
  | `copy.${CopyKey}`
  | "theme.primary"
  | "theme.accent"
  | "testimonials.enabled";

export type ServiceEditableField = "category" | "name" | "description" | "durationMinutes" | "price" | "priceType" | "bookable";
export type TestimonialEditableField = "quote" | "name" | "detail";
export type StaffEditableField = "name" | "email" | "role" | "bio" | "active";
export type DraftCollection = "services" | "staff" | "testimonials";
export type ThemeKey = "preset" | "primary" | "accent";

export type DraftMutationIntent =
  | { type: "set-field"; field: EditableFieldPath }
  | { type: "set-service-field"; serviceClientId: string; field: ServiceEditableField }
  | { type: "set-testimonial-field"; testimonialClientId: string; field: TestimonialEditableField }
  | { type: "set-staff-field"; staffClientId: string; field: StaffEditableField }
  | { type: "set-staff-services"; staffClientId: string }
  | { type: "set-business-hours" }
  | { type: "set-staff-hours"; staffClientId: string }
  | { type: "insert-collection-item"; collection: DraftCollection; clientId: string }
  | { type: "remove-collection-item"; collection: DraftCollection; clientId: string }
  | { type: "move-collection-item"; collection: DraftCollection; clientId: string }
  | { type: "set-theme" }
  | { type: "replace-draft"; reason: ReplaceReason }
  // Escape hatch for callers that do not describe their change yet. It is accepted (something did
  // change) but never verified, and it says so in the effect it produces.
  | { type: "batch" };

export type DraftMutationDescriptor = { intent: DraftMutationIntent; history: HistoryDescriptor };

export type DraftEffect =
  | { type: "field-set"; field: EditableFieldPath; previousPresence: ContentPresence; nextPresence: ContentPresence }
  | { type: "service-field-set"; serviceClientId: string; field: ServiceEditableField; previousPresence: ContentPresence; nextPresence: ContentPresence }
  | { type: "testimonial-field-set"; testimonialClientId: string; field: TestimonialEditableField; previousPresence: ContentPresence; nextPresence: ContentPresence }
  | { type: "staff-field-set"; staffClientId: string; field: StaffEditableField; previousPresence: ContentPresence; nextPresence: ContentPresence }
  | { type: "staff-services-set"; staffClientId: string; previousCount: number; nextCount: number }
  | { type: "business-hours-set"; previousOpenDays: number; nextOpenDays: number }
  | { type: "staff-hours-set"; staffClientId: string; previousOpenDays: number; nextOpenDays: number }
  | { type: "collection-insert"; collection: DraftCollection; clientId: string; index: number }
  | { type: "collection-remove"; collection: DraftCollection; clientId: string; previousIndex: number }
  | { type: "collection-move"; collection: DraftCollection; clientId: string; previousIndex: number; nextIndex: number }
  | { type: "theme-set"; changed: readonly ThemeKey[] }
  | { type: "draft-replace"; reason: ReplaceReason }
  | { type: "unverified-batch" };

export type DraftMutation = { revision: number; source: DraftMutationSource; effect: DraftEffect; history: HistoryDescriptor; occurredAt: number };
export type HistoryRecord = { before: BuilderDraftV2; effect: DraftEffect; history: HistoryDescriptor; createdAt: number };

type DraftItem = { clientId: string };
type CollectionSpec = {
  read: (draft: Readonly<BuilderDraftV2>) => readonly DraftItem[];
  write: (draft: BuilderDraftV2, items: readonly DraftItem[]) => void;
  /** Sibling state that a structural change to this collection is allowed to drag along. */
  cascade: (expected: BuilderDraftV2, after: Readonly<BuilderDraftV2>) => void;
};

// The single place that knows where each editable collection lives and what a structural change to
// it may cascade into. Everything else in this module stays collection-agnostic.
const COLLECTIONS: Record<DraftCollection, CollectionSpec> = {
  services: {
    read: (draft) => draft.services,
    write: (draft, items) => { draft.services = structuredClone(items) as BuilderService[]; },
    // Dropping a service must also drop it from every assignment; serviceClientIds stays the single
    // truth about who may perform what, so only that list may follow — nothing else on a person.
    cascade: (expected, after) => {
      expected.staff.forEach((person) => {
        const next = after.staff.find((item) => item.clientId === person.clientId);
        if (next) person.serviceClientIds = [...next.serviceClientIds];
      });
    },
  },
  staff: {
    read: (draft) => draft.staff,
    write: (draft, items) => { draft.staff = structuredClone(items) as BuilderStaff[]; },
    // Removing a person removes the assets they own. Only removals are allowed to follow.
    // Open for the image step (F4): the reverse direction has no cascade yet — deleting a single
    // asset leaves staff[].portraitAssetLocalId pointing at it. Today nothing can delete an asset
    // on its own, so the dangling pointer is not reachable; when image management lands, that
    // deletion has to declare the pointer reset as part of its scope.
    cascade: (expected, after) => {
      const kept = new Set(after.assets.map((asset) => asset.localId));
      expected.assets = expected.assets.filter((asset: BuilderAssetRef) => kept.has(asset.localId));
    },
  },
  testimonials: {
    read: (draft) => draft.testimonials.items,
    write: (draft, items) => { draft.testimonials.items = structuredClone(items) as ManualTestimonial[]; },
    // The section toggle follows the item count (first entry enables it, last removal disables it).
    cascade: (expected, after) => { expected.testimonials.enabled = after.testimonials.enabled; },
  },
};

// Fields a collection-item edit derives from its primary field. The intent names the primary field
// only; everything listed here is re-derived by the very same edit and therefore part of its declared
// scope. Because a derived field can move on its own (a service rename that only reclaims a slug that
// another service just freed), the change requirement is "at least one declared field moved" — not
// "the primary one moved". Anything outside this list still fails the whole-draft check below.
const DERIVED_ITEM_FIELDS: Record<string, readonly string[]> = {
  "services:name": ["slug"],
};

function declaredItemFields(collection: DraftCollection, field: string): readonly string[] {
  return [field, ...(DERIVED_ITEM_FIELDS[`${collection}:${field}`] ?? [])];
}

export function draftsEqualIgnoringUpdatedAt(left: Readonly<BuilderDraftV2>, right: Readonly<BuilderDraftV2>): boolean {
  return JSON.stringify(comparableDraft(left)) === JSON.stringify(comparableDraft(right));
}

export function createDraftEffect(before: Readonly<BuilderDraftV2>, after: Readonly<BuilderDraftV2>, intent: DraftMutationIntent): DraftEffect {
  if (draftsEqualIgnoringUpdatedAt(before, after)) throw new Error("MUTATION_EFFECT_FOR_NOOP");
  switch (intent.type) {
    case "set-field": {
      const change = pathChange(before, after, intent.field, "INVALID_FIELD_SET", "UNEXPECTED_FIELD_CHANGE");
      const rule = FIELD_PRESENCE_RULES[intent.field];
      return { type: "field-set", field: intent.field, previousPresence: presence(change.previous, rule), nextPresence: presence(change.next, rule) };
    }
    case "set-service-field": {
      // Renaming a service re-derives its slug, so the slug is part of the declared change.
      const change = itemFieldChange(before, after, "services", intent.serviceClientId, declaredItemFields("services", intent.field), "INVALID_SERVICE_FIELD_SET", "UNEXPECTED_SERVICE_FIELD_CHANGE");
      return { type: "service-field-set", serviceClientId: intent.serviceClientId, field: intent.field, previousPresence: presence(change.previous), nextPresence: presence(change.next) };
    }
    case "set-testimonial-field": {
      const change = itemFieldChange(before, after, "testimonials", intent.testimonialClientId, declaredItemFields("testimonials", intent.field), "INVALID_TESTIMONIAL_FIELD_SET", "UNEXPECTED_TESTIMONIAL_FIELD_CHANGE");
      return { type: "testimonial-field-set", testimonialClientId: intent.testimonialClientId, field: intent.field, previousPresence: presence(change.previous), nextPresence: presence(change.next) };
    }
    case "set-staff-field": {
      const change = itemFieldChange(before, after, "staff", intent.staffClientId, declaredItemFields("staff", intent.field), "INVALID_STAFF_FIELD_SET", "UNEXPECTED_STAFF_FIELD_CHANGE");
      const rule = STAFF_FIELD_PRESENCE_RULES[intent.field];
      return { type: "staff-field-set", staffClientId: intent.staffClientId, field: intent.field, previousPresence: presence(change.previous, rule), nextPresence: presence(change.next, rule) };
    }
    case "set-staff-services": {
      const change = itemFieldChange(before, after, "staff", intent.staffClientId, ["serviceClientIds"], "INVALID_STAFF_SERVICES_SET", "UNEXPECTED_STAFF_SERVICES_CHANGE");
      return { type: "staff-services-set", staffClientId: intent.staffClientId, previousCount: asStringList(change.previous).length, nextCount: asStringList(change.next).length };
    }
    case "set-business-hours": {
      // Declared scope is businessHours only. A mutation that also rewrote a person's workingHours
      // is rejected here — the two schedules stay separate truths.
      const change = pathChange(before, after, "businessHours", "INVALID_BUSINESS_HOURS_SET", "UNEXPECTED_BUSINESS_HOURS_CHANGE");
      return { type: "business-hours-set", previousOpenDays: openDays(change.previous), nextOpenDays: openDays(change.next) };
    }
    case "set-staff-hours": {
      // Mirror image of the above: one person's workingHours, never the salon's businessHours.
      const change = itemFieldChange(before, after, "staff", intent.staffClientId, ["workingHours"], "INVALID_STAFF_HOURS_SET", "UNEXPECTED_STAFF_HOURS_CHANGE");
      return { type: "staff-hours-set", staffClientId: intent.staffClientId, previousOpenDays: openDays(change.previous), nextOpenDays: openDays(change.next) };
    }
    case "insert-collection-item": return structuralEffect(before, after, intent.collection, intent.clientId, "insert");
    case "remove-collection-item": return structuralEffect(before, after, intent.collection, intent.clientId, "remove");
    case "move-collection-item": return structuralEffect(before, after, intent.collection, intent.clientId, "move");
    case "set-theme": {
      const changed = (["preset", "primary", "accent"] as const).filter((key) => before.theme[key] !== after.theme[key]);
      if (!changed.length) throw new Error("INVALID_THEME_SET");
      pathChange(before, after, "theme", "INVALID_THEME_SET", "UNEXPECTED_THEME_CHANGE");
      return { type: "theme-set", changed };
    }
    case "replace-draft": return { type: "draft-replace", reason: intent.reason };
    case "batch": return { type: "unverified-batch" };
  }
}

export function invertDraftEffect(effect: DraftEffect): DraftEffect {
  switch (effect.type) {
    case "field-set":
    case "service-field-set":
    case "testimonial-field-set":
    case "staff-field-set":
      return { ...effect, previousPresence: effect.nextPresence, nextPresence: effect.previousPresence };
    case "staff-services-set":
      return { ...effect, previousCount: effect.nextCount, nextCount: effect.previousCount };
    case "business-hours-set":
    case "staff-hours-set":
      return { ...effect, previousOpenDays: effect.nextOpenDays, nextOpenDays: effect.previousOpenDays };
    case "collection-insert":
      return { type: "collection-remove", collection: effect.collection, clientId: effect.clientId, previousIndex: effect.index };
    case "collection-remove":
      return { type: "collection-insert", collection: effect.collection, clientId: effect.clientId, index: effect.previousIndex };
    case "collection-move":
      return { ...effect, previousIndex: effect.nextIndex, nextIndex: effect.previousIndex };
    case "unverified-batch":
      return { type: "unverified-batch" };
    case "theme-set":
      throw new Error("THEME_EFFECT_REQUIRES_SNAPSHOT_VERIFICATION");
    case "draft-replace":
      throw new Error("DRAFT_REPLACE_EFFECT_IS_NOT_INVERTIBLE");
  }
}

/**
 * theme-set only carries the keys that actually changed, so its inverse cannot be read off the
 * forward effect — it has to be re-derived from the two snapshots.
 */
export function requiresSnapshotInversion(effect: DraftEffect): boolean { return effect.type === "theme-set"; }

/** Two edits may only be grouped into one undo step when they aim at the same target. */
export function sameIntentTarget(left: DraftMutationIntent, right: DraftMutationIntent): boolean {
  return intentIdentity(left) === intentIdentity(right);
}

export function sourceForReplaceReason(reason: ReplaceReason): DraftMutationSource { return reason; }

type ValueChange = { previous: unknown; next: unknown };

// Verify a change that is addressed by a dot path into the draft.
function pathChange(before: Readonly<BuilderDraftV2>, after: Readonly<BuilderDraftV2>, path: string, invalidCode: string, unexpectedCode: string): ValueChange {
  const previous = getAtPath(before, path);
  const next = getAtPath(after, path);
  if (sameValue(previous, next)) throw new Error(invalidCode);
  expectDraft(before, after, (expected) => setAtPath(expected, path, structuredClone(next)), unexpectedCode);
  return { previous, next };
}

// Verify a change to the declared fields of one collection item. `fields[0]` is the field the intent
// is about; the rest are the derived ones the same edit re-derives. At least one of them has to have
// moved — requiring the primary one would reject a rename that only re-derived its slug.
function itemFieldChange(
  before: Readonly<BuilderDraftV2>,
  after: Readonly<BuilderDraftV2>,
  collection: DraftCollection,
  clientId: string,
  fields: readonly string[],
  invalidCode: string,
  unexpectedCode: string,
): ValueChange {
  const primaryField = fields[0];
  if (!primaryField) throw new Error(invalidCode);
  const previous = findItem(before, collection, clientId);
  const next = findItem(after, collection, clientId);
  if (!previous || !next) throw new Error(invalidCode);
  if (fields.every((field) => sameValue(previous[field], next[field]))) throw new Error(invalidCode);
  expectDraft(before, after, (expected) => {
    const target = findItem(expected, collection, clientId);
    if (!target) throw new Error(invalidCode);
    fields.forEach((field) => { target[field] = structuredClone(next[field]); });
  }, unexpectedCode);
  return { previous: previous[primaryField], next: next[primaryField] };
}

// Verify an insert / remove / move inside one collection. The three cases differ only in what they
// consider a valid item movement, so the surrounding verification is shared.
function structuralEffect(before: Readonly<BuilderDraftV2>, after: Readonly<BuilderDraftV2>, collection: DraftCollection, clientId: string, kind: "insert" | "remove" | "move"): DraftEffect {
  const spec = COLLECTIONS[collection];
  const previousItems = spec.read(before);
  const nextItems = spec.read(after);
  const previousIndex = previousItems.findIndex((item) => item.clientId === clientId);
  const nextIndex = nextItems.findIndex((item) => item.clientId === clientId);
  const invalidCode = `INVALID_COLLECTION_${kind.toUpperCase()}`;
  if (kind === "insert") {
    if (previousIndex >= 0 || nextIndex < 0 || nextItems.length !== previousItems.length + 1) throw new Error(invalidCode);
    if (!sameValue(nextItems.filter((item) => item.clientId !== clientId), previousItems)) throw new Error(`UNEXPECTED_COLLECTION_INSERT_CHANGE`);
  } else if (kind === "remove") {
    if (previousIndex < 0 || nextIndex >= 0 || nextItems.length !== previousItems.length - 1) throw new Error(invalidCode);
    if (!sameValue(previousItems.filter((item) => item.clientId !== clientId), nextItems)) throw new Error(`UNEXPECTED_COLLECTION_REMOVE_CHANGE`);
  } else {
    if (previousIndex < 0 || nextIndex < 0 || previousIndex === nextIndex || previousItems.length !== nextItems.length) throw new Error(invalidCode);
    const simulated = structuredClone(previousItems) as DraftItem[];
    const [moved] = simulated.splice(previousIndex, 1);
    if (!moved) throw new Error(invalidCode);
    simulated.splice(nextIndex, 0, moved);
    if (!sameValue(simulated, nextItems)) throw new Error(`UNEXPECTED_COLLECTION_MOVE_CHANGE`);
  }
  expectDraft(before, after, (expected) => { spec.write(expected, nextItems); spec.cascade(expected, after); }, `UNEXPECTED_COLLECTION_${kind.toUpperCase()}_DRAFT_CHANGE`);
  if (kind === "insert") return { type: "collection-insert", collection, clientId, index: nextIndex };
  if (kind === "remove") return { type: "collection-remove", collection, clientId, previousIndex };
  return { type: "collection-move", collection, clientId, previousIndex, nextIndex };
}

// The one assertion every intent runs through: rebuild what the draft should look like when only the
// declared change happened, and demand that the real result is exactly that.
function expectDraft(before: Readonly<BuilderDraftV2>, after: Readonly<BuilderDraftV2>, build: (expected: BuilderDraftV2) => void, code: string): void {
  const expected = cloneDraft(before);
  build(expected);
  if (!draftsEqualIgnoringUpdatedAt(expected, after)) throw new Error(code);
}

function findItem(draft: Readonly<BuilderDraftV2>, collection: DraftCollection, clientId: string): Record<string, unknown> | undefined {
  const item = COLLECTIONS[collection].read(draft).find((entry) => entry.clientId === clientId);
  return item as Record<string, unknown> | undefined;
}

function comparableDraft(draft: Readonly<BuilderDraftV2>): BuilderDraftV2 {
  const copy = cloneDraft(draft);
  copy.updatedAt = "";
  return copy;
}

function sameValue(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function asStringList(value: unknown): readonly string[] { return Array.isArray(value) ? value as string[] : []; }

function openDays(value: unknown): number {
  return Array.isArray(value) ? (value as WeeklySchedule).filter((day) => !day.closed).length : 0;
}

/**
 * "Does this field carry usable content?" — three-valued. Filled in is not the same as usable: the
 * draft stores what the user typed, and only a few fields carry a syntax that can be judged. The
 * judgement lives here and nowhere else: neither the draft contract nor the normalizer is allowed to
 * coerce a contact detail, so "das-ist-keine-mail" is stored verbatim and reported as `invalid`.
 */
type PresenceRule = (value: string) => boolean;
const isEmail: PresenceRule = (value) => normalizeEmail(value) !== null;
const isPhone: PresenceRule = (value) => normalizePhone(value) !== null;
const isInstagram: PresenceRule = (value) => normalizeInstagramUrl(value) !== null;

const FIELD_PRESENCE_RULES: Partial<Record<EditableFieldPath, PresenceRule>> = {
  "salon.email": isEmail,
  "salon.phone": isPhone,
  "salon.instagram": isInstagram,
};
const STAFF_FIELD_PRESENCE_RULES: Partial<Record<StaffEditableField, PresenceRule>> = {
  email: isEmail,
};

/**
 * The presence of one bound scalar field, judged by exactly the rules the mutation layer uses.
 * Exported so a surface (the publish list) asks this authority instead of re-deciding "is this
 * usable?" a second time and drifting away from it.
 */
export function fieldPresence(draft: Readonly<BuilderDraftV2>, field: EditableFieldPath): ContentPresence {
  return presence(getAtPath(draft, field), FIELD_PRESENCE_RULES[field]);
}

function presence(value: unknown, rule?: PresenceRule): ContentPresence {
  if (typeof value === "string") {
    if (!value.trim()) return "empty";
    return !rule || rule(value) ? "present" : "invalid";
  }
  if (typeof value === "number") return Number.isFinite(value) && value !== 0 ? "present" : "empty";
  if (typeof value === "boolean") return value ? "present" : "empty";
  if (Array.isArray(value)) return value.length ? "present" : "empty";
  return value == null ? "empty" : "present";
}

function intentIdentity(intent: DraftMutationIntent): string {
  switch (intent.type) {
    case "set-field": return `${intent.type}:${intent.field}`;
    case "set-service-field": return `${intent.type}:${intent.serviceClientId}:${intent.field}`;
    case "set-testimonial-field": return `${intent.type}:${intent.testimonialClientId}:${intent.field}`;
    case "set-staff-field": return `${intent.type}:${intent.staffClientId}:${intent.field}`;
    case "set-staff-services":
    case "set-staff-hours": return `${intent.type}:${intent.staffClientId}`;
    case "insert-collection-item":
    case "remove-collection-item":
    case "move-collection-item": return `${intent.type}:${intent.collection}:${intent.clientId}`;
    case "replace-draft": return `${intent.type}:${intent.reason}`;
    default: return intent.type;
  }
}
