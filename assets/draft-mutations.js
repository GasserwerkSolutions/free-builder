import { cloneDraft, getAtPath, setAtPath } from "./domain-helpers.js";
// The single place that knows where each editable collection lives and what a structural change to
// it may cascade into. Everything else in this module stays collection-agnostic.
const COLLECTIONS = {
    services: {
        read: (draft) => draft.services,
        write: (draft, items) => { draft.services = structuredClone(items); },
        // Dropping a service must also drop it from every assignment; serviceClientIds stays the single
        // truth about who may perform what, so only that list may follow — nothing else on a person.
        cascade: (expected, after) => {
            expected.staff.forEach((person) => {
                const next = after.staff.find((item) => item.clientId === person.clientId);
                if (next)
                    person.serviceClientIds = [...next.serviceClientIds];
            });
        },
    },
    staff: {
        read: (draft) => draft.staff,
        write: (draft, items) => { draft.staff = structuredClone(items); },
        // Removing a person removes the assets they own. Only removals are allowed to follow.
        cascade: (expected, after) => {
            const kept = new Set(after.assets.map((asset) => asset.localId));
            expected.assets = expected.assets.filter((asset) => kept.has(asset.localId));
        },
    },
    testimonials: {
        read: (draft) => draft.testimonials.items,
        write: (draft, items) => { draft.testimonials.items = structuredClone(items); },
        // The section toggle follows the item count (first entry enables it, last removal disables it).
        cascade: (expected, after) => { expected.testimonials.enabled = after.testimonials.enabled; },
    },
};
export function draftsEqualIgnoringUpdatedAt(left, right) {
    return JSON.stringify(comparableDraft(left)) === JSON.stringify(comparableDraft(right));
}
export function createDraftEffect(before, after, intent) {
    if (draftsEqualIgnoringUpdatedAt(before, after))
        throw new Error("MUTATION_EFFECT_FOR_NOOP");
    switch (intent.type) {
        case "set-field": {
            const change = pathChange(before, after, intent.field, "INVALID_FIELD_SET", "UNEXPECTED_FIELD_CHANGE");
            return { type: "field-set", field: intent.field, previousPresence: presence(change.previous), nextPresence: presence(change.next) };
        }
        case "set-service-field": {
            // Renaming a service re-derives its slug, so the slug is part of the declared change.
            const fields = intent.field === "name" ? ["name", "slug"] : [intent.field];
            const change = itemFieldChange(before, after, "services", intent.serviceClientId, fields, intent.field, "INVALID_SERVICE_FIELD_SET", "UNEXPECTED_SERVICE_FIELD_CHANGE");
            return { type: "service-field-set", serviceClientId: intent.serviceClientId, field: intent.field, previousPresence: presence(change.previous), nextPresence: presence(change.next) };
        }
        case "set-testimonial-field": {
            const change = itemFieldChange(before, after, "testimonials", intent.testimonialClientId, [intent.field], intent.field, "INVALID_TESTIMONIAL_FIELD_SET", "UNEXPECTED_TESTIMONIAL_FIELD_CHANGE");
            return { type: "testimonial-field-set", testimonialClientId: intent.testimonialClientId, field: intent.field, previousPresence: presence(change.previous), nextPresence: presence(change.next) };
        }
        case "set-staff-field": {
            const change = itemFieldChange(before, after, "staff", intent.staffClientId, [intent.field], intent.field, "INVALID_STAFF_FIELD_SET", "UNEXPECTED_STAFF_FIELD_CHANGE");
            return { type: "staff-field-set", staffClientId: intent.staffClientId, field: intent.field, previousPresence: presence(change.previous), nextPresence: presence(change.next) };
        }
        case "set-staff-services": {
            const change = itemFieldChange(before, after, "staff", intent.staffClientId, ["serviceClientIds"], "serviceClientIds", "INVALID_STAFF_SERVICES_SET", "UNEXPECTED_STAFF_SERVICES_CHANGE");
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
            const change = itemFieldChange(before, after, "staff", intent.staffClientId, ["workingHours"], "workingHours", "INVALID_STAFF_HOURS_SET", "UNEXPECTED_STAFF_HOURS_CHANGE");
            return { type: "staff-hours-set", staffClientId: intent.staffClientId, previousOpenDays: openDays(change.previous), nextOpenDays: openDays(change.next) };
        }
        case "insert-collection-item": return structuralEffect(before, after, intent.collection, intent.clientId, "insert");
        case "remove-collection-item": return structuralEffect(before, after, intent.collection, intent.clientId, "remove");
        case "move-collection-item": return structuralEffect(before, after, intent.collection, intent.clientId, "move");
        case "set-theme": {
            const changed = ["preset", "primary", "accent"].filter((key) => before.theme[key] !== after.theme[key]);
            if (!changed.length)
                throw new Error("INVALID_THEME_SET");
            pathChange(before, after, "theme", "INVALID_THEME_SET", "UNEXPECTED_THEME_CHANGE");
            return { type: "theme-set", changed };
        }
        case "replace-draft": return { type: "draft-replace", reason: intent.reason };
        case "batch": return { type: "unverified-batch" };
    }
}
export function invertDraftEffect(effect) {
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
export function requiresSnapshotInversion(effect) { return effect.type === "theme-set"; }
/** Two edits may only be grouped into one undo step when they aim at the same target. */
export function sameIntentTarget(left, right) {
    return intentIdentity(left) === intentIdentity(right);
}
export function sourceForReplaceReason(reason) { return reason; }
// Verify a change that is addressed by a dot path into the draft.
function pathChange(before, after, path, invalidCode, unexpectedCode) {
    const previous = getAtPath(before, path);
    const next = getAtPath(after, path);
    if (sameValue(previous, next))
        throw new Error(invalidCode);
    expectDraft(before, after, (expected) => setAtPath(expected, path, structuredClone(next)), unexpectedCode);
    return { previous, next };
}
// Verify a change to named fields of one collection item. `primaryField` is the field the intent is
// about; the remaining fields are the derived ones the same edit is allowed to touch.
function itemFieldChange(before, after, collection, clientId, fields, primaryField, invalidCode, unexpectedCode) {
    const previous = findItem(before, collection, clientId);
    const next = findItem(after, collection, clientId);
    if (!previous || !next)
        throw new Error(invalidCode);
    if (sameValue(previous[primaryField], next[primaryField]))
        throw new Error(invalidCode);
    expectDraft(before, after, (expected) => {
        const target = findItem(expected, collection, clientId);
        if (!target)
            throw new Error(invalidCode);
        fields.forEach((field) => { target[field] = structuredClone(next[field]); });
    }, unexpectedCode);
    return { previous: previous[primaryField], next: next[primaryField] };
}
// Verify an insert / remove / move inside one collection. The three cases differ only in what they
// consider a valid item movement, so the surrounding verification is shared.
function structuralEffect(before, after, collection, clientId, kind) {
    const spec = COLLECTIONS[collection];
    const previousItems = spec.read(before);
    const nextItems = spec.read(after);
    const previousIndex = previousItems.findIndex((item) => item.clientId === clientId);
    const nextIndex = nextItems.findIndex((item) => item.clientId === clientId);
    const invalidCode = `INVALID_COLLECTION_${kind.toUpperCase()}`;
    if (kind === "insert") {
        if (previousIndex >= 0 || nextIndex < 0 || nextItems.length !== previousItems.length + 1)
            throw new Error(invalidCode);
        if (!sameValue(nextItems.filter((item) => item.clientId !== clientId), previousItems))
            throw new Error(`UNEXPECTED_COLLECTION_INSERT_CHANGE`);
    }
    else if (kind === "remove") {
        if (previousIndex < 0 || nextIndex >= 0 || nextItems.length !== previousItems.length - 1)
            throw new Error(invalidCode);
        if (!sameValue(previousItems.filter((item) => item.clientId !== clientId), nextItems))
            throw new Error(`UNEXPECTED_COLLECTION_REMOVE_CHANGE`);
    }
    else {
        if (previousIndex < 0 || nextIndex < 0 || previousIndex === nextIndex || previousItems.length !== nextItems.length)
            throw new Error(invalidCode);
        const simulated = structuredClone(previousItems);
        const [moved] = simulated.splice(previousIndex, 1);
        if (!moved)
            throw new Error(invalidCode);
        simulated.splice(nextIndex, 0, moved);
        if (!sameValue(simulated, nextItems))
            throw new Error(`UNEXPECTED_COLLECTION_MOVE_CHANGE`);
    }
    expectDraft(before, after, (expected) => { spec.write(expected, nextItems); spec.cascade(expected, after); }, `UNEXPECTED_COLLECTION_${kind.toUpperCase()}_DRAFT_CHANGE`);
    if (kind === "insert")
        return { type: "collection-insert", collection, clientId, index: nextIndex };
    if (kind === "remove")
        return { type: "collection-remove", collection, clientId, previousIndex };
    return { type: "collection-move", collection, clientId, previousIndex, nextIndex };
}
// The one assertion every intent runs through: rebuild what the draft should look like when only the
// declared change happened, and demand that the real result is exactly that.
function expectDraft(before, after, build, code) {
    const expected = cloneDraft(before);
    build(expected);
    if (!draftsEqualIgnoringUpdatedAt(expected, after))
        throw new Error(code);
}
function findItem(draft, collection, clientId) {
    const item = COLLECTIONS[collection].read(draft).find((entry) => entry.clientId === clientId);
    return item;
}
function comparableDraft(draft) {
    const copy = cloneDraft(draft);
    copy.updatedAt = "";
    return copy;
}
function sameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function asStringList(value) { return Array.isArray(value) ? value : []; }
function openDays(value) {
    return Array.isArray(value) ? value.filter((day) => !day.closed).length : 0;
}
// "Does this field carry content?" — deliberately two-valued. The draft normalizer already coerces
// malformed input (invalid colours, non-http Instagram links) away, so a third "invalid" state could
// never survive normalization in this model.
function presence(value) {
    if (typeof value === "string")
        return value.trim() ? "present" : "empty";
    if (typeof value === "number")
        return Number.isFinite(value) && value !== 0 ? "present" : "empty";
    if (typeof value === "boolean")
        return value ? "present" : "empty";
    if (Array.isArray(value))
        return value.length ? "present" : "empty";
    return value == null ? "empty" : "present";
}
function intentIdentity(intent) {
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
