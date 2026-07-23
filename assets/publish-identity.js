/** Distinct starting values, so the four lanes cannot walk in step. */
const LANE_SEEDS = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
/** Distinct odd multipliers, so equal input mixes differently in each lane. */
const LANE_PRIMES = [0x01000193, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f];
export function draftIdentity(draft) {
    // The store only ever holds a normalized draft, and normalization builds its object literal in one
    // fixed key order. So the same content really does serialise to the same string across sessions —
    // without that, a fingerprint would compare formatting instead of content.
    const serialised = JSON.stringify(draft);
    return { draftId: draft.draftId, length: serialised.length, fingerprint: fingerprintOf(serialised) };
}
export function sameDraftIdentity(left, right) {
    return left.draftId === right.draftId && left.length === right.length && left.fingerprint === right.fingerprint;
}
/**
 * Read back a remembered identity. Anything that is not a complete, well-shaped note is no note —
 * a half-parsed one would be worse than none, because the surface would build a claim on it.
 */
export function readDraftIdentity(value) {
    if (typeof value !== "object" || value === null)
        return null;
    const { draftId, length, fingerprint } = value;
    if (typeof draftId !== "string" || !draftId)
        return null;
    if (typeof length !== "number" || !Number.isFinite(length) || length < 0)
        return null;
    if (typeof fingerprint !== "string" || !/^[0-9a-f]{32}$/.test(fingerprint))
        return null;
    return { draftId, length, fingerprint };
}
/** Four chained FNV-1a lanes over the UTF-16 units, concatenated to 128 bits. */
function fingerprintOf(value) {
    const lanes = LANE_SEEDS.map((seed) => seed);
    for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        for (let lane = 0; lane < lanes.length; lane += 1) {
            lanes[lane] = Math.imul((lanes[lane] ?? 0) ^ unit, LANE_PRIMES[lane] ?? 1);
        }
    }
    return lanes.map((lane) => (lane >>> 0).toString(16).padStart(8, "0")).join("");
}
