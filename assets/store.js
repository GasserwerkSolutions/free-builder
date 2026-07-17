import { cloneDraft, normalizeDraftV2 } from "./domain.js";
export class BuilderStore {
    repository;
    debounceMs;
    draft;
    saveTimer = null;
    listeners = new Set();
    saveListeners = new Set();
    saveChain = Promise.resolve();
    constructor(initialDraft, repository, debounceMs = 250) {
        this.repository = repository;
        this.debounceMs = debounceMs;
        this.draft = normalizeDraftV2(initialDraft);
    }
    get snapshot() { return this.draft; }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    subscribeSave(listener) { this.saveListeners.add(listener); return () => this.saveListeners.delete(listener); }
    mutate(mutator) {
        const next = cloneDraft(this.draft);
        mutator(next);
        next.updatedAt = new Date().toISOString();
        this.draft = normalizeDraftV2(next);
        this.emit();
        this.scheduleSave();
    }
    replace(next, persist = true) {
        this.draft = normalizeDraftV2(next);
        this.emit();
        if (persist)
            this.scheduleSave(0);
    }
    async flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.enqueueSave();
    }
    emit() { this.listeners.forEach((listener) => listener(this.draft)); }
    emitSave(state, error) { this.saveListeners.forEach((listener) => listener(state, error)); }
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
        const operation = this.saveChain.then(async () => {
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
        // Keep the serialization chain usable after an error, while returning the
        // real operation so callers such as flush() can observe durability failure.
        this.saveChain = operation.catch(() => undefined);
        return operation;
    }
}
