import type { BuilderDraftV2 } from "./domain.js";

// Which draft was handed over — an answer that has to survive a reload.
//
// The obvious candidate, the store's revision, cannot survive one: that counter starts at 0 in every
// session and is never restored, so it names a POSITION IN THIS SESSION and not a draft. Comparing a
// remembered absolute revision against it makes the surface claim "your later edits are not over
// there yet" for a draft nobody touched, and then claim the opposite after exactly one edit.
//
// The only thing that outlives a restart is the content itself, so that is what is remembered:
//
//   * `draftId` — WHICH draft the note belongs to. A reset or an import puts a different draft in
//     place, and a hand-over of the old one says nothing about the new one.
//   * `length` + `fingerprint` — WHAT that draft contained, over the exact serialisation. Two
//     independent numbers, so a change that happens to leave the length alone still moves the
//     fingerprint.
//
// A fingerprint may not promise more than a fingerprint can hold, and that limit is written down
// rather than implied: an UNEQUAL fingerprint proves the draft changed; an EQUAL one means equal
// content up to a 128-bit collision. The exact alternative — keeping the whole serialised draft, up
// to 256 KB, in localStorage beside the copy IndexedDB already holds — would spend the quota that
// carries every other remembered preference on an exactness nobody can measure.

export type DraftIdentity = {
  draftId: string;
  /** Length of the serialised draft in UTF-16 units. A cheap, independent second opinion. */
  length: number;
  /** 128 bits over the serialised draft, as 32 lowercase hex characters. */
  fingerprint: string;
};

/** Distinct starting values, so the four lanes cannot walk in step. */
const LANE_SEEDS: readonly number[] = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
/** Distinct odd multipliers, so equal input mixes differently in each lane. */
const LANE_PRIMES: readonly number[] = [0x01000193, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f];

export function draftIdentity(draft: Readonly<BuilderDraftV2>): DraftIdentity {
  // The store only ever holds a normalized draft, and normalization builds its object literal in one
  // fixed key order. So the same content really does serialise to the same string across sessions —
  // without that, a fingerprint would compare formatting instead of content.
  const serialised = JSON.stringify(draft);
  return { draftId: draft.draftId, length: serialised.length, fingerprint: fingerprintOf(serialised) };
}

export function sameDraftIdentity(left: DraftIdentity, right: DraftIdentity): boolean {
  return left.draftId === right.draftId && left.length === right.length && left.fingerprint === right.fingerprint;
}

/**
 * Read back a remembered identity. Anything that is not a complete, well-shaped note is no note —
 * a half-parsed one would be worse than none, because the surface would build a claim on it.
 */
export function readDraftIdentity(value: unknown): DraftIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const { draftId, length, fingerprint } = value as { draftId?: unknown; length?: unknown; fingerprint?: unknown };
  if (typeof draftId !== "string" || !draftId) return null;
  if (typeof length !== "number" || !Number.isFinite(length) || length < 0) return null;
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{32}$/.test(fingerprint)) return null;
  return { draftId, length, fingerprint };
}

/** Four chained FNV-1a lanes over the UTF-16 units, concatenated to 128 bits. */
function fingerprintOf(value: string): string {
  const lanes = LANE_SEEDS.map((seed) => seed);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    for (let lane = 0; lane < lanes.length; lane += 1) {
      lanes[lane] = Math.imul((lanes[lane] ?? 0) ^ unit, LANE_PRIMES[lane] ?? 1);
    }
  }
  return lanes.map((lane) => (lane >>> 0).toString(16).padStart(8, "0")).join("");
}
