import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVE_DRAFT_POINTER_KEY, LEGACY_STORAGE_KEY } from "../assets/domain.js";
import { MemoryDraftRepository, loadOrCreateDraft } from "../assets/persistence.js";

class FakeStorage {
  data = new Map();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  removeItem(key) { this.data.delete(key); }
  setItem(key, value) { this.data.set(key, String(value)); }
}

test("migrates only after durable repository write and leaves localStorage as pointer", async () => {
  const storage = new FakeStorage();
  storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, salon: { name: "Alt" }, services: [] }));
  const repository = new MemoryDraftRepository();
  const result = await loadOrCreateDraft(repository, storage);
  assert.equal(result.migratedFromV1, true);
  assert.equal(result.draft.salon.name, "Alt");
  assert.equal(storage.getItem(LEGACY_STORAGE_KEY), null);
  assert.equal(storage.getItem(ACTIVE_DRAFT_POINTER_KEY), result.draft.draftId);
  assert.deepEqual([...storage.data.keys()], [ACTIVE_DRAFT_POINTER_KEY]);
  assert.ok(await repository.getDraft(result.draft.draftId));
});

test("does not delete a legacy draft when persistence fails", async () => {
  const storage = new FakeStorage();
  storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, salon: { name: "Alt" } }));
  const repository = new MemoryDraftRepository();
  repository.putDraft = async () => { throw new Error("quota"); };
  await assert.rejects(() => loadOrCreateDraft(repository, storage));
  assert.ok(storage.getItem(LEGACY_STORAGE_KEY));
});

test("propagates active-draft read failures without moving the pointer", async () => {
  const storage = new FakeStorage();
  storage.setItem(ACTIVE_DRAFT_POINTER_KEY, "draft-existing");
  const repository = new MemoryDraftRepository();
  repository.getDraft = async () => { throw new Error("read failed"); };
  await assert.rejects(() => loadOrCreateDraft(repository, storage), /read failed/);
  assert.equal(storage.getItem(ACTIVE_DRAFT_POINTER_KEY), "draft-existing");
});

test("replaces a draft and its blobs atomically through the repository contract", async () => {
  const storage = new FakeStorage();
  const repository = new MemoryDraftRepository();
  const first = (await loadOrCreateDraft(repository, storage)).draft;
  first.assets.push({
    localId: "asset-local-1",
    kind: "HERO",
    ownerClientId: null,
    fileName: "hero.jpg",
    mimeType: "image/jpeg",
    bytes: 3,
    width: null,
    height: null,
    alt: "",
    focalPoint: null,
    uploadedAssetId: null,
  });
  await repository.putDraft(first);
  await repository.putAssetBlob("asset-local-1", new Blob(["abc"]));
  const { replaceWithFreshDraft } = await import("../assets/persistence.js");
  const fresh = await replaceWithFreshDraft(repository, first, storage);
  assert.equal(await repository.getDraft(first.draftId), null);
  assert.ok(await repository.getDraft(fresh.draftId));
  assert.equal(await repository.getAssetBlob("asset-local-1"), null);
  assert.equal(storage.getItem(ACTIVE_DRAFT_POINTER_KEY), fresh.draftId);
});
