import test from "node:test";
import assert from "node:assert/strict";

// Der Editor läuft im Browser. Für diese Tests genügt eine winzige DOM-Attrappe, die genau die
// Berührungspunkte der geprüften Pfade nachbildet: Element-Erkennung, closest() und den Toast-Kanal.
const toasts = [];

class FakeElement {
  constructor(options = {}) {
    this.dataset = options.dataset ?? {};
    this.ancestors = options.ancestors ?? {};
  }
  closest(selector) { return this.ancestors[selector] ?? null; }
  querySelector() { return null; }
}

globalThis.Element = FakeElement;
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, remove() {} }),
  body: { appendChild: (node) => { toasts.push(node.textContent); } },
};
// Der Toast räumt sich per Timer wieder ab; ohne unref() hielte er den Testlauf offen.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (handler, delay) => {
  const timer = realSetTimeout(handler, delay);
  timer.unref?.();
  return timer;
};

const { createDefaultDraft } = await import("../assets/domain.js");
const { MemoryDraftRepository } = await import("../assets/persistence.js");
const { BuilderStore } = await import("../assets/store.js");
const { safeMutate } = await import("../assets/ui-shared.js");
const { handleClick } = await import("../assets/ui-actions.js");

const FIXED_NOW = "2026-07-17T12:00:00.000Z";
const newStore = () => new BuilderStore(createDefaultDraft(FIXED_NOW), new MemoryDraftRepository(), 1000);

test("eine abgewiesene Mutation wird gemeldet statt in den DOM-Handler geworfen", () => {
  toasts.length = 0;
  const store = newStore();
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args);
  let result;
  try {
    result = safeMutate(
      store,
      (draft) => { draft.salon.name = "Neu"; },
      { intent: { type: "set-field", field: "copy.heroTitle" }, history: { label: "Text angepasst" } },
    );
  } finally {
    console.error = realError;
  }
  assert.equal(result, null);
  assert.equal(store.revision, 0);
  assert.equal(store.snapshot.salon.name, "Studio Miro");
  // Sichtbar auf der Oberfläche und mit Code im Log — nichts wird still geschluckt.
  assert.equal(toasts.length, 1);
  assert.equal(logged.length, 1);
  assert.match(String(logged[0].at(-1)), /INVALID_FIELD_SET/);
});

test("eine angenommene Mutation läuft durch die Schutzhülle unverändert durch", () => {
  toasts.length = 0;
  const store = newStore();
  const mutation = safeMutate(
    store,
    (draft) => { draft.salon.name = "Studio Neu"; },
    { intent: { type: "set-field", field: "salon.name" }, history: { label: "Salonangabe angepasst" } },
  );
  assert.equal(mutation.effect.type, "field-set");
  assert.equal(store.snapshot.salon.name, "Studio Neu");
  assert.deepEqual(toasts, []);
});

test("ohne Kundenstimmen-ID wird gar keine Entfernung versucht", () => {
  toasts.length = 0;
  // Der Abschnitt ist eingeschaltet, aber leer: genau hier würde der Mutator ohne ID den Schalter
  // umlegen und damit eine Entfernung ohne Eintrag behaupten.
  const draft = createDefaultDraft(FIXED_NOW);
  draft.testimonials.enabled = true;
  const store = new BuilderStore(draft, new MemoryDraftRepository(), 1000);
  const context = { store, testimonialList: { innerHTML: "" } };
  const actionButton = new FakeElement({ dataset: { action: "remove-testimonial" } });
  const target = new FakeElement({ ancestors: { "[data-action]": actionButton } });
  assert.doesNotThrow(() => handleClick(context, { target }));
  assert.equal(store.revision, 0);
  assert.equal(store.snapshot.testimonials.enabled, true);
  assert.deepEqual(toasts, []);
});
