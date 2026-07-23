import { normalizeEmail } from "./domain.js";
import { evaluateReadiness } from "./readiness.js";
import { MAX_PUBLISH_PAYLOAD_BYTES, payloadByteLength } from "./publish-contract.js";
export function stampOf(source) {
    return { revision: source.revision, generation: source.generation };
}
export function sameStamp(left, right) {
    return left.revision === right.revision && left.generation === right.generation;
}
/**
 * Build the body and prove it may be sent.
 *
 * Local readiness blockers stop the attempt here. That is not the builder authorising anything — the
 * server stays the only authority on whether an activation may proceed (plan §12.2). It is the
 * builder refusing to spend a rate-limited attempt on a draft it already knows is incomplete, and
 * pointing at the entry that has to be fixed instead.
 */
export function runPublishPreflight(input) {
    const blocks = [];
    const trimmed = input.email.trim();
    if (!trimmed)
        blocks.push({ code: "EMAIL_MISSING" });
    else if (!normalizeEmail(trimmed))
        blocks.push({ code: "EMAIL_INVALID" });
    const summary = evaluateReadiness(input.draft);
    const firstBlocker = summary.results.find((entry) => entry.severity === "error");
    if (firstBlocker)
        blocks.push({ code: "READINESS_BLOCKED", count: summary.errorCount, first: firstBlocker });
    const paths = findBinaryValues(input.draft);
    if (paths.length)
        blocks.push({ code: "BINARY_IN_DRAFT", paths });
    // The body is serialised exactly once. The very string that is measured here is the string that is
    // sent, so the 256 KB check cannot disagree with what the server counts.
    const body = serialiseIntent({ email: trimmed, draft: input.draft });
    const bytes = payloadByteLength(body);
    if (bytes > MAX_PUBLISH_PAYLOAD_BYTES)
        blocks.push({ code: "PAYLOAD_TOO_LARGE", bytes, limit: MAX_PUBLISH_PAYLOAD_BYTES });
    if (blocks.length)
        return { ok: false, blocks };
    return { ok: true, request: { email: trimmed, body }, bytes, stamp: input.stamp };
}
function serialiseIntent(body) {
    return JSON.stringify(body);
}
/**
 * Every place in the draft that holds something other than text, a number or a boolean.
 *
 * The walk is structural rather than a list of known fields on purpose: the point is to catch what
 * nobody thought of, including the local-asset upload that phases F4/G3 will add. Today the draft has
 * no local assets at all, so this finds nothing — it is the guard that keeps it that way until the
 * authenticated upload exists to carry those bytes properly.
 */
export function findBinaryValues(draft) {
    const found = [];
    const seen = new Set();
    const walk = (value, path) => {
        if (found.length >= 8)
            return;
        if (value === null || value === undefined)
            return;
        const type = typeof value;
        if (type === "string") {
            if (/^\s*(?:data|blob):/i.test(value))
                found.push(path);
            return;
        }
        if (type === "number" || type === "boolean")
            return;
        if (type !== "object") {
            found.push(path);
            return;
        }
        if (seen.has(value))
            return;
        seen.add(value);
        if (isBinaryObject(value)) {
            found.push(path);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item, index) => walk(item, `${path}[${index}]`));
            return;
        }
        for (const [key, item] of Object.entries(value))
            walk(item, path ? `${path}.${key}` : key);
    };
    walk(draft, "");
    return found;
}
function isBinaryObject(value) {
    if (typeof Blob === "function" && value instanceof Blob)
        return true;
    if (typeof ArrayBuffer === "function" && (value instanceof ArrayBuffer || ArrayBuffer.isView(value)))
        return true;
    return false;
}
export const PUBLISH_BLOCK_CODES = [
    "EMAIL_MISSING", "EMAIL_INVALID", "READINESS_BLOCKED", "PAYLOAD_TOO_LARGE", "BINARY_IN_DRAFT",
];
