// The wire contract of the SaaS publish-intent endpoint, as one place the builder can be held to.
//
// Three things about that endpoint decide the shape of everything here:
//
//   1. Success is CONSTANT: `{ ok: true }`. It is the anti-enumeration answer from stage G2 and is
//      returned whether or not the address already has an account. It carries no intent id, no
//      account state and no delivery confirmation. Nothing in the builder may read more into it.
//   2. The 256 KB limit is enforced on the RAW body, before parsing. So the builder has to measure
//      the encoded bytes it is about to send, not the length of the draft object.
//   3. There is no CORS. The production builder is served from the same origin as the SaaS
//      (`/website-erstellen`, plan §3.2), so the call goes to a RELATIVE path. The base is
//      configurable for local development only — it is never a way around a missing CORS header.
/** Relative on purpose: same-origin delivery is the plan, not a cross-origin call. */
export const PUBLISH_INTENT_PATH = "/api/builder/publish-intents";
/** Hard byte limit the server applies to the raw request body before it parses anything. */
export const MAX_PUBLISH_PAYLOAD_BYTES = 256 * 1024;
/** How long the builder waits before it calls a silent request a timeout. */
export const PUBLISH_TIMEOUT_MS = 20_000;
export function publishFailure(code, status = null, detail = null, retryAfterMs = null) {
    return { ok: false, code, status, detail, retryAfterMs };
}
/**
 * A wording that means "I could not even read your body". Only ever a HINT on top of the default
 * below — a client may not decide the difference between two failure classes by grepping German
 * prose it does not own, so this list may be wrong without the mapping becoming wrong.
 */
const MALFORMED_HINT = /(?:ungültige anfrage|malformed|invalid json|kein gültiges json|nicht lesbar|could not parse)/i;
/**
 * Map one HTTP answer onto an outcome.
 *
 * The two 400s stay apart, but the default now points the right way. This client builds every body
 * with `JSON.stringify`, so it cannot realistically send something the server fails to PARSE — a 400
 * it did not explain is therefore a rejected CONTENT, which is the case the user can actually do
 * something about. The old default sent every unexplained 400 to "we sent garbage, reload the page",
 * which points at nothing and hides the field that has to be fixed.
 */
export function outcomeForResponse(status, payload, retryAfterMs = null) {
    if (status === 200 || status === 201 || status === 202) {
        return isNeutralSuccess(payload) ? { ok: true } : publishFailure("UNEXPECTED_RESPONSE", status, describePayload(payload));
    }
    if (status === 413)
        return publishFailure("PAYLOAD_TOO_LARGE", status, errorText(payload));
    if (status === 429)
        return publishFailure("RATE_LIMITED", status, errorText(payload), retryAfterMs);
    if (status === 400) {
        const message = errorText(payload) ?? "";
        if (MALFORMED_HINT.test(message))
            return publishFailure("MALFORMED_REQUEST", status, message || null);
        return publishFailure("SCHEMA_REJECTED", status, message || null);
    }
    if (status >= 500)
        return publishFailure("SERVER_ERROR", status, errorText(payload));
    return publishFailure("UNEXPECTED_RESPONSE", status, errorText(payload));
}
/**
 * Read `Retry-After` the two ways RFC 9110 allows: a number of seconds, or an HTTP date.
 *
 * Anything else is no answer at all and comes back as null, because an invented wait is worse than
 * an admitted "the server did not say" — the surface builds a concrete promise out of this number.
 */
export function parseRetryAfter(raw, nowMs) {
    if (typeof raw !== "string")
        return null;
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1000 : null;
    }
    const at = Date.parse(trimmed);
    if (Number.isNaN(at))
        return null;
    const wait = at - nowMs;
    return wait > 0 ? Math.min(wait, MAX_RETRY_AFTER_SECONDS * 1000) : null;
}
/** A day. Past this the value says more about a broken proxy than about a rate limit. */
const MAX_RETRY_AFTER_SECONDS = 86_400;
/** `{ ok: true }` and nothing else. An answer that merely looks friendly is not a success. */
function isNeutralSuccess(payload) {
    return typeof payload === "object" && payload !== null && payload.ok === true;
}
function errorText(payload) {
    if (typeof payload !== "object" || payload === null)
        return null;
    const error = payload.error;
    return typeof error === "string" && error.trim() ? error.trim() : null;
}
function describePayload(payload) {
    if (payload === null || payload === undefined)
        return null;
    try {
        return JSON.stringify(payload).slice(0, 200);
    }
    catch {
        return null;
    }
}
/** The exact bytes the server will count. UTF-8, because that is what fetch sends. */
export function payloadByteLength(body) {
    if (typeof TextEncoder === "function")
        return new TextEncoder().encode(body).length;
    // No TextEncoder: count UTF-8 units by hand rather than mistaking the string length for bytes,
    // which would under-report every umlaut in a Swiss salon name.
    let bytes = 0;
    for (const character of body) {
        const code = character.codePointAt(0) ?? 0;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}
