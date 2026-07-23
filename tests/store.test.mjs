import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, createDefaultDraft, uniqueSlug } from "../assets/domain.js";
import { MemoryDraftRepository } from "../assets/persistence.js";
import { BuilderStore } from "../assets/store.js";

test("serializes debounced writes and persists immutable client ids", async () => {
  const repository = new MemoryDraftRepository();
  const draft = createDefaultDraft("2026-07-17T12:00:00.000Z");
  const clientId = draft.services[0].clientId;
  const store = new BuilderStore(draft, repository, 1);
  store.mutate(
    (next) => { next.services[0].name = "Neuer Name"; next.services[0].slug = "neuer-name"; },
    { intent: { type: "set-service-field", serviceClientId: clientId, field: "name" }, history: { label: "Leistung bearbeitet" } },
  );
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
  store.mutate((next) => { next.salon.name = "Erster Versuch"; }, fieldDescriptor("salon.name"));
  await assert.rejects(() => store.flush(), /quota/);
  fail = false;
  store.mutate((next) => { next.salon.name = "Zweiter Versuch"; }, fieldDescriptor("salon.name"));
  await store.flush();
  assert.equal((await repository.getDraft(draft.draftId)).salon.name, "Zweiter Versuch");
});

const FIXED_NOW = "2026-07-17T12:00:00.000Z";
const fieldDescriptor = (field, label = "Feld geändert") => ({ intent: { type: "set-field", field }, history: { key: `field:${field}`, label } });
const newStore = (draft = createDefaultDraft(FIXED_NOW), repository = new MemoryDraftRepository()) => new BuilderStore(draft, repository, 1000);

// Die drei Helfer bilden exakt die Editor-Mutationen aus ui-actions nach: Einfügen mit abgeleitetem
// Slug und Umbenennen, das den Slug neu ableitet — inklusive Gruppierungsschlüssel.
const serviceNameDescriptor = (serviceClientId) => ({
  intent: { type: "set-service-field", serviceClientId, field: "name" },
  history: { key: `service:${serviceClientId}:name`, label: "Leistung bearbeitet" },
});
function addService(store, name, clientId) {
  store.mutate((draft) => {
    draft.services.push({ clientId, slug: uniqueSlug(name, draft.services), category: "Schnitt", name, description: "", durationMinutes: 30, price: 0, priceType: "fixed", bookable: true });
  }, { intent: { type: "insert-collection-item", collection: "services", clientId }, history: { label: "Leistung hinzugefügt" } });
  return clientId;
}
function renameService(store, clientId, name) {
  return store.mutate((draft) => {
    const service = draft.services.find((item) => item.clientId === clientId);
    if (!service) return;
    service.name = name;
    service.slug = uniqueSlug(name, draft.services, service.clientId);
  }, serviceNameDescriptor(clientId));
}
const serviceOf = (store, clientId) => store.snapshot.services.find((service) => service.clientId === clientId);

test("die Revision steigt nur bei angenommenen Zustandsänderungen", () => {
  const store = newStore();
  assert.equal(store.revision, 0);
  assert.equal(store.mutate(() => {}, fieldDescriptor("salon.name")), null);
  assert.equal(store.revision, 0);
  const mutation = store.mutate((next) => { next.salon.name = "Studio Neu"; }, fieldDescriptor("salon.name", "Salonname geändert"));
  assert.equal(mutation.revision, 1);
  assert.equal(store.revision, 1);
  assert.equal(mutation.source, "user");
  assert.equal(mutation.effect.type, "field-set");
});

test("eine Absicht, die die tatsächliche Änderung nicht beschreibt, wird abgewiesen", () => {
  const store = newStore();
  assert.throws(() => store.mutate((next) => { next.salon.name = "Neu"; }, fieldDescriptor("copy.heroTitle")), /INVALID_FIELD_SET|UNEXPECTED_FIELD_CHANGE/);
  assert.equal(store.revision, 0);
  assert.equal(store.canUndo, false);
  assert.equal(store.snapshot.salon.name, "Studio Miro");
});

test("Undo stellt den Vorzustand her und meldet den inversen Effekt", () => {
  const draft = createDefaultDraft(FIXED_NOW);
  const original = draft.salon.name;
  const store = newStore(draft);
  store.mutate((next) => { next.salon.name = "Studio Neu"; }, fieldDescriptor("salon.name", "Salonname geändert"));
  assert.equal(store.nextUndoAction.label, "Salonname geändert");
  const undo = store.undo();
  assert.equal(undo.source, "undo");
  assert.deepEqual(undo.effect, { type: "field-set", field: "salon.name", previousPresence: "present", nextPresence: "present" });
  assert.equal(store.snapshot.salon.name, original);
  assert.equal(store.nextRedoAction.label, "Salonname geändert");
  const redo = store.redo();
  assert.equal(redo.source, "redo");
  assert.equal(store.snapshot.salon.name, "Studio Neu");
  // Die Revision zählt jede angenommene Änderung weiter, auch Undo und Redo.
  assert.equal(store.revision, 3);
});

test("Undo einer Sammlungs-Einfügung entfernt den Eintrag wieder", () => {
  const store = newStore();
  const clientId = "voice-neu";
  store.mutate((next) => {
    next.testimonials.items.push({ clientId, quote: "Sehr gut", name: "Mia", detail: "" });
    next.testimonials.enabled = true;
  }, { intent: { type: "insert-collection-item", collection: "testimonials", clientId }, history: { label: "Kundenstimme hinzugefügt" } });
  const mutation = store.undo();
  assert.deepEqual(mutation.effect, { type: "collection-remove", collection: "testimonials", clientId, previousIndex: 0 });
  assert.equal(store.snapshot.testimonials.items.length, 0);
  assert.equal(store.snapshot.testimonials.enabled, false);
});

test("Theme-Undo wird aus den Schnappschüssen neu verifiziert", () => {
  const draft = createDefaultDraft(FIXED_NOW);
  const original = structuredClone(draft.theme);
  const store = newStore(draft);
  store.mutate((next) => { next.theme.preset = "bold"; next.theme.primary = PRESETS.bold.primary; next.theme.accent = PRESETS.bold.accent; },
    { intent: { type: "set-theme" }, history: { label: "Farbwelt geändert" } });
  const mutation = store.undo();
  assert.deepEqual(mutation.effect, { type: "theme-set", changed: ["preset", "primary", "accent"] });
  assert.deepEqual(store.snapshot.theme, original);
});

test("aufeinanderfolgende Edits am selben Feld werden zu einem Undo-Schritt gruppiert", () => {
  const draft = createDefaultDraft(FIXED_NOW);
  const original = draft.salon.tagline;
  const store = newStore(draft);
  const descriptor = fieldDescriptor("salon.tagline", "Leitsatz geändert");
  store.mutate((next) => { next.salon.tagline = "A"; }, descriptor);
  store.mutate((next) => { next.salon.tagline = "Ab"; }, descriptor);
  store.mutate((next) => { next.salon.tagline = "Abc"; }, descriptor);
  assert.equal(store.revision, 3);
  store.undo();
  assert.equal(store.snapshot.salon.tagline, original);
  assert.equal(store.canUndo, false);
});

test("Edits an verschiedenen Feldern werden nicht gruppiert", () => {
  const store = newStore();
  store.mutate((next) => { next.salon.tagline = "Neuer Leitsatz"; }, fieldDescriptor("salon.tagline"));
  store.mutate((next) => { next.salon.city = "Bern"; }, fieldDescriptor("salon.city"));
  store.undo();
  assert.equal(store.snapshot.salon.city, "Zürich");
  assert.equal(store.snapshot.salon.tagline, "Neuer Leitsatz");
  assert.equal(store.canUndo, true);
});

test("flushHistoryGroup trennt spätere Edits im selben Feld", () => {
  const store = newStore();
  const descriptor = fieldDescriptor("salon.tagline", "Leitsatz geändert");
  store.mutate((next) => { next.salon.tagline = "A"; }, descriptor);
  store.flushHistoryGroup();
  store.mutate((next) => { next.salon.tagline = "B"; }, descriptor);
  store.undo();
  assert.equal(store.snapshot.salon.tagline, "A");
  assert.equal(store.canUndo, true);
});

test("eine gruppierte Rückkehr zum Ausgangswert schliesst die Gruppe ohne Leerschritt", () => {
  const draft = createDefaultDraft(FIXED_NOW);
  const original = draft.salon.tagline;
  const store = newStore(draft);
  const descriptor = fieldDescriptor("salon.tagline", "Leitsatz geändert");
  store.mutate((next) => { next.salon.tagline = "Zwischenstand"; }, descriptor);
  store.mutate((next) => { next.salon.tagline = original; }, descriptor);
  assert.equal(store.canUndo, false);
  assert.doesNotThrow(() => store.mutate((next) => { next.salon.tagline = "Neuer Anfang"; }, descriptor));
  assert.equal(store.canUndo, true);
  store.undo();
  assert.equal(store.snapshot.salon.tagline, original);
});

test("die Undo-Tiefe ist auf 60 Schritte begrenzt", () => {
  const store = newStore();
  for (let index = 0; index < 70; index += 1) {
    store.mutate((next) => { next.salon.name = `Name ${index}`; }, { intent: { type: "set-field", field: "salon.name" }, history: { label: "Salonname geändert" } });
  }
  let steps = 0;
  while (store.undo()) steps += 1;
  assert.equal(steps, 60);
  assert.equal(store.snapshot.salon.name, "Name 9");
});

test("eine autoritative Ersetzung löscht die Historie und meldet eine Ersetzungs-Mutation", () => {
  const draft = createDefaultDraft(FIXED_NOW);
  const store = newStore(draft);
  store.mutate((next) => { next.salon.name = "Vor dem Import"; }, fieldDescriptor("salon.name"));
  const restored = createDefaultDraft(FIXED_NOW);
  restored.draftId = draft.draftId;
  restored.salon.name = "Importiert";
  const mutation = store.replace(restored, false, "import");
  assert.equal(mutation.source, "import");
  assert.deepEqual(mutation.effect, { type: "draft-replace", reason: "import" });
  assert.equal(store.snapshot.salon.name, "Importiert");
  assert.equal(store.canUndo, false);
  assert.equal(store.canRedo, false);
  assert.equal(store.undo(), null);
});

test("der Generationsschutz verwirft eine eingereihte, veraltete Speicherung", async () => {
  const repository = new MemoryDraftRepository();
  const draft = createDefaultDraft(FIXED_NOW);
  const written = [];
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const originalPut = repository.putDraft.bind(repository);
  let blockFirst = true;
  repository.putDraft = async (value) => {
    if (blockFirst) { blockFirst = false; await gate; }
    written.push(value.salon.name);
    await originalPut(value);
  };
  const store = newStore(draft, repository);
  store.mutate((next) => { next.salon.name = "Erste"; }, fieldDescriptor("salon.name"));
  const firstSave = store.flush();
  // Die erste Speicherung hängt jetzt im Repository fest und belegt die Save-Kette.
  await new Promise((resolve) => setTimeout(resolve, 0));
  store.mutate((next) => { next.salon.name = "Veraltet"; }, fieldDescriptor("salon.name"));
  const staleSave = store.flush();
  const restored = createDefaultDraft(FIXED_NOW);
  restored.draftId = draft.draftId;
  restored.salon.name = "Wiederhergestellt";
  store.replace(restored, false, "recovery");
  release();
  await firstSave;
  await staleSave;
  assert.deepEqual(written, ["Erste"]);
  assert.equal(store.snapshot.salon.name, "Wiederhergestellt");
});

test("Historie-Abonnenten erhalten den aktuellen Stand sofort und nach jeder Änderung", () => {
  const store = newStore();
  const states = [];
  const unsubscribe = store.subscribeHistory((state) => states.push(state));
  assert.deepEqual(states[0], { canUndo: false, canRedo: false, undoAction: null, redoAction: null, recentActions: [] });
  store.mutate((next) => { next.salon.city = "Bern"; }, fieldDescriptor("salon.city", "Ort geändert"));
  assert.equal(states.at(-1).canUndo, true);
  assert.equal(states.at(-1).undoAction.label, "Ort geändert");
  unsubscribe();
  store.undo();
  assert.equal(states.length, 2);
});

test("Abonnenten erhalten weiterhin den Entwurf als erstes Argument", () => {
  const store = newStore();
  const seen = [];
  store.subscribe((draft, mutation) => seen.push([draft.salon.name, mutation.revision, mutation.effect.type]));
  store.mutate((next) => { next.salon.name = "Studio Neu"; }, fieldDescriptor("salon.name"));
  assert.deepEqual(seen, [["Studio Neu", 1, "field-set"]]);
});

test("gruppierte Umbenennungen einer Leistung ergeben einen einzigen Undo-Schritt", () => {
  const store = newStore();
  const clientId = "service-damenschnitt";
  renameService(store, clientId, "D");
  renameService(store, clientId, "Da");
  renameService(store, clientId, "Dam");
  assert.equal(store.revision, 3);
  assert.equal(serviceOf(store, clientId).slug, "dam");
  store.undo();
  assert.equal(serviceOf(store, clientId).name, "Damenschnitt");
  assert.equal(serviceOf(store, clientId).slug, "damenschnitt");
  assert.equal(store.canUndo, false);
});

test("ein im Gruppierungsfenster frei gewordener Slug bricht die Umbenennung nicht ab", () => {
  const store = newStore();
  const first = addService(store, "Neue Leistung", "service-eins");
  const second = addService(store, "Neue Leistung", "service-zwei");
  addService(store, "Neue Leistung", "service-drei");
  assert.equal(serviceOf(store, second).slug, "neue-leistung-2");
  // Die erste Leistung gibt den Basis-Slug frei.
  renameService(store, first, "Waschen");
  store.flushHistoryGroup();
  // Zwei gruppierte Tastendrücke in der zweiten Leistung: ein Zeichen tippen und wieder löschen.
  // Der Name ist danach netto unverändert, der frei gewordene Basis-Slug rückt aber nach.
  renameService(store, second, "Neue LeistungX");
  assert.doesNotThrow(() => renameService(store, second, "Neue Leistung"));
  assert.equal(serviceOf(store, second).name, "Neue Leistung");
  assert.equal(serviceOf(store, second).slug, "neue-leistung");
  store.undo();
  assert.equal(serviceOf(store, second).name, "Neue Leistung");
  assert.equal(serviceOf(store, second).slug, "neue-leistung-2");
});

test("ein Schreibvorgang mit unverändertem Wert erzeugt weder Mutation noch Wurf", () => {
  const store = newStore();
  const clientId = "service-damenschnitt";
  renameService(store, clientId, "Damenschnitt Neu");
  // Das change-Ereignis nach dem input-Ereignis schreibt denselben Wert ein zweites Mal.
  assert.equal(renameService(store, clientId, "Damenschnitt Neu"), null);
  assert.equal(store.revision, 1);
  assert.equal(serviceOf(store, clientId).slug, "damenschnitt-neu");
});

test("ohne Descriptor läuft keine unverifizierte Mutation durch", () => {
  const store = newStore();
  assert.throws(() => store.mutate((next) => { next.salon.name = "Ohne Absicht"; }));
  assert.equal(store.revision, 0);
  assert.equal(store.snapshot.salon.name, "Studio Miro");
});

test("ein Wurf im Gruppierungszweig schiebt das Gruppierungsfenster trotzdem weiter", () => {
  const store = newStore();
  const descriptor = fieldDescriptor("salon.tagline", "Leitsatz geändert");
  const realNow = Date.now;
  try {
    Date.now = () => 1000;
    store.mutate((next) => { next.salon.tagline = "A"; }, descriptor);
    // Erzwingt den Fehlerfall im Gruppierungszweig: der Gruppen-Datensatz fehlt. Der Zugriff auf die
    // interne Historie ist hier Absicht — das Gruppierungsfenster ist von aussen nicht beobachtbar.
    store.undoStack.length = 0;
    Date.now = () => 1500;
    assert.throws(() => store.mutate((next) => { next.salon.tagline = "Ab"; }, descriptor), /MISSING_GROUPED_HISTORY_RECORD/);
    assert.equal(store.lastHistoryAt, 1500);
  } finally {
    Date.now = realNow;
  }
});

test("eine Speicherung, die während des Schreibens ungültig wird, meldet sich nicht als gespeichert", async () => {
  const repository = new MemoryDraftRepository();
  const draft = createDefaultDraft(FIXED_NOW);
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const originalPut = repository.putDraft.bind(repository);
  let blockFirst = true;
  repository.putDraft = async (value) => {
    if (blockFirst) { blockFirst = false; await gate; }
    await originalPut(value);
  };
  const store = newStore(draft, repository);
  const states = [];
  store.subscribeSave((state) => states.push(state));
  store.mutate((next) => { next.salon.name = "Vor dem Zurücksetzen"; }, fieldDescriptor("salon.name"));
  const pending = store.flush();
  // Die Speicherung hängt jetzt im Repository fest; das Zurücksetzen entwertet sie mittendrin.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fresh = createDefaultDraft(FIXED_NOW);
  fresh.draftId = draft.draftId;
  store.replace(fresh, false, "reset");
  release();
  await pending;
  assert.equal(states.filter((state) => state === "saved").length, 1);
});

test("eine inhaltsgleiche Ersetzung benachrichtigt auch die Entwurfs-Abonnenten", () => {
  const draft = createDefaultDraft(FIXED_NOW);
  const store = newStore(draft);
  const seen = [];
  store.subscribe((next, mutation) => seen.push([next.salon.name, mutation.effect.type, mutation.revision]));
  const same = createDefaultDraft(FIXED_NOW);
  same.draftId = draft.draftId;
  assert.equal(store.replace(same, false, "recovery"), null);
  assert.deepEqual(seen, [["Studio Miro", "draft-replace", 0]]);
});
