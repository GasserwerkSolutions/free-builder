import { MAX_PUBLISH_PAYLOAD_BYTES, PUBLISH_INTENT_PATH, PUBLISH_TIMEOUT_MS, outcomeForResponse, parseRetryAfter, payloadByteLength, publishFailure, } from "./publish-contract.js";
export function publishEndpoint(baseUrl = "") {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    return `${trimmed}${PUBLISH_INTENT_PATH}`;
}
/**
 * Send one publish intent.
 *
 * The body arrives already serialised, because the same string was measured by the preflight — a
 * second `JSON.stringify` here could produce a different length than the one that was checked
 * against the 256 KB limit, and the check would be worth nothing.
 */
export async function sendPublishIntent(request, options = {}) {
    const transport = options.transport ?? defaultTransport();
    if (!transport)
        return publishFailure("NETWORK", null, "FETCH_UNAVAILABLE");
    const bytes = payloadByteLength(request.body);
    // The server refuses this before it parses; refusing it here as well saves a pointless upload and
    // — more importantly — produces the same actionable code either way.
    if (bytes > MAX_PUBLISH_PAYLOAD_BYTES)
        return publishFailure("PAYLOAD_TOO_LARGE", null, `${bytes}`);
    const timeoutMs = options.timeoutMs ?? PUBLISH_TIMEOUT_MS;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    const timer = controller && timeoutMs > 0
        ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs)
        : null;
    try {
        const response = await transport(publishEndpoint(options.baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: request.body,
            // Same-origin in production; never send credentials anywhere else.
            credentials: "same-origin",
            ...(controller ? { signal: controller.signal } : {}),
        });
        return outcomeForResponse(response.status, await readJson(response), readRetryAfter(response));
    }
    catch (error) {
        if (timedOut)
            return publishFailure("TIMEOUT", null, `${timeoutMs}`);
        // An aborted request that did not time out was cancelled by us; anything else is the network.
        if (isAbortError(error))
            return publishFailure("TIMEOUT", null, null);
        return publishFailure("NETWORK", null, error instanceof Error ? error.message : null);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/**
 * A body that is not JSON is not an error of its own: the status already says what happened, and a
 * proxy returning an HTML error page must not turn a clean 429 into an unexplained crash.
 */
async function readJson(response) {
    let raw;
    try {
        raw = await response.text();
    }
    catch {
        return null;
    }
    if (!raw.trim())
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/** A missing or unreadable header is no wait. It must not turn into a made-up one. */
function readRetryAfter(response) {
    let raw = null;
    try {
        raw = response.headers?.get("retry-after") ?? null;
    }
    catch {
        return null;
    }
    return parseRetryAfter(raw, Date.now());
}
function isAbortError(error) {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
function defaultTransport() {
    if (typeof fetch !== "function")
        return null;
    return (input, init) => fetch(input, init);
}
