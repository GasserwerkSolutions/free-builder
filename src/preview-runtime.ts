import { cloneDraft, type BuilderDraftV2 } from "./domain.js";
import type { DraftMutation } from "./draft-mutations.js";
import {
  PREVIEW_CHANNEL,
  PREVIEW_PROTOCOL_VERSION,
  isPreviewMessageEnvelope,
  parseNavigateMessage,
  parseReadyMessage,
  parseScrollMessage,
  parseUpdateResult,
  resolveParentOrigin,
  type PreviewScrollState,
  type PreviewTarget,
  type PreviewUpdateRequest,
} from "./preview-contract.js";
import { planPreviewUpdate } from "./preview-update-planner.js";
import { buildWebsiteHtml } from "./website.js";

/** How long edits are gathered before one request goes out. */
const COALESCE_MS = 40;
/** How long a patch may stay unanswered before the preview is rebuilt instead. */
const PATCH_TIMEOUT_MS = 350;
/** How long a fresh document may take to report itself ready. Retried exactly once. */
const READY_TIMEOUT_MS = 2_000;

type Timer = ReturnType<typeof setTimeout>;
type InFlight = { requestId: string; revision: number; timeout: Timer };

export type PreviewRuntimeOptions = {
  frame: HTMLIFrameElement;
  readDraft: () => Readonly<BuilderDraftV2>;
  readRevision: () => number;
  onNavigate?: (target: PreviewTarget) => void;
  parentOrigin?: string;
  createId?: () => string;
};

/**
 * The editor half of the preview protocol.
 *
 * Invariants it is built around:
 *  - exactly one request may be in flight, so the preview can never apply two updates out of order;
 *  - every update names the revision it builds on, so a document that missed one refuses the patch;
 *  - anything unexpected — a rejected patch, a silent document, an unplannable change — degrades to
 *    a full render, which is always correct because it is the same renderer the export uses.
 */
export class PreviewRuntime {
  private readonly frame: HTMLIFrameElement;
  private readonly readDraft: () => Readonly<BuilderDraftV2>;
  private readonly readRevision: () => number;
  private readonly onNavigate: ((target: PreviewTarget) => void) | null;
  private readonly parentOrigin: string;
  private readonly createId: () => string;
  private instanceIdValue = "";
  private renderGenerationValue = 0;
  private appliedRevisionValue = 0;
  private processedRevisionValue = 0;
  private desiredRevisionValue = 0;
  private fullRenderRevision = 0;
  private scroll: PreviewScrollState | null = null;
  private ready = false;
  private pending: DraftMutation[] = [];
  private inFlight: InFlight | null = null;
  private coalesceTimer: Timer | null = null;
  private readyTimer: Timer | null = null;
  private destroyed = false;

  constructor(options: PreviewRuntimeOptions) {
    this.frame = options.frame;
    this.readDraft = options.readDraft;
    this.readRevision = options.readRevision;
    this.onNavigate = options.onNavigate ?? null;
    this.parentOrigin = options.parentOrigin ?? resolveParentOrigin(typeof location === "undefined" ? undefined : location.origin);
    this.createId = options.createId ?? defaultId;
    this.desiredRevisionValue = this.readRevision();
  }

  get instanceId(): string { return this.instanceIdValue; }
  get renderGeneration(): number { return this.renderGenerationValue; }
  get appliedRevision(): number { return this.appliedRevisionValue; }
  get desiredRevision(): number { return this.desiredRevisionValue; }
  get hasInFlightRequest(): boolean { return this.inFlight !== null; }
  get scrollState(): PreviewScrollState | null { return this.scroll; }

  start(): void { this.startFullRender(1); }
  /** Rebuild from scratch. Used after an authoritative replacement of the draft. */
  renderFull(): void { this.startFullRender(1); }

  enqueue(mutation: DraftMutation): void {
    if (this.destroyed) return;
    this.desiredRevisionValue = Math.max(this.desiredRevisionValue, mutation.revision);
    this.pending.push(mutation);
    if (this.ready) this.scheduleFlush(COALESCE_MS);
  }

  /** Returns true when the message belonged to this preview, whether or not it changed anything. */
  handleMessage(event: MessageEvent): boolean {
    // The preview is a sandboxed srcdoc document: its origin is opaque, which is exactly "null".
    // Anything with a real origin is not our preview, no matter how well-formed it looks.
    if (this.destroyed || event.source !== this.frame.contentWindow || event.origin !== "null") return false;
    if (!isPreviewMessageEnvelope(event.data, this.instanceIdValue, this.renderGenerationValue)) return false;

    const ready = parseReadyMessage(event.data, this.instanceIdValue, this.renderGenerationValue);
    if (ready) return this.acceptReady(ready.revision);

    const navigate = parseNavigateMessage(event.data, this.instanceIdValue, this.renderGenerationValue);
    if (navigate) { this.onNavigate?.(navigate.target); return true; }

    const scroll = parseScrollMessage(event.data, this.instanceIdValue, this.renderGenerationValue);
    if (scroll) { this.scroll = scroll.position; return true; }

    const result = parseUpdateResult(event.data, this.instanceIdValue, this.renderGenerationValue);
    if (!result) return false;
    return this.acceptUpdateResult(result.requestId, result.revision, result.success);
  }

  destroy(): void {
    this.destroyed = true;
    this.invalidateInFlight();
    this.clearReadyTimer();
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
  }

  private acceptReady(revision: number): boolean {
    // A late "ready" from the document we already patched past would rewind the preview.
    if (this.ready || revision !== this.fullRenderRevision || revision < this.appliedRevisionValue) return true;
    this.clearReadyTimer();
    this.ready = true;
    this.appliedRevisionValue = revision;
    this.processedRevisionValue = revision;
    this.pending = this.pending.filter((mutation) => mutation.revision > revision);
    if (this.desiredRevisionValue > this.processedRevisionValue) this.scheduleFlush(0);
    return true;
  }

  private acceptUpdateResult(requestId: string, revision: number, success: boolean): boolean {
    const active = this.inFlight;
    if (!active || requestId !== active.requestId) return true;
    clearTimeout(active.timeout);
    this.inFlight = null;
    if (!success || revision !== active.revision) { this.startFullRender(1); return true; }
    this.appliedRevisionValue = revision;
    this.processedRevisionValue = revision;
    if (this.desiredRevisionValue > this.processedRevisionValue || this.pending.length) this.scheduleFlush(0);
    return true;
  }

  private scheduleFlush(delay: number): void {
    if (this.destroyed || !this.ready || this.inFlight || this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => { this.coalesceTimer = null; this.flushPending(); }, delay);
  }

  private flushPending(): void {
    if (this.destroyed || !this.ready || this.inFlight) return;
    const mutations = this.pending.filter((mutation) => mutation.revision > this.processedRevisionValue);
    if (!mutations.length) {
      if (this.desiredRevisionValue > this.processedRevisionValue) this.startFullRender(1);
      return;
    }
    const revision = mutations.reduce((latest, mutation) => Math.max(latest, mutation.revision), 0);
    let plan;
    try {
      plan = planPreviewUpdate(mutations, this.readDraft(), this.renderOptions(revision));
    } catch (error) {
      console.warn("Preview update planning failed; rebuilding the preview.", error);
      this.startFullRender(1);
      return;
    }
    if (plan.kind === "full") { this.startFullRender(1); return; }
    this.pending = this.pending.filter((mutation) => mutation.revision > plan.revision);
    if (plan.kind === "noop") {
      // Nothing on the page shows this change. The document stays where it is; only our bookkeeping
      // moves forward so the next visible edit is not mistaken for a gap.
      this.processedRevisionValue = plan.revision;
      if (this.desiredRevisionValue > this.processedRevisionValue || this.pending.length) this.scheduleFlush(0);
      return;
    }
    const target = this.frame.contentWindow;
    if (!target) { this.startFullRender(1); return; }
    const requestId = this.createId();
    const request: PreviewUpdateRequest = {
      channel: PREVIEW_CHANNEL,
      version: PREVIEW_PROTOCOL_VERSION,
      instanceId: this.instanceIdValue,
      renderGeneration: this.renderGenerationValue,
      requestId,
      baseRevision: this.appliedRevisionValue,
      revision: plan.revision,
      action: "apply-update",
      operations: plan.operations,
    };
    const timeout = setTimeout(() => {
      if (this.inFlight?.requestId !== requestId) return;
      this.inFlight = null;
      this.startFullRender(1);
    }, PATCH_TIMEOUT_MS);
    this.inFlight = { requestId, revision: plan.revision, timeout };
    // A sandboxed srcdoc document has an opaque origin, and the browser accepts no target origin for
    // it other than "*". The narrowing that replaces it is the instance id: it is minted per render,
    // never leaves this pair of windows, and the document refuses anything that does not carry it.
    target.postMessage(request, "*");
  }

  private startFullRender(readyRetries: number): void {
    if (this.destroyed) return;
    this.invalidateInFlight();
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    this.clearReadyTimer();
    this.ready = false;
    this.renderGenerationValue += 1;
    this.instanceIdValue = this.createId();
    const revision = this.readRevision();
    this.fullRenderRevision = revision;
    this.desiredRevisionValue = Math.max(this.desiredRevisionValue, revision);
    this.pending = this.pending.filter((mutation) => mutation.revision > revision);
    this.frame.srcdoc = buildWebsiteHtml(cloneDraft(this.readDraft()), {
      preview: true,
      previewInstanceId: this.instanceIdValue,
      parentOrigin: this.parentOrigin,
      previewScroll: this.scroll,
      previewRevision: revision,
      renderGeneration: this.renderGenerationValue,
    });
    const generation = this.renderGenerationValue;
    const instanceId = this.instanceIdValue;
    this.readyTimer = setTimeout(() => {
      if (this.destroyed || this.ready || generation !== this.renderGenerationValue || instanceId !== this.instanceIdValue) return;
      this.readyTimer = null;
      // Exactly one retry. A document that stays silent twice is not going to answer, and an endless
      // rebuild loop would be worse than a stale preview.
      if (readyRetries > 0) this.startFullRender(readyRetries - 1);
    }, READY_TIMEOUT_MS);
  }

  private renderOptions(revision: number): { previewInstanceId: string; parentOrigin: string; previewScroll: PreviewScrollState | null; revision: number; renderGeneration: number } {
    return { previewInstanceId: this.instanceIdValue, parentOrigin: this.parentOrigin, previewScroll: this.scroll, revision, renderGeneration: this.renderGenerationValue };
  }

  private invalidateInFlight(): void {
    if (this.inFlight) clearTimeout(this.inFlight.timeout);
    this.inFlight = null;
  }

  private clearReadyTimer(): void { if (this.readyTimer) clearTimeout(this.readyTimer); this.readyTimer = null; }
}

function defaultId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  return id ?? `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
