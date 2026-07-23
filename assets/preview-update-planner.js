import { getAtPath } from "./domain.js";
import { PREVIEW_REGIONS } from "./preview-contract.js";
import { renderPreviewRegions } from "./preview-renderer.js";
/**
 * Fields that appear exactly once in the rendered page as plain text. Only those can be patched as
 * text; everything else goes through a region replacement, because a text patch that misses a second
 * occurrence would leave the preview showing two different truths.
 */
const TEXT_FIELDS = {
    "copy.heroLabel": "hero",
    "copy.heroTitle": "hero",
    "copy.heroSubtitle": "hero",
    "copy.servicesTitle": "services",
    "copy.servicesSubtitle": "services",
    "copy.bookingTitle": "booking",
    "copy.bookingSubtitle": "booking",
};
/** Fields with more than one occurrence, or one that changes structure. Region replacement only. */
const REGION_FIELDS = {
    // The intro strip falls back to the salon name when there is no tagline, so the name reaches it too.
    "salon.name": ["header", "intro", "details", "footer"],
    "salon.tagline": ["intro", "footer"],
    "salon.phone": ["hero", "details"],
    "salon.email": ["details"],
    "salon.address": ["intro", "details"],
    "salon.postalCode": ["intro", "details"],
    "salon.city": ["intro", "details"],
    "salon.instagram": ["details"],
    "testimonials.enabled": ["voices"],
};
/**
 * The team block prints the names of the services a person may perform, so a service edit reaches it.
 * A service edit can never make the team block appear or disappear, which is why this one is allowed
 * to be gated on the current draft — the regions that *can* flip are always requested unconditionally
 * and the missing-region path below turns that into a full rebuild.
 */
function hasTeamRegion(draft) {
    return draft.staff.some((person) => person.active && person.name.trim());
}
export function planPreviewUpdate(mutations, draft, renderOptions) {
    const revision = mutations.reduce((latest, mutation) => Math.max(latest, mutation.revision), renderOptions.revision);
    const regions = new Set();
    const texts = new Map();
    let patchTheme = false;
    for (const mutation of mutations) {
        const effect = mutation.effect;
        switch (effect.type) {
            case "draft-replace": return { kind: "full", revision, reason: "draft-replace" };
            case "unverified-batch": return { kind: "full", revision, reason: "unsupported" };
            case "theme-set": {
                // A preset carries fonts, background, surface and radius — that is a whole new stylesheet,
                // not two custom properties. Only a bare colour change stays patchable.
                if (effect.changed.some((key) => key !== "primary" && key !== "accent"))
                    return { kind: "full", revision, reason: "metadata" };
                patchTheme = true;
                break;
            }
            case "field-set": {
                // The two colour inputs are bound fields, so they arrive as field-set and not as theme-set
                // (only a preset produces that). Both end in the same two custom properties.
                if (effect.field === "theme.primary" || effect.field === "theme.accent") {
                    patchTheme = true;
                    break;
                }
                const regional = REGION_FIELDS[effect.field];
                if (regional) {
                    regional.forEach((region) => regions.add(region));
                    break;
                }
                const textRegion = TEXT_FIELDS[effect.field];
                if (!textRegion)
                    return { kind: "full", revision, reason: "unsupported" };
                // Going from or to empty can add or drop the surrounding markup, so only a present-to-present
                // edit is a pure text change.
                if (effect.previousPresence === "present" && effect.nextPresence === "present") {
                    addText(texts, { kind: "field", field: effect.field }, String(getAtPath(draft, effect.field) ?? ""));
                }
                else {
                    regions.add(textRegion);
                }
                break;
            }
            case "service-field-set":
            case "collection-insert":
            case "collection-remove":
            case "collection-move": {
                const collection = effect.type === "service-field-set" ? "services" : effect.collection;
                if (collection === "services") {
                    regions.add("services");
                    if (hasTeamRegion(draft))
                        regions.add("team");
                }
                else if (collection === "staff")
                    regions.add("team");
                else
                    regions.add("voices");
                break;
            }
            case "testimonial-field-set":
                regions.add("voices");
                break;
            case "staff-field-set":
            case "staff-services-set":
                regions.add("team");
                break;
            case "business-hours-set":
                regions.add("details");
                break;
            // Personal working hours are a booking truth, not a website one — nothing on the page shows them.
            case "staff-hours-set": break;
        }
    }
    // A region replacement already carries the new text, so a text patch inside it would be a duplicate
    // write to a node that no longer exists.
    for (const [key, operation] of texts) {
        const region = regionForTarget(operation.target);
        if (region && regions.has(region))
            texts.delete(key);
    }
    const operations = [];
    const ordered = PREVIEW_REGIONS.filter((region) => regions.has(region));
    if (ordered.length) {
        let rendered;
        try {
            rendered = renderPreviewRegions(ordered, draft, { ...renderOptions, revision });
        }
        catch {
            // The region is gone from the new render: the section disappeared. Only a rebuild can express
            // that, so stop planning and let the caller render everything.
            return { kind: "full", revision, reason: "layout" };
        }
        for (const region of ordered) {
            const html = rendered.get(region);
            if (!html)
                return { kind: "full", revision, reason: "unsupported" };
            operations.push({ type: "replace-region", region, html });
        }
    }
    if (patchTheme)
        operations.push({ type: "patch-theme", primary: draft.theme.primary, accent: draft.theme.accent });
    operations.push(...[...texts.values()].sort((left, right) => targetKey(left.target).localeCompare(targetKey(right.target))));
    return operations.length ? { kind: "patch", revision, operations } : { kind: "noop", revision };
}
function addText(targets, target, value) {
    targets.set(targetKey(target), { type: "patch-text", target, value });
}
function targetKey(target) { return JSON.stringify(target); }
function regionForTarget(target) {
    if (target.kind === "service")
        return "services";
    if (target.kind === "testimonial")
        return "voices";
    if (target.kind === "staff")
        return "team";
    if (target.kind === "field")
        return TEXT_FIELDS[target.field] ?? REGION_FIELDS[target.field]?.[0] ?? null;
    return null;
}
