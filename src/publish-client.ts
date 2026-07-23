import {
  MAX_PUBLISH_PAYLOAD_BYTES,
  PUBLISH_INTENT_PATH,
  PUBLISH_TIMEOUT_MS,
  outcomeForResponse,
  parseRetryAfter,
  payloadByteLength,
  publishFailure,
  type PublishOutcome,
} from "./publish-contract.js";

// The one place the builder talks to the SaaS.
//
// Everything that can go wrong on the way is turned into an outcome here, so no caller ever has to
// read a Response, and no caller ever sees an exception for an ordinary offline moment. The base URL
// stays empty by default: the request goes to the relative path, which is what same-origin delivery
// (§3.2) needs and what keeps this from silently becoming a cross-origin call.

export type PublishTransport = (input: string, init: PublishRequestInit) => Promise<PublishResponse>;

/** The slice of fetch this module uses. Narrow on purpose: a test stub has to fake very little. */
export type PublishRequestInit = {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  credentials?: "same-origin";
};

/**
 * `headers` is optional because not every transport has them, but without it a 429 can never say
 * how long to wait — and a surface that cannot name the wait may not pretend to know it.
 */
export type PublishResponse = { status: number; text(): Promise<string>; headers?: { get(name: string): string | null } };

export type PublishClientOptions = {
  /** Prefix for the endpoint. Empty (the default) keeps the call relative. */
  baseUrl?: string;
  transport?: PublishTransport;
  timeoutMs?: number;
};

export type PublishRequest = { email: string; body: string };

export function publishEndpoint(baseUrl = ""): string {
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
export async function sendPublishIntent(request: PublishRequest, options: PublishClientOptions = {}): Promise<PublishOutcome> {
  const transport = options.transport ?? defaultTransport();
  if (!transport) return publishFailure("NETWORK", null, "FETCH_UNAVAILABLE");
  const bytes = payloadByteLength(request.body);
  // The server refuses this before it parses; refusing it here as well saves a pointless upload and
  // — more importantly — produces the same actionable code either way.
  if (bytes > MAX_PUBLISH_PAYLOAD_BYTES) return publishFailure("PAYLOAD_TOO_LARGE", null, `${bytes}`);

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
  } catch (error) {
    if (timedOut) return publishFailure("TIMEOUT", null, `${timeoutMs}`);
    // An aborted request that did not time out was cancelled by us; anything else is the network.
    if (isAbortError(error)) return publishFailure("TIMEOUT", null, null);
    return publishFailure("NETWORK", null, error instanceof Error ? error.message : null);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A body that is not JSON is not an error of its own: the status already says what happened, and a
 * proxy returning an HTML error page must not turn a clean 429 into an unexplained crash.
 */
async function readJson(response: PublishResponse): Promise<unknown> {
  let raw: string;
  try { raw = await response.text(); } catch { return null; }
  if (!raw.trim()) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

/** A missing or unreadable header is no wait. It must not turn into a made-up one. */
function readRetryAfter(response: PublishResponse): number | null {
  let raw: string | null = null;
  try { raw = response.headers?.get("retry-after") ?? null; } catch { return null; }
  return parseRetryAfter(raw, Date.now());
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function defaultTransport(): PublishTransport | null {
  if (typeof fetch !== "function") return null;
  return (input, init) => fetch(input, init as RequestInit) as unknown as Promise<PublishResponse>;
}
