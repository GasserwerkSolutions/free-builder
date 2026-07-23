import type { BuilderDraftV2 } from "./domain.js";
import type { PublishOutcome, PublishErrorCode } from "./publish-contract.js";
import type { PublishRequest } from "./publish-client.js";
import { runPublishPreflight, sameStamp, type PublishBlock, type PublishStamp } from "./publish-preflight.js";

// The publish state machine, without a single DOM reference.
//
//   ready ──submit()──▶ checking ──▶ sending ──▶ submitted
//                          │            │
//                          ├──▶ blocked │
//                          └──▶ failed ◀┘        (both are retried by calling submit() again)
//
// Two properties matter more than the diagram:
//
//   * A second submit while one is in flight does nothing. The endpoint is rate-limited and
//     deliberately address-independent, so a double click must not burn an attempt.
//   * Nothing here ever claims more than the answer gives. `{ ok: true }` moves the flow to
//     `submitted` — "handed over" — and not to "account created" or "e-mail delivered".

/** A reason the flow stopped. `DRAFT_CHANGED` is the preflight abort; the rest come from the wire. */
export type PublishStopCode = PublishErrorCode | "DRAFT_CHANGED";

export type PublishPhase = "ready" | "checking" | "sending" | "submitted" | "blocked" | "failed";

export type PublishFlowState = {
  phase: PublishPhase;
  blocks: readonly PublishBlock[];
  stopCode: PublishStopCode | null;
  stopDetail: string | null;
  /** When a hand-over was last accepted. Null while none ever was. */
  submittedAt: string | null;
  /** The revision that was handed over. Everything after it is local-only. */
  submittedRevision: number | null;
  /**
   * The draft moved on after the hand-over, so the SaaS holds an older copy. Not an error and not a
   * failure — a fact the user has to be told, because nothing in the builder pushes it across.
   */
  staleSinceSubmit: boolean;
};

export type PublishFlowHost = {
  readDraft(): Readonly<BuilderDraftV2>;
  readStamp(): PublishStamp;
  /** Make the local draft durable before handing a copy over. Also the window a late edit lands in. */
  flush(): Promise<void>;
  send(request: PublishRequest): Promise<PublishOutcome>;
  now(): string;
};

export type PublishFlowListener = (state: PublishFlowState) => void;

export function initialPublishState(): PublishFlowState {
  return { phase: "ready", blocks: [], stopCode: null, stopDetail: null, submittedAt: null, submittedRevision: null, staleSinceSubmit: false };
}

export class PublishFlow {
  private state: PublishFlowState = initialPublishState();
  private listeners = new Set<PublishFlowListener>();
  private inFlight = false;
  private email = "";

  constructor(private readonly host: PublishFlowHost) {}

  get snapshot(): Readonly<PublishFlowState> { return this.state; }
  get busy(): boolean { return this.inFlight; }
  get address(): string { return this.email; }

  subscribe(listener: PublishFlowListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /**
   * Restore what an earlier session already handed over. Only the two facts that are true without
   * asking the server: when it happened, and which revision it was.
   */
  restoreSubmission(submittedAt: string, submittedRevision: number): void {
    if (this.inFlight) return;
    this.patch({ phase: "submitted", blocks: [], stopCode: null, stopDetail: null, submittedAt, submittedRevision, staleSinceSubmit: this.host.readStamp().revision !== submittedRevision });
  }

  setEmail(value: string): void {
    this.email = value;
    // Typing a correction is the start of a new attempt, so the previous refusal stops standing in
    // front of it. A completed hand-over is a fact and is NOT cleared by editing the address.
    if (this.state.phase === "blocked" || this.state.phase === "failed") {
      this.patch({ phase: "ready", blocks: [], stopCode: null, stopDetail: null });
    }
  }

  /** Every accepted draft change is offered here, so a hand-over can go stale while it is on screen. */
  noteDraftChanged(): void {
    if (this.state.submittedRevision === null) return;
    const stale = this.host.readStamp().revision !== this.state.submittedRevision;
    if (stale !== this.state.staleSinceSubmit) this.patch({ staleSinceSubmit: stale });
  }

  async submit(): Promise<PublishFlowState> {
    // The rate limit is address-independent by design, so a double click has to be swallowed here —
    // there is no server-side forgiveness for spending an attempt twice on the same intent.
    if (this.inFlight) return this.state;
    this.inFlight = true;
    try {
      const stamp = this.host.readStamp();
      this.patch({ phase: "checking", blocks: [], stopCode: null, stopDetail: null });
      const preflight = runPublishPreflight({ draft: this.host.readDraft(), email: this.email, stamp });
      if (!preflight.ok) return this.patch({ phase: "blocked", blocks: preflight.blocks });

      // Hand over only a draft that is durably stored locally. If the user edits during that write,
      // the stamp moves and the run is abandoned before anything is sent — the same rule the export
      // preflight applies, for the same reason: the artefact must match the state it was checked in.
      await this.host.flush();
      if (!sameStamp(this.host.readStamp(), stamp)) {
        return this.patch({ phase: "failed", stopCode: "DRAFT_CHANGED", stopDetail: null });
      }

      this.patch({ phase: "sending" });
      const outcome = await this.host.send(preflight.request);
      if (!outcome.ok) return this.patch({ phase: "failed", stopCode: outcome.code, stopDetail: outcome.detail });

      // The request went out and was accepted. If the draft moved while it was in flight, that
      // cannot be undone — so it is reported as what it is: handed over, and already superseded.
      const stale = !sameStamp(this.host.readStamp(), stamp);
      return this.patch({
        phase: "submitted",
        blocks: [],
        stopCode: null,
        stopDetail: null,
        submittedAt: this.host.now(),
        submittedRevision: stamp.revision,
        staleSinceSubmit: stale,
      });
    } catch (error) {
      // The host threw where it should have returned an outcome. Report it rather than leaving the
      // flow stuck in "sending" forever.
      return this.patch({ phase: "failed", stopCode: "NETWORK", stopDetail: error instanceof Error ? error.message : null });
    } finally {
      this.inFlight = false;
    }
  }

  private patch(changes: Partial<PublishFlowState>): PublishFlowState {
    this.state = { ...this.state, ...changes };
    this.listeners.forEach((listener) => listener(this.state));
    return this.state;
  }
}
