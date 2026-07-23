import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createDefaultDraft, createDefaultSchedule } from "../assets/domain.js";
import { MemoryDraftRepository } from "../assets/persistence.js";
import { BuilderStore } from "../assets/store.js";
import { planPreviewUpdate } from "../assets/preview-update-planner.js";

// The planner cuts regions out of a full render, which needs a DOM parser.
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test" });
globalThis.DOMParser = dom.window.DOMParser;

const RENDER_OPTIONS = { previewInstanceId: "plan", parentOrigin: "https://editor.test", previewScroll: null, revision: 0, renderGeneration: 1 };

function fixture(prepare) {
  const draft = createDefaultDraft("2026-07-23T09:00:00.000Z");
  prepare?.(draft);
  return new BuilderStore(draft, new MemoryDraftRepository(), 1000);
}

const plan = (store, mutations) => planPreviewUpdate(mutations, store.snapshot, RENDER_OPTIONS);
const kinds = (result) => result.operations.map((operation) => operation.type);
const regions = (result) => result.operations.filter((operation) => operation.type === "replace-region").map((operation) => operation.region);

function setField(store, path, value) {
  const [group, key] = path.split(".");
  return store.mutate((draft) => { draft[group][key] = value; }, { intent: { type: "set-field", field: path }, history: { label: path } });
}

test("ein einzeln vorkommender Text wird gepatcht statt neu gerendert", () => {
  const store = fixture();
  const mutation = setField(store, "copy.heroTitle", "Ein neuer Haupttitel");
  const result = plan(store, [mutation]);
  assert.equal(result.kind, "patch");
  assert.deepEqual(kinds(result), ["patch-text"]);
  assert.deepEqual(result.operations[0].target, { kind: "field", field: "copy.heroTitle" });
  assert.equal(result.operations[0].value, "Ein neuer Haupttitel");
});

test("ein Text, der leer wird, ersetzt seine Region statt nur seinen Inhalt", () => {
  const store = fixture();
  const mutation = setField(store, "copy.heroTitle", "   ");
  const result = plan(store, [mutation]);
  assert.equal(result.kind, "patch");
  assert.deepEqual(regions(result), ["hero"]);
});

test("ein mehrfach vorkommendes Feld ersetzt jede Region, in der es steht", () => {
  const store = fixture();
  const result = plan(store, [setField(store, "salon.name", "Salon Nord")]);
  assert.deepEqual(regions(result), ["header", "intro", "details", "footer"]);
});

test("die beiden Farbfelder werden als Theme gepatcht, nicht als Vollrender", () => {
  const store = fixture();
  const result = plan(store, [store.mutate((draft) => { draft.theme.primary = "#123456"; }, { intent: { type: "set-field", field: "theme.primary" }, history: { label: "Farbe" } })]);
  assert.equal(result.kind, "patch");
  assert.deepEqual(kinds(result), ["patch-theme"]);
  assert.equal(result.operations[0].primary, "#123456");
});

test("ein Preset ist ein neues Stylesheet und erzwingt deshalb einen Vollrender", () => {
  const store = fixture();
  const mutation = store.mutate((draft) => { draft.theme.preset = "bold"; draft.theme.primary = "#311b4d"; draft.theme.accent = "#f0a32f"; }, { intent: { type: "set-theme" }, history: { label: "Farbwelt" } });
  const result = plan(store, [mutation]);
  assert.equal(result.kind, "full");
  assert.equal(result.reason, "metadata");
});

test("eine autoritative Ersetzung ist nie patchbar", () => {
  const store = fixture();
  const mutation = store.replace(createDefaultDraft("2026-07-23T10:00:00.000Z"), false, "reset");
  const result = plan(store, [mutation]);
  assert.equal(result.kind, "full");
  assert.equal(result.reason, "draft-replace");
});

test("persönliche Arbeitszeiten stehen auf keiner Seite und ergeben deshalb einen Noop", () => {
  const store = fixture((draft) => {
    draft.staff.push({ clientId: "staff-1", name: "Anna", email: "", role: "", bio: "", specialties: [], active: true, serviceClientIds: [], workingHours: createDefaultSchedule().map((day) => ({ ...day, closed: true, ranges: [] })), portraitAssetLocalId: null });
  });
  const mutation = store.mutate((draft) => {
    const person = draft.staff[0];
    person.workingHours = person.workingHours.map((day) => day.dayOfWeek === 3 ? { ...day, closed: false, ranges: [{ from: "09:00", to: "17:00" }] } : day);
  }, { intent: { type: "set-staff-hours", staffClientId: "staff-1" }, history: { label: "Arbeitszeiten" } });
  const result = plan(store, [mutation]);
  assert.equal(result.kind, "noop");
  assert.equal(result.revision, mutation.revision);
});

test("Öffnungszeiten treffen nur den Zeiten-Block", () => {
  const store = fixture();
  const mutation = store.mutate((draft) => { draft.businessHours = draft.businessHours.map((day) => day.dayOfWeek === 3 ? { ...day, closed: true, ranges: [] } : day); }, { intent: { type: "set-business-hours" }, history: { label: "Zeiten" } });
  assert.deepEqual(regions(plan(store, [mutation])), ["details"]);
});

test("eine Leistungsänderung zieht den Team-Block nur mit, wenn es ihn gibt", () => {
  const ohneTeam = fixture();
  const ohne = ohneTeam.mutate((draft) => { draft.services[0].name = "Damenschnitt lang"; draft.services[0].slug = "damenschnitt-lang"; }, { intent: { type: "set-service-field", serviceClientId: ohneTeam.snapshot.services[0].clientId, field: "name" }, history: { label: "Leistung" } });
  assert.deepEqual(regions(plan(ohneTeam, [ohne])), ["services"]);

  const mitTeam = fixture((draft) => {
    draft.staff.push({ clientId: "staff-1", name: "Anna", email: "", role: "", bio: "", specialties: [], active: true, serviceClientIds: [draft.services[0].clientId], workingHours: createDefaultSchedule(), portraitAssetLocalId: null });
  });
  const mit = mitTeam.mutate((draft) => { draft.services[0].name = "Damenschnitt lang"; draft.services[0].slug = "damenschnitt-lang"; }, { intent: { type: "set-service-field", serviceClientId: mitTeam.snapshot.services[0].clientId, field: "name" }, history: { label: "Leistung" } });
  assert.deepEqual(regions(plan(mitTeam, [mit])), ["services", "team"]);
});

test("eine Region, die es nach der Änderung nicht mehr gibt, erzwingt einen Vollrender", () => {
  const store = fixture((draft) => {
    draft.staff.push({ clientId: "staff-1", name: "Anna", email: "", role: "", bio: "", specialties: [], active: true, serviceClientIds: [], workingHours: createDefaultSchedule(), portraitAssetLocalId: null });
  });
  // Deactivating the only person removes the whole team block. A replacement cannot express that.
  const mutation = store.mutate((draft) => { draft.staff[0].active = false; }, { intent: { type: "set-staff-field", staffClientId: "staff-1", field: "active" }, history: { label: "Person" } });
  const result = plan(store, [mutation]);
  assert.equal(result.kind, "full");
  assert.equal(result.reason, "layout");
});

test("mehrere Änderungen werden zu einer Anfrage zusammengelegt, ohne doppelt zu schreiben", () => {
  const store = fixture();
  const first = setField(store, "copy.heroTitle", "Erster Stand");
  const second = setField(store, "copy.heroSubtitle", "Zweiter Text");
  const third = setField(store, "copy.heroTitle", "Jüngster Stand");
  const result = plan(store, [first, second, third]);
  assert.equal(result.kind, "patch");
  assert.equal(result.revision, third.revision);
  const texts = result.operations.filter((operation) => operation.type === "patch-text");
  assert.equal(texts.length, 2, "je Ziel genau eine Schreiboperation");
  assert.equal(texts.find((operation) => operation.target.field === "copy.heroTitle").value, "Jüngster Stand");
});

test("ein Textpatch innerhalb einer ersetzten Region wird fallengelassen", () => {
  const store = fixture();
  const text = setField(store, "copy.heroTitle", "Titel");
  const region = setField(store, "salon.phone", "+41 44 111 11 11");
  const result = plan(store, [text, region]);
  // salon.phone replaces the hero region, which already carries the new title.
  assert.ok(regions(result).includes("hero"));
  assert.equal(result.operations.some((operation) => operation.type === "patch-text"), false);
});

test("eine unbeschriebene Sammeländerung ist nicht planbar", () => {
  const store = fixture();
  const mutation = store.mutate((draft) => { draft.salon.city = "Bern"; draft.copy.heroTitle = "Anders"; }, { intent: { type: "batch" }, history: { label: "Sammeländerung" } });
  const result = plan(store, [mutation]);
  assert.equal(result.kind, "full");
  assert.equal(result.reason, "unsupported");
});
