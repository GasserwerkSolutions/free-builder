import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultDraft } from "../assets/domain.js";
import { MemoryDraftRepository } from "../assets/persistence.js";
import { BuilderStore } from "../assets/store.js";

test("serializes debounced writes and persists immutable client ids", async () => {
  const repository = new MemoryDraftRepository();
  const draft = createDefaultDraft("2026-07-17T12:00:00.000Z");
  const clientId = draft.services[0].clientId;
  const store = new BuilderStore(draft, repository, 1);
  store.mutate((next) => { next.services[0].name = "Neuer Name"; next.services[0].slug = "neuer-name"; });
  await store.flush();
  const saved = await repository.getDraft(draft.draftId);
  assert.equal(saved.services[0].clientId, clientId);
  assert.equal(saved.services[0].name, "Neuer Name");
});

test("flush surfaces durability failures and later saves can recover", async () => {
  const repository = new MemoryDraftRepository();
  const draft = createDefaultDraft("2026-07-17T12:00:00.000Z");
  const originalPut = repository.putDraft.bind(repository);
  let fail = true;
  repository.putDraft = async (value) => {
    if (fail) throw new Error("quota");
    await originalPut(value);
  };
  const store = new BuilderStore(draft, repository, 1000);
  store.mutate((next) => { next.salon.name = "Erster Versuch"; });
  await assert.rejects(() => store.flush(), /quota/);
  fail = false;
  store.mutate((next) => { next.salon.name = "Zweiter Versuch"; });
  await store.flush();
  assert.equal((await repository.getDraft(draft.draftId)).salon.name, "Zweiter Versuch");
});
