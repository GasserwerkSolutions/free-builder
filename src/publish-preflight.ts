import type { BuilderDraftV2 } from "./domain.js";
import { normalizeEmail } from "./domain.js";
import { evaluateReadiness, type ReadinessResult } from "./readiness.js";
import { MAX_PUBLISH_PAYLOAD_BYTES, payloadByteLength, type PublishIntentBody } from "./publish-contract.js";
import type { PublishRequest } from "./publish-client.js";

// The check that runs before anything leaves the browser.
//
// It is bound to a stamp — the store's revision AND its generation — and the publish run is abandoned
// the moment that stamp moves. Revision alone would not be enough: an authoritative replacement
// (reset, import, recovery) can put a completely different draft in place while leaving the revision
// where it was, and a publish that carried on would upload a draft the user no longer has.
//
// On top of that it answers two questions the endpoint would otherwise answer with a bare 413 or a
// bare "Ungültige Eingabe":
//
//   * Is the encoded body within the 256 KB the server counts before it parses?
//   * Does every value in the draft actually survive JSON? The contract carries `assets[]` as
//     REFERENCES; a blob or a typed array that found its way in would be silently emptied by
//     JSON.stringify, and the user would never learn what went missing.

export type PublishStamp = { revision: number; generation: number };

/** Anything with these two counters can be stamped; BuilderStore satisfies it structurally. */
export type PublishStampSource = { readonly revision: number; readonly generation: number };

export type PublishBlockCode =
  | "EMAIL_MISSING"
  | "EMAIL_INVALID"
  | "READINESS_BLOCKED"
  | "PAYLOAD_TOO_LARGE"
  | "BINARY_IN_DRAFT";

export type PublishBlock =
  | { code: "EMAIL_MISSING" }
  | { code: "EMAIL_INVALID" }
  | { code: "READINESS_BLOCKED"; count: number; first: ReadinessResult }
  | { code: "PAYLOAD_TOO_LARGE"; bytes: number; limit: number }
  | { code: "BINARY_IN_DRAFT"; paths: readonly string[] };

export type PublishPreflightResult =
  | { ok: true; request: PublishRequest; bytes: number; stamp: PublishStamp }
  | { ok: false; blocks: readonly PublishBlock[] };

export type PublishPreflightInput = {
  draft: Readonly<BuilderDraftV2>;
  email: string;
  stamp: PublishStamp;
};

export function stampOf(source: PublishStampSource): PublishStamp {
  return { revision: source.revision, generation: source.generation };
}

export function sameStamp(left: PublishStamp, right: PublishStamp): boolean {
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
export function runPublishPreflight(input: PublishPreflightInput): PublishPreflightResult {
  const blocks: PublishBlock[] = [];
  const trimmed = input.email.trim();
  if (!trimmed) blocks.push({ code: "EMAIL_MISSING" });
  else if (!normalizeEmail(trimmed)) blocks.push({ code: "EMAIL_INVALID" });

  const summary = evaluateReadiness(input.draft);
  const firstBlocker = summary.results.find((entry) => entry.severity === "error");
  if (firstBlocker) blocks.push({ code: "READINESS_BLOCKED", count: summary.errorCount, first: firstBlocker });

  const paths = findBinaryValues(input.draft);
  if (paths.length) blocks.push({ code: "BINARY_IN_DRAFT", paths });

  // The body is serialised exactly once. The very string that is measured here is the string that is
  // sent, so the 256 KB check cannot disagree with what the server counts.
  const body = serialiseIntent({ email: trimmed, draft: input.draft });
  const bytes = payloadByteLength(body);
  if (bytes > MAX_PUBLISH_PAYLOAD_BYTES) blocks.push({ code: "PAYLOAD_TOO_LARGE", bytes, limit: MAX_PUBLISH_PAYLOAD_BYTES });

  if (blocks.length) return { ok: false, blocks };
  return { ok: true, request: { email: trimmed, body }, bytes, stamp: input.stamp };
}

function serialiseIntent(body: PublishIntentBody): string {
  return JSON.stringify(body);
}

/**
 * Every place in the draft holding a value the wire cannot carry.
 *
 * The walk is structural rather than a list of known fields on purpose: the point is to catch what
 * nobody thought of, including the local-asset upload that phases F4/G3 will add. Today the draft has
 * no local assets at all, so this finds nothing — it is the guard that keeps it that way until the
 * authenticated upload exists to carry those bytes properly.
 *
 * Strings are explicitly NOT inspected any more. The earlier version flagged any text starting with
 * `data:` or `blob:`, which was a false positive on ordinary prose — "data: unser neues Konzept" in a
 * subtitle blocked the publish for good, with a message that named a technical path and offered no
 * way out. And it never caught what it was written for: normalizeDraftV2 drops foreign fields long
 * before this runs, so no real draft ever carried an inline image. What a `data:` string actually
 * risks is size, and size has its own honest, actionable answer in PAYLOAD_TOO_LARGE.
 */
export function findBinaryValues(draft: Readonly<BuilderDraftV2>): readonly string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): void => {
    if (found.length >= 8) return;
    if (value === null || value === undefined) return;
    const type = typeof value;
    // A string always arrives on the other side exactly as it is. Whatever it looks like.
    if (type === "string" || type === "number" || type === "boolean") return;
    if (type !== "object") { found.push(path); return; }
    if (seen.has(value)) return;
    seen.add(value);
    if (isBinaryObject(value)) { found.push(path); return; }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, path ? `${path}.${key}` : key);
  };
  walk(draft, "");
  return found;
}

function isBinaryObject(value: unknown): boolean {
  if (typeof Blob === "function" && value instanceof Blob) return true;
  if (typeof ArrayBuffer === "function" && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return true;
  return false;
}

export const PUBLISH_BLOCK_CODES: readonly PublishBlockCode[] = [
  "EMAIL_MISSING", "EMAIL_INVALID", "READINESS_BLOCKED", "PAYLOAD_TOO_LARGE", "BINARY_IN_DRAFT",
];
