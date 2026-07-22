import { cloneDraft, normalizeDraftV2 } from "./domain.js";
import { createDraftEffect, draftsEqualIgnoringUpdatedAt, invertDraftEffect, requiresSnapshotInversion, sameIntentTarget, sourceForReplaceReason, } from "./draft-mutations.js";
/** How long consecutive edits to the same target collapse into a single undo step. */
const HISTORY_GROUP_MS = 900;
const HISTORY_LIMIT = 60;
/** Used when a caller does not describe its change; accepted, but never verified. */
const UNDESCRIBED = { intent: { type: "batch" }, history: { label: "Änderung" } };
export class BuilderStore {
    repository;
    debounceMs;
    draft;
    revisionValue = 0;
    saveTimer = null;
    listeners = new Set();
    saveListeners = new Set();
    historyListeners = new Set();
    saveChain = Promise.resolve();
    saveGeneration = 0;
    undoStack = [];
    redoStack = [];
    lastHistoryKey = "";
    lastHistoryIntent = null;
    lastHistoryAt = 0;
    constructor(initialDraft, repository, debounceMs = 250) {
        this.repository = repository;
        this.debounceMs = debounceMs;
        this.draft = normalizeDraftV2(initialDraft);
    }
    get snapshot() { return this.draft; }
    /** Monotonic counter over accepted state changes. Never decreases, not even on undo. */
    get revision() { return this.revisionValue; }
    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }
    get nextUndoAction() { return this.undoStack.at(-1)?.history ?? null; }
    get nextRedoAction() { return this.redoStack.at(-1)?.history ?? null; }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    subscribeSave(listener) { this.saveListeners.add(listener); return () => this.saveListeners.delete(listener); }
    subscribeHistory(listener) { this.historyListeners.add(listener); listener(this.historyState()); return () => this.historyListeners.delete(listener); }
    /**
     * Apply a mutation and prove it did what the descriptor claims. Returns null when the draft did
     * not actually change; throws when the applied change is not the declared one.
     */
    mutate(mutator, descriptor = UNDESCRIBED) {
        const before = cloneDraft(this.draft);
        const working = cloneDraft(this.draft);
        mutator(working);
        const normalized = normalizeDraftV2(working);
        if (draftsEqualIgnoringUpdatedAt(before, normalized))
            return null;
        const effect = createDraftEffect(before, normalized, descriptor.intent);
        const now = Date.now();
        this.recordHistory(before, normalized, effect, descriptor, now);
        const mutation = this.commit(normalized, "user", effect, descriptor.history, now);
        this.scheduleSave();
        return mutation;
    }
    /** Authoritative overwrite (import, reset, recovery). Not undoable: it clears the history. */
    replace(next, persist = true, reason = "recovery") {
        const before = cloneDraft(this.draft);
        const normalized = normalizeDraftV2(next);
        this.clearHistory();
        this.cancelPendingSaves();
        if (draftsEqualIgnoringUpdatedAt(before, normalized)) {
            this.draft = normalized;
            this.emitHistory();
            this.persistAfterReplace(persist);
            return null;
        }
        const history = { label: REPLACE_LABELS[reason] };
        const mutation = this.commit(normalized, sourceForReplaceReason(reason), { type: "draft-replace", reason }, history, Date.now());
        this.persistAfterReplace(persist);
        return mutation;
    }
    undo() {
        this.flushHistoryGroup();
        const record = this.undoStack.pop();
        if (!record)
            return null;
        const current = cloneDraft(this.draft);
        this.redoStack.push({ after: current, intent: record.intent, history: record.history, createdAt: Date.now() });
        const next = normalizeDraftV2(record.before);
        const effect = requiresSnapshotInversion(record.effect) ? createDraftEffect(current, next, record.intent) : invertDraftEffect(record.effect);
        const mutation = this.commit(next, "undo", effect, record.history, Date.now());
        this.scheduleSave(0);
        return mutation;
    }
    redo() {
        this.flushHistoryGroup();
        const record = this.redoStack.pop();
        if (!record)
            return null;
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
    flushHistoryGroup() { this.lastHistoryKey = ""; this.lastHistoryIntent = null; this.lastHistoryAt = 0; }
    async flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.enqueueSave();
    }
    // Single write path for mutate/replace/undo/redo: stamp, publish, count the revision, notify.
    commit(next, source, effect, history, occurredAt) {
        next.updatedAt = new Date(occurredAt).toISOString();
        this.draft = next;
        this.revisionValue += 1;
        const mutation = { revision: this.revisionValue, source, effect, history, occurredAt };
        this.listeners.forEach((listener) => listener(this.draft, mutation));
        this.emitHistory();
        return mutation;
    }
    // Consecutive edits that share a history key and aim at the same target collapse into one step.
    recordHistory(before, after, effect, descriptor, now) {
        const key = descriptor.history.key ?? "";
        const mergesWithPrevious = Boolean(key
            && key === this.lastHistoryKey
            && this.lastHistoryIntent
            && sameIntentTarget(descriptor.intent, this.lastHistoryIntent)
            && now - this.lastHistoryAt < HISTORY_GROUP_MS);
        let collapsed = false;
        if (mergesWithPrevious) {
            const record = this.undoStack.at(-1);
            if (!record)
                throw new Error("MISSING_GROUPED_HISTORY_RECORD");
            if (draftsEqualIgnoringUpdatedAt(record.before, after)) {
                // The grouped edit came back to where it started; drop the step instead of keeping a no-op.
                this.undoStack.pop();
                collapsed = true;
            }
            else {
                record.effect = createDraftEffect(record.before, after, record.intent);
                record.history = descriptor.history;
                record.createdAt = now;
            }
        }
        else {
            this.pushUndo({ before, effect, history: descriptor.history, intent: descriptor.intent, createdAt: now });
        }
        this.redoStack = [];
        if (collapsed)
            this.flushHistoryGroup();
        else {
            this.lastHistoryKey = key;
            this.lastHistoryIntent = descriptor.intent;
            this.lastHistoryAt = now;
        }
    }
    pushUndo(record) {
        this.undoStack.push(record);
        if (this.undoStack.length > HISTORY_LIMIT)
            this.undoStack.shift();
    }
    persistAfterReplace(persist) {
        if (persist)
            this.scheduleSave(0);
        else
            this.emitSave("saved");
    }
    emitSave(state, error) { this.saveListeners.forEach((listener) => listener(state, error)); }
    emitHistory() { const state = this.historyState(); this.historyListeners.forEach((listener) => listener(state)); }
    historyState() {
        return { canUndo: this.canUndo, canRedo: this.canRedo, undoAction: this.nextUndoAction, redoAction: this.nextRedoAction, recentActions: this.undoStack.slice(-5).map((record) => record.history) };
    }
    clearHistory() { this.undoStack = []; this.redoStack = []; this.flushHistoryGroup(); }
    // Invalidate in-flight and pending saves so a stale snapshot can never overwrite an authoritative
    // replacement that was already written to the repository.
    cancelPendingSaves() {
        this.saveGeneration += 1;
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }
    scheduleSave(delay = this.debounceMs) {
        this.emitSave("saving");
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.enqueueSave().catch((error) => console.error("Draft save failed.", error));
        }, delay);
    }
    enqueueSave() {
        const snapshot = cloneDraft(this.draft);
        const generation = this.saveGeneration;
        const operation = this.saveChain.then(async () => {
            if (generation !== this.saveGeneration)
                return;
            this.emitSave("saving");
            try {
                await this.repository.putDraft(snapshot);
                this.emitSave("saved");
            }
            catch (error) {
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
const REPLACE_LABELS = {
    import: "Sicherung wiederhergestellt",
    reset: "Editor zurückgesetzt",
    recovery: "Entwurf wiederhergestellt",
};
