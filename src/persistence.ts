import {
  ACTIVE_DRAFT_POINTER_KEY,
  LEGACY_STORAGE_KEY,
  type BuilderDraftV2,
  type LegacyDraftV1,
  createDefaultDraft,
  migrateV1ToV2,
  normalizeDraftV2,
} from "./domain.js";

const DB_NAME = "gasserwerk-free-builder";
const DB_VERSION = 2;
const STORE_DRAFTS = "drafts";
const STORE_ASSET_BLOBS = "assetBlobs";
const STORE_META = "meta";

export type MetaKey = "activeDraftId" | "schemaVersion" | "lastCleanupAt";
export type DraftLoadResult = { draft: BuilderDraftV2; migratedFromV1: boolean; recovered: boolean };

export interface DraftRepository {
  getDraft(draftId: string): Promise<BuilderDraftV2 | null>;
  putDraft(draft: BuilderDraftV2): Promise<void>;
  deleteDraft(draftId: string): Promise<void>;
  getAssetBlob(localId: string): Promise<Blob | null>;
  putAssetBlob(localId: string, blob: Blob): Promise<void>;
  deleteAssetBlob(localId: string): Promise<void>;
  deleteAssetBlobs(localIds: string[]): Promise<void>;
  replaceDraft(currentDraftId: string, fresh: BuilderDraftV2, assetLocalIds: string[]): Promise<void>;
  getMeta(key: MetaKey): Promise<unknown>;
  setMeta(key: MetaKey, value: unknown): Promise<void>;
  clearAll(): Promise<void>;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("INDEXED_DB_REQUEST_FAILED"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("INDEXED_DB_TRANSACTION_FAILED"));
    transaction.onabort = () => reject(transaction.error ?? new Error("INDEXED_DB_TRANSACTION_ABORTED"));
  });
}

export class IndexedDbDraftRepository implements DraftRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) return Promise.reject(new Error("INDEXED_DB_UNAVAILABLE"));
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) db.createObjectStore(STORE_DRAFTS, { keyPath: "draftId" });
        if (!db.objectStoreNames.contains(STORE_ASSET_BLOBS)) db.createObjectStore(STORE_ASSET_BLOBS);
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
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

  async getDraft(draftId: string): Promise<BuilderDraftV2 | null> {
    const db = await this.open();
    const transaction = db.transaction(STORE_DRAFTS, "readonly");
    const value = await requestResult(transaction.objectStore(STORE_DRAFTS).get(draftId));
    await transactionDone(transaction);
    if (value == null) return null;
    return normalizeDraftV2(value);
  }

  async putDraft(draft: BuilderDraftV2): Promise<void> {
    const normalized = normalizeDraftV2(draft);
    const db = await this.open();
    const transaction = db.transaction([STORE_DRAFTS, STORE_META], "readwrite");
    transaction.objectStore(STORE_DRAFTS).put(normalized);
    transaction.objectStore(STORE_META).put(normalized.draftId, "activeDraftId");
    transaction.objectStore(STORE_META).put(normalized.schemaVersion, "schemaVersion");
    await transactionDone(transaction);
  }

  async deleteDraft(draftId: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(STORE_DRAFTS, "readwrite");
    transaction.objectStore(STORE_DRAFTS).delete(draftId);
    await transactionDone(transaction);
  }

  async getAssetBlob(localId: string): Promise<Blob | null> {
    const db = await this.open();
    const transaction = db.transaction(STORE_ASSET_BLOBS, "readonly");
    const value = await requestResult(transaction.objectStore(STORE_ASSET_BLOBS).get(localId));
    await transactionDone(transaction);
    return value instanceof Blob ? value : null;
  }

  async putAssetBlob(localId: string, blob: Blob): Promise<void> {
    if (!localId || !(blob instanceof Blob)) throw new Error("INVALID_ASSET_BLOB");
    const db = await this.open();
    const transaction = db.transaction(STORE_ASSET_BLOBS, "readwrite");
    transaction.objectStore(STORE_ASSET_BLOBS).put(blob, localId);
    await transactionDone(transaction);
  }

  async deleteAssetBlob(localId: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(STORE_ASSET_BLOBS, "readwrite");
    transaction.objectStore(STORE_ASSET_BLOBS).delete(localId);
    await transactionDone(transaction);
  }

  async deleteAssetBlobs(localIds: string[]): Promise<void> {
    if (!localIds.length) return;
    const db = await this.open();
    const transaction = db.transaction(STORE_ASSET_BLOBS, "readwrite");
    const store = transaction.objectStore(STORE_ASSET_BLOBS);
    [...new Set(localIds)].forEach((localId) => store.delete(localId));
    await transactionDone(transaction);
  }

  async replaceDraft(currentDraftId: string, fresh: BuilderDraftV2, assetLocalIds: string[]): Promise<void> {
    const normalized = normalizeDraftV2(fresh);
    const db = await this.open();
    const transaction = db.transaction([STORE_DRAFTS, STORE_ASSET_BLOBS, STORE_META], "readwrite");
    const drafts = transaction.objectStore(STORE_DRAFTS);
    const blobs = transaction.objectStore(STORE_ASSET_BLOBS);
    const meta = transaction.objectStore(STORE_META);
    drafts.put(normalized);
    if (currentDraftId !== normalized.draftId) drafts.delete(currentDraftId);
    [...new Set(assetLocalIds)].forEach((localId) => blobs.delete(localId));
    meta.put(normalized.draftId, "activeDraftId");
    meta.put(normalized.schemaVersion, "schemaVersion");
    await transactionDone(transaction);
  }

  async getMeta(key: MetaKey): Promise<unknown> {
    const db = await this.open();
    const transaction = db.transaction(STORE_META, "readonly");
    const value = await requestResult(transaction.objectStore(STORE_META).get(key));
    await transactionDone(transaction);
    return value;
  }

  async setMeta(key: MetaKey, value: unknown): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(STORE_META, "readwrite");
    transaction.objectStore(STORE_META).put(value, key);
    await transactionDone(transaction);
  }

  async clearAll(): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([STORE_DRAFTS, STORE_ASSET_BLOBS, STORE_META], "readwrite");
    transaction.objectStore(STORE_DRAFTS).clear();
    transaction.objectStore(STORE_ASSET_BLOBS).clear();
    transaction.objectStore(STORE_META).clear();
    await transactionDone(transaction);
  }
}

export class MemoryDraftRepository implements DraftRepository {
  private drafts = new Map<string, BuilderDraftV2>();
  private blobs = new Map<string, Blob>();
  private meta = new Map<MetaKey, unknown>();
  async getDraft(draftId: string): Promise<BuilderDraftV2 | null> { const value = this.drafts.get(draftId); return value ? normalizeDraftV2(structuredClone(value)) : null; }
  async putDraft(draft: BuilderDraftV2): Promise<void> { const normalized = normalizeDraftV2(draft); this.drafts.set(normalized.draftId, structuredClone(normalized)); this.meta.set("activeDraftId", normalized.draftId); this.meta.set("schemaVersion", normalized.schemaVersion); }
  async deleteDraft(draftId: string): Promise<void> { this.drafts.delete(draftId); }
  async getAssetBlob(localId: string): Promise<Blob | null> { return this.blobs.get(localId) ?? null; }
  async putAssetBlob(localId: string, blob: Blob): Promise<void> { this.blobs.set(localId, blob); }
  async deleteAssetBlob(localId: string): Promise<void> { this.blobs.delete(localId); }
  async deleteAssetBlobs(localIds: string[]): Promise<void> { localIds.forEach((id) => this.blobs.delete(id)); }
  async replaceDraft(currentDraftId: string, fresh: BuilderDraftV2, assetLocalIds: string[]): Promise<void> {
    const normalized = normalizeDraftV2(fresh);
    const nextDrafts = new Map(this.drafts);
    const nextBlobs = new Map(this.blobs);
    nextDrafts.set(normalized.draftId, structuredClone(normalized));
    if (currentDraftId !== normalized.draftId) nextDrafts.delete(currentDraftId);
    assetLocalIds.forEach((id) => nextBlobs.delete(id));
    this.drafts = nextDrafts;
    this.blobs = nextBlobs;
    this.meta.set("activeDraftId", normalized.draftId);
    this.meta.set("schemaVersion", normalized.schemaVersion);
  }
  async getMeta(key: MetaKey): Promise<unknown> { return this.meta.get(key); }
  async setMeta(key: MetaKey, value: unknown): Promise<void> { this.meta.set(key, value); }
  async clearAll(): Promise<void> { this.drafts.clear(); this.blobs.clear(); this.meta.clear(); }
}

export async function loadOrCreateDraft(repository: DraftRepository, storage: Storage = localStorage): Promise<DraftLoadResult> {
  const pointer = storage.getItem(ACTIVE_DRAFT_POINTER_KEY) || String(await repository.getMeta("activeDraftId") ?? "");
  if (pointer) {
    const existing = await repository.getDraft(pointer);
    if (existing) {
      storage.setItem(ACTIVE_DRAFT_POINTER_KEY, existing.draftId);
      return { draft: existing, migratedFromV1: false, recovered: false };
    }
  }

  const legacyRaw = storage.getItem(LEGACY_STORAGE_KEY);
  if (legacyRaw) {
    let migrated: BuilderDraftV2;
    try {
      const legacy = JSON.parse(legacyRaw) as LegacyDraftV1;
      migrated = migrateV1ToV2(legacy);
    } catch (error) {
      console.warn("Legacy draft could not be parsed or migrated; the raw value is preserved.", error);
      const recovered = createDefaultDraft();
      await repository.putDraft(recovered);
      storage.setItem(ACTIVE_DRAFT_POINTER_KEY, recovered.draftId);
      return { draft: recovered, migratedFromV1: false, recovered: true };
    }
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

export async function replaceWithFreshDraft(repository: DraftRepository, current: BuilderDraftV2, storage: Storage = localStorage): Promise<BuilderDraftV2> {
  const fresh = createDefaultDraft();
  await repository.replaceDraft(current.draftId, fresh, current.assets.map((asset) => asset.localId));
  storage.setItem(ACTIVE_DRAFT_POINTER_KEY, fresh.draftId);
  storage.removeItem(LEGACY_STORAGE_KEY);
  return fresh;
}
