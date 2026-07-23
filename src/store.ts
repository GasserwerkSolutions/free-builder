import { type BuilderDraftV2, cloneDraft, normalizeDraftV2 } from "./domain.js";
import type { DraftRepository } from "./persistence.js";
import {
  createDraftEffect,
  draftsEqualIgnoringUpdatedAt,
  invertDraftEffect,
  requiresSnapshotInversion,
  sameIntentTarget,
  sourceForReplaceReason,
  type DraftEffect,
  type DraftMutation,
  type DraftMutationDescriptor,
  type DraftMutationIntent,
  type HistoryDescriptor,
  type HistoryRecord,
  type ReplaceReason,
} from "./draft-mutations.js";

export type SaveState = "idle" | "saving" | "saved" | "error";
/** The draft stays the first argument, so listeners that only care about the state keep working. */
export type StoreListener = (draft: Readonly<BuilderDraftV2>, mutation: DraftMutation) => void;
export type SaveListener = (state: SaveState, error?: unknown) => void;
export type HistoryState = {
  canUndo: boolean;
  canRedo: boolean;
  undoAction: HistoryDescriptor | null;
  redoAction: HistoryDescriptor | null;
  recentActions: readonly HistoryDescriptor[];
};
export type HistoryListener = (state: HistoryState) => void;

type InternalHistoryRecord = HistoryRecord & { intent: DraftMutationIntent };
type RedoRecord = { after: BuilderDraftV2; intent: DraftMutationIntent; history: HistoryDescriptor; createdAt: number };

/** How long consecutive edits to the same target collapse into a single undo step. */
const HISTORY_GROUP_MS = 900;
const HISTORY_LIMIT = 60;

export class BuilderStore {
  private draft: BuilderDraftV2;
  private revisionValue = 0;
  private generationValue = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<StoreListener>();
  private saveListeners = new Set<SaveListener>();
  private historyListeners = new Set<HistoryListener>();
  private saveChain: Promise<void> = Promise.resolve();
  private saveGeneration = 0;
  private undoStack: InternalHistoryRecord[] = [];
  private redoStack: RedoRecord[] = [];
  private lastHistoryKey = "";
  private lastHistoryIntent: DraftMutationIntent | null = null;
  private lastHistoryAt = 0;

  constructor(initialDraft: BuilderDraftV2, private readonly repository: DraftRepository, private readonly debounceMs = 250) {
    this.draft = normalizeDraftV2(initialDraft);
  }

  get snapshot(): Readonly<BuilderDraftV2> { return this.draft; }
  /** Monotonic counter over accepted state changes. Never decreases, not even on undo. */
  get revision(): number { return this.revisionValue; }
  /**
   * Monotonic counter over authoritative replacements (import, reset, recovery).
   *
   * The revision alone cannot see those: replacing the draft with content that happens to be equal
   * leaves the revision where it is, yet the draft object, its identity and its history are new. A
   * long-running operation that only watched the revision would carry on against a draft that no
   * longer exists — so anything that has to survive an await watches both counters.
   */
  get generation(): number { return this.generationValue; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get nextUndoAction(): HistoryDescriptor | null { return this.undoStack.at(-1)?.history ?? null; }
  get nextRedoAction(): HistoryDescriptor | null { return this.redoStack.at(-1)?.history ?? null; }

  subscribe(listener: StoreListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeSave(listener: SaveListener): () => void { this.saveListeners.add(listener); return () => this.saveListeners.delete(listener); }
  subscribeHistory(listener: HistoryListener): () => void { this.historyListeners.add(listener); listener(this.historyState()); return () => this.historyListeners.delete(listener); }

  /**
   * Apply a mutation and prove it did what the descriptor claims. Returns null when the draft did
   * not actually change; throws when the applied change is not the declared one. The descriptor is
   * mandatory on purpose — a caller that may omit it turns the verification into a fiction.
   */
  mutate(mutator: (draft: BuilderDraftV2) => void, descriptor: DraftMutationDescriptor): DraftMutation | null {
    const before = cloneDraft(this.draft);
    const working = cloneDraft(this.draft);
    mutator(working);
    const normalized = normalizeDraftV2(working);
    if (draftsEqualIgnoringUpdatedAt(before, normalized)) return null;
    const effect = createDraftEffect(before, normalized, descriptor.intent);
    const now = Date.now();
    this.recordHistory(before, normalized, effect, descriptor, now);
    const mutation = this.commit(normalized, "user", effect, descriptor.history, now);
    this.scheduleSave();
    return mutation;
  }

  /** Authoritative overwrite (import, reset, recovery). Not undoable: it clears the history. */
  replace(next: BuilderDraftV2, persist = true, reason: ReplaceReason = "recovery"): DraftMutation | null {
    const before = cloneDraft(this.draft);
    const normalized = normalizeDraftV2(next);
    this.generationValue += 1;
    this.clearHistory();
    this.cancelPendingSaves();
    const history: HistoryDescriptor = { label: REPLACE_LABELS[reason] };
    if (draftsEqualIgnoringUpdatedAt(before, normalized)) {
      // Same content, but a different draft object and a cleared history. The revision does not move
      // (nothing changed), yet every subscriber is told — not just the history ones — so no surface
      // keeps rendering from the object that was just replaced.
      this.draft = normalized;
      this.notify({ revision: this.revisionValue, source: sourceForReplaceReason(reason), effect: { type: "draft-replace", reason }, history, occurredAt: Date.now() });
      this.emitHistory();
      this.persistAfterReplace(persist);
      return null;
    }
    const mutation = this.commit(normalized, sourceForReplaceReason(reason), { type: "draft-replace", reason }, history, Date.now());
    this.persistAfterReplace(persist);
    return mutation;
  }

  undo(): DraftMutation | null {
    this.flushHistoryGroup();
    const record = this.undoStack.pop();
    if (!record) return null;
    const current = cloneDraft(this.draft);
    this.redoStack.push({ after: current, intent: record.intent, history: record.history, createdAt: Date.now() });
    const next = normalizeDraftV2(record.before);
    const effect = requiresSnapshotInversion(record.effect) ? createDraftEffect(current, next, record.intent) : invertDraftEffect(record.effect);
    const mutation = this.commit(next, "undo", effect, record.history, Date.now());
    this.scheduleSave(0);
    return mutation;
  }

  redo(): DraftMutation | null {
    this.flushHistoryGroup();
    const record = this.redoStack.pop();
    if (!record) return null;
    const before = cloneDraft(this.draft);
    const next = normalizeDraftV2(record.after);
    const effect = createDraftEffect(before, next, record.intent);
    const now = Date.now();
    this.pushUndo({ before, effect, history: record.history, intent: record.intent, createdAt: now });
    const mutation = this.commit(next, "redo", effect, record.history, now);
    this.scheduleSave(0);
    return mutation;
  }

  /** Close the current grouping window so the next edit starts a fresh undo step. */
  flushHistoryGroup(): void { this.lastHistoryKey = ""; this.lastHistoryIntent = null; this.lastHistoryAt = 0; }

  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    await this.enqueueSave();
  }

  // Single write path for mutate/replace/undo/redo: stamp, publish, count the revision, notify.
  private commit(next: BuilderDraftV2, source: DraftMutation["source"], effect: DraftEffect, history: HistoryDescriptor, occurredAt: number): DraftMutation {
    next.updatedAt = new Date(occurredAt).toISOString();
    this.draft = next;
    this.revisionValue += 1;
    const mutation: DraftMutation = { revision: this.revisionValue, source, effect, history, occurredAt };
    this.notify(mutation);
    this.emitHistory();
    return mutation;
  }

  private notify(mutation: DraftMutation): void { this.listeners.forEach((listener) => listener(this.draft, mutation)); }

  // Consecutive edits that share a history key and aim at the same target collapse into one step.
  private recordHistory(before: BuilderDraftV2, after: BuilderDraftV2, effect: DraftEffect, descriptor: DraftMutationDescriptor, now: number): void {
    const key = descriptor.history.key ?? "";
    const mergesWithPrevious = Boolean(
      key
      && key === this.lastHistoryKey
      && this.lastHistoryIntent
      && sameIntentTarget(descriptor.intent, this.lastHistoryIntent)
      && now - this.lastHistoryAt < HISTORY_GROUP_MS,
    );
    let collapsed = false;
    try {
      if (mergesWithPrevious) {
        const record = this.undoStack.at(-1);
        if (!record) throw new Error("MISSING_GROUPED_HISTORY_RECORD");
        if (draftsEqualIgnoringUpdatedAt(record.before, after)) {
          // The grouped edit came back to where it started; drop the step instead of keeping a no-op.
          this.undoStack.pop();
          collapsed = true;
        } else {
          record.effect = createDraftEffect(record.before, after, record.intent);
          record.history = descriptor.history;
          record.createdAt = now;
        }
      } else {
        this.pushUndo({ before, effect, history: descriptor.history, intent: descriptor.intent, createdAt: now });
      }
      // A rejected mutation changes nothing, so it must not drop a redo step either.
      this.redoStack = [];
    } finally {
      // The grouping window moves with the attempt, not only with the accepted edit. Leaving it on
      // the older timestamp would freeze the window and tear a continuous edit apart afterwards.
      if (collapsed) this.flushHistoryGroup();
      else { this.lastHistoryKey = key; this.lastHistoryIntent = descriptor.intent; this.lastHistoryAt = now; }
    }
  }

  private pushUndo(record: InternalHistoryRecord): void {
    this.undoStack.push(record);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
  }

  private persistAfterReplace(persist: boolean): void {
    if (persist) this.scheduleSave(0);
    else this.emitSave("saved");
  }

  private emitSave(state: SaveState, error?: unknown): void { this.saveListeners.forEach((listener) => listener(state, error)); }
  private emitHistory(): void { const state = this.historyState(); this.historyListeners.forEach((listener) => listener(state)); }
  private historyState(): HistoryState {
    return { canUndo: this.canUndo, canRedo: this.canRedo, undoAction: this.nextUndoAction, redoAction: this.nextRedoAction, recentActions: this.undoStack.slice(-5).map((record) => record.history) };
  }
  private clearHistory(): void { this.undoStack = []; this.redoStack = []; this.flushHistoryGroup(); }

  // Invalidate in-flight and pending saves so a stale snapshot can never overwrite an authoritative
  // replacement that was already written to the repository.
  private cancelPendingSaves(): void {
    this.saveGeneration += 1;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
  }

  private scheduleSave(delay = this.debounceMs): void {
    this.emitSave("saving");
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.enqueueSave().catch((error) => console.error("Draft save failed.", error));
    }, delay);
  }

  private enqueueSave(): Promise<void> {
    const snapshot = cloneDraft(this.draft);
    const generation = this.saveGeneration;
    const operation = this.saveChain.then(async () => {
      if (generation !== this.saveGeneration) return;
      this.emitSave("saving");
      try {
        await this.repository.putDraft(snapshot);
        // The write took time, and an authoritative replacement may have landed while it was in
        // flight. Re-check after the await: a snapshot that is no longer the truth must not report
        // itself as the saved state.
        if (generation !== this.saveGeneration) return;
        this.emitSave("saved");
      } catch (error) {
        this.emitSave("error", error);
        throw error;
      }
    });
    // Keep the serialization chain usable after an error, while returning the real operation so
    // callers such as flush() can observe durability failure.
    this.saveChain = operation.catch(() => undefined);
    return operation;
  }
}

const REPLACE_LABELS: Record<ReplaceReason, string> = {
  import: "Sicherung wiederhergestellt",
  reset: "Editor zurückgesetzt",
  recovery: "Entwurf wiederhergestellt",
};
