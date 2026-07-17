import { IndexedDbDraftRepository, MemoryDraftRepository, loadOrCreateDraft, type DraftRepository } from "./persistence.js";
import { LEGACY_STORAGE_KEY, createDefaultDraft, migrateV1ToV2 } from "./domain.js";
import { BuilderStore } from "./store.js";
import { BuilderUi } from "./ui.js";
import { installTeamUi } from "./team-ui.js";

async function start(): Promise<void> {
  let repository: DraftRepository = new IndexedDbDraftRepository();
  let loaded;
  let volatileStorage = false;
  try {
    loaded = await loadOrCreateDraft(repository);
  } catch (error) {
    console.error("IndexedDB initialization failed; using an in-memory emergency draft.", error);
    repository = new MemoryDraftRepository();
    volatileStorage = true;
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    let emergencyDraft = createDefaultDraft();
    let migratedFromV1 = false;
    if (legacyRaw) {
      try { emergencyDraft = migrateV1ToV2(JSON.parse(legacyRaw)); migratedFromV1 = true; }
      catch (migrationError) { console.warn("Legacy draft remains untouched because migration failed.", migrationError); }
    }
    await repository.putDraft(emergencyDraft);
    loaded = { draft: emergencyDraft, migratedFromV1, recovered: false };
    const status = document.getElementById("saveStatus");
    if (status) { status.textContent = "Nur für diese Sitzung"; status.className = "status-pill is-error"; status.title = "Der Browser stellt keinen dauerhaften lokalen Speicher bereit."; }
  }
  const store = new BuilderStore(loaded.draft, repository);
  new BuilderUi(store, repository).init({ ...loaded, volatileStorage });
  installTeamUi(store, repository);
}

void start().catch((error) => {
  console.error(error);
  const status = document.getElementById("saveStatus");
  if (status) { status.textContent = "Builder konnte nicht geladen werden"; status.className = "status-pill is-error"; }
});
