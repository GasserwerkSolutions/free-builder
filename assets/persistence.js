import { ACTIVE_DRAFT_POINTER_KEY, LEGACY_STORAGE_KEY, createDefaultDraft, migrateV1ToV2, normalizeDraftV2, } from "./domain.js";
const DB_NAME = "gasserwerk-free-builder";
const DB_VERSION = 2;
const STORE_DRAFTS = "drafts";
const STORE_ASSET_BLOBS = "assetBlobs";
const STORE_META = "meta";
function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("INDEXED_DB_REQUEST_FAILED"));
    });
}
function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("INDEXED_DB_TRANSACTION_FAILED"));
        transaction.onabort = () => reject(transaction.error ?? new Error("INDEXED_DB_TRANSACTION_ABORTED"));
    });
}
export class IndexedDbDraftRepository {
    dbPromise = null;
    open() {
        if (!globalThis.indexedDB)
            return Promise.reject(new Error("INDEXED_DB_UNAVAILABLE"));
        if (this.dbPromise)
            return this.dbPromise;
        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_DRAFTS))
                    db.createObjectStore(STORE_DRAFTS, { keyPath: "draftId" });
                if (!db.objectStoreNames.contains(STORE_ASSET_BLOBS))
                    db.createObjectStore(STORE_ASSET_BLOBS);
                if (!db.objectStoreNames.contains(STORE_META))
                    db.createObjectStore(STORE_META);
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => db.close();
                resolve(db);
            };
            request.onerror = () => reject(request.error ?? new Error("INDEXED_DB_OPEN_FAILED"));
            request.onblocked = () => reject(new Error("INDEXED_DB_UPGRADE_BLOCKED"));
        });
        return this.dbPromise;
    }
    async getDraft(draftId) {
        const db = await this.open();
        const transaction = db.transaction(STORE_DRAFTS, "readonly");
        const value = await requestResult(transaction.objectStore(STORE_DRAFTS).get(draftId));
        await transactionDone(transaction);
        if (value == null)
            return null;
        return normalizeDraftV2(value);
    }
    async putDraft(draft) {
        const normalized = normalizeDraftV2(draft);
        const db = await this.open();
        const transaction = db.transaction([STORE_DRAFTS, STORE_META], "readwrite");
        transaction.objectStore(STORE_DRAFTS).put(normalized);
        transaction.objectStore(STORE_META).put(normalized.draftId, "activeDraftId");
        transaction.objectStore(STORE_META).put(normalized.schemaVersion, "schemaVersion");
        await transactionDone(transaction);
    }
    async deleteDraft(draftId) {
        const db = await this.open();
        const transaction = db.transaction(STORE_DRAFTS, "readwrite");
        transaction.objectStore(STORE_DRAFTS).delete(draftId);
        await transactionDone(transaction);
    }
    async getAssetBlob(localId) {
        const db = await this.open();
        const transaction = db.transaction(STORE_ASSET_BLOBS, "readonly");
        const value = await requestResult(transaction.objectStore(STORE_ASSET_BLOBS).get(localId));
        await transactionDone(transaction);
        return value instanceof Blob ? value : null;
    }
    async putAssetBlob(localId, blob) {
        if (!localId || !(blob instanceof Blob))
            throw new Error("INVALID_ASSET_BLOB");
        const db = await this.open();
        const transaction = db.transaction(STORE_ASSET_BLOBS, "readwrite");
        transaction.objectStore(STORE_ASSET_BLOBS).put(blob, localId);
        await transactionDone(transaction);
    }
    async deleteAssetBlob(localId) {
        const db = await this.open();
        const transaction = db.transaction(STORE_ASSET_BLOBS, "readwrite");
        transaction.objectStore(STORE_ASSET_BLOBS).delete(localId);
        await transactionDone(transaction);
    }
    async deleteAssetBlobs(localIds) {
        if (!localIds.length)
            return;
        const db = await this.open();
        const transaction = db.transaction(STORE_ASSET_BLOBS, "readwrite");
        const store = transaction.objectStore(STORE_ASSET_BLOBS);
        [...new Set(localIds)].forEach((localId) => store.delete(localId));
        await transactionDone(transaction);
    }
    async replaceDraft(currentDraftId, fresh, assetLocalIds) {
        const normalized = normalizeDraftV2(fresh);
        const db = await this.open();
        const transaction = db.transaction([STORE_DRAFTS, STORE_ASSET_BLOBS, STORE_META], "readwrite");
        const drafts = transaction.objectStore(STORE_DRAFTS);
        const blobs = transaction.objectStore(STORE_ASSET_BLOBS);
        const meta = transaction.objectStore(STORE_META);
        drafts.put(normalized);
        if (currentDraftId !== normalized.draftId)
            drafts.delete(currentDraftId);
        [...new Set(assetLocalIds)].forEach((localId) => blobs.delete(localId));
        meta.put(normalized.draftId, "activeDraftId");
        meta.put(normalized.schemaVersion, "schemaVersion");
        await transactionDone(transaction);
    }
    async getMeta(key) {
        const db = await this.open();
        const transaction = db.transaction(STORE_META, "readonly");
        const value = await requestResult(transaction.objectStore(STORE_META).get(key));
        await transactionDone(transaction);
        return value;
    }
    async setMeta(key, value) {
        const db = await this.open();
        const transaction = db.transaction(STORE_META, "readwrite");
        transaction.objectStore(STORE_META).put(value, key);
        await transactionDone(transaction);
    }
    async clearAll() {
        const db = await this.open();
        const transaction = db.transaction([STORE_DRAFTS, STORE_ASSET_BLOBS, STORE_META], "readwrite");
        transaction.objectStore(STORE_DRAFTS).clear();
        transaction.objectStore(STORE_ASSET_BLOBS).clear();
        transaction.objectStore(STORE_META).clear();
        await transactionDone(transaction);
    }
}
export class MemoryDraftRepository {
    drafts = new Map();
    blobs = new Map();
    meta = new Map();
    async getDraft(draftId) { const value = this.drafts.get(draftId); return value ? normalizeDraftV2(structuredClone(value)) : null; }
    async putDraft(draft) { const normalized = normalizeDraftV2(draft); this.drafts.set(normalized.draftId, structuredClone(normalized)); this.meta.set("activeDraftId", normalized.draftId); this.meta.set("schemaVersion", normalized.schemaVersion); }
    async deleteDraft(draftId) { this.drafts.delete(draftId); }
    async getAssetBlob(localId) { return this.blobs.get(localId) ?? null; }
    async putAssetBlob(localId, blob) { this.blobs.set(localId, blob); }
    async deleteAssetBlob(localId) { this.blobs.delete(localId); }
    async deleteAssetBlobs(localIds) { localIds.forEach((id) => this.blobs.delete(id)); }
    async replaceDraft(currentDraftId, fresh, assetLocalIds) {
        const normalized = normalizeDraftV2(fresh);
        const nextDrafts = new Map(this.drafts);
        const nextBlobs = new Map(this.blobs);
        nextDrafts.set(normalized.draftId, structuredClone(normalized));
        if (currentDraftId !== normalized.draftId)
            nextDrafts.delete(currentDraftId);
        assetLocalIds.forEach((id) => nextBlobs.delete(id));
        this.drafts = nextDrafts;
        this.blobs = nextBlobs;
        this.meta.set("activeDraftId", normalized.draftId);
        this.meta.set("schemaVersion", normalized.schemaVersion);
    }
    async getMeta(key) { return this.meta.get(key); }
    async setMeta(key, value) { this.meta.set(key, value); }
    async clearAll() { this.drafts.clear(); this.blobs.clear(); this.meta.clear(); }
}
export async function loadOrCreateDraft(repository, storage = localStorage) {
    const pointer = storage.getItem(ACTIVE_DRAFT_POINTER_KEY) || String(await repository.getMeta("activeDraftId") ?? "");
    if (pointer) {
        // Operational read failures must not create a replacement draft or move the pointer.
        const existing = await repository.getDraft(pointer);
        if (existing) {
            storage.setItem(ACTIVE_DRAFT_POINTER_KEY, existing.draftId);
            return { draft: existing, migratedFromV1: false, recovered: false };
        }
    }
    const legacyRaw = storage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
        let migrated;
        try {
            const legacy = JSON.parse(legacyRaw);
            migrated = migrateV1ToV2(legacy);
        }
        catch (error) {
            console.warn("Legacy draft could not be parsed or migrated; the raw value is preserved.", error);
            const recovered = createDefaultDraft();
            await repository.putDraft(recovered);
            storage.setItem(ACTIVE_DRAFT_POINTER_KEY, recovered.draftId);
            return { draft: recovered, migratedFromV1: false, recovered: true };
        }
        // The legacy value is removed only after the new draft is durably written.
        await repository.putDraft(migrated);
        storage.setItem(ACTIVE_DRAFT_POINTER_KEY, migrated.draftId);
        storage.removeItem(LEGACY_STORAGE_KEY);
        return { draft: migrated, migratedFromV1: true, recovered: false };
    }
    const draft = createDefaultDraft();
    await repository.putDraft(draft);
    storage.setItem(ACTIVE_DRAFT_POINTER_KEY, draft.draftId);
    return { draft, migratedFromV1: false, recovered: false };
}
export async function replaceWithFreshDraft(repository, current, storage = localStorage) {
    const fresh = createDefaultDraft();
    await repository.replaceDraft(current.draftId, fresh, current.assets.map((asset) => asset.localId));
    storage.setItem(ACTIVE_DRAFT_POINTER_KEY, fresh.draftId);
    storage.removeItem(LEGACY_STORAGE_KEY);
    return fresh;
}
