import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createDefaultDraft } from "../assets/domain.js";
import { MemoryDraftRepository } from "../assets/persistence.js";
import { BuilderStore } from "../assets/store.js";
import { PREVIEW_CHANNEL, PREVIEW_PROTOCOL_VERSION } from "../assets/preview-contract.js";
import { PreviewRuntime } from "../assets/preview-runtime.js";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test" });
globalThis.DOMParser = dom.window.DOMParser;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(prepare) {
  const draft = createDefaultDraft("2026-07-23T09:00:00.000Z");
  prepare?.(draft);
  const store = new BuilderStore(draft, new MemoryDraftRepository(), 1000);
  const sent = [];
  const srcdocs = [];
  const contentWindow = { postMessage: (message, targetOrigin) => sent.push({ message, targetOrigin }) };
  const frame = { contentWindow, get srcdoc() { return srcdocs.at(-1) ?? ""; }, set srcdoc(value) { srcdocs.push(value); } };
  const navigated = [];
  const status = [];
  let ids = 0;
  const runtime = new PreviewRuntime({
    frame,
    readDraft: () => store.snapshot,
    readRevision: () => store.revision,
    onNavigate: (target) => navigated.push(target),
    onStatus: (value) => status.push(value),
    parentOrigin: "https://editor.test",
    createId: () => `id-${++ids}`,
  });
  const unsubscribe = store.subscribe((_draft, mutation) => runtime.enqueue(mutation));
  const deliver = (data, overrides = {}) => runtime.handleMessage({ source: contentWindow, origin: "null", data, ...overrides });
  const envelope = (extra) => ({ channel: PREVIEW_CHANNEL, version: PREVIEW_PROTOCOL_VERSION, instanceId: runtime.instanceId, renderGeneration: runtime.renderGeneration, revision: store.revision, ...extra });
  const ready = () => deliver(envelope({ action: "ready" }));
  const close = () => { unsubscribe(); runtime.destroy(); };
  return { store, runtime, sent, srcdocs, contentWindow, deliver, envelope, ready, navigated, status, close };
}

const setTitle = (store, value) => store.mutate((draft) => { draft.copy.heroTitle = value; }, { intent: { type: "set-field", field: "copy.heroTitle" }, history: { label: "Haupttitel" } });

test("nur Nachrichten des aktiven, undurchsichtigen Rahmens werden angenommen", () => {
  const { runtime, contentWindow, envelope, close } = fixture();
  runtime.start();
  const data = envelope({ action: "ready" });
  assert.equal(runtime.handleMessage({ source: {}, origin: "null", data }), false, "fremdes Fenster");
  assert.equal(runtime.handleMessage({ source: contentWindow, origin: "https://boese.test", data }), false, "echter Ursprung ist nicht unsere Sandbox");
  assert.equal(runtime.handleMessage({ source: contentWindow, origin: "null", data: { ...data, instanceId: "geraten" } }), false, "falsche Instanz");
  assert.equal(runtime.handleMessage({ source: contentWindow, origin: "null", data }), true);
  close();
});

test("schnelle Änderungen werden gebündelt und es ist genau eine Anfrage unterwegs", async () => {
  const { store, runtime, sent, deliver, envelope, ready, close } = fixture();
  runtime.start();
  assert.equal(ready(), true);

  setTitle(store, "Erster Stand");
  setTitle(store, "Jüngster Stand");
  await wait(70);
  assert.equal(sent.length, 1, "zwei Edits, eine Anfrage");
  const first = sent[0].message;
  assert.equal(first.baseRevision, 0);
  assert.equal(first.revision, 2);
  assert.equal(first.operations[0].value, "Jüngster Stand");

  setTitle(store, "Dritter Stand");
  await wait(70);
  assert.equal(sent.length, 1, "solange die erste Anfrage offen ist, geht keine zweite raus");
  assert.equal(runtime.hasInFlightRequest, true);

  // Neither noise nor a half-formed answer may release the slot.
  assert.equal(deliver(null), false);
  assert.equal(deliver(envelope({ revision: 2, action: "update-result", requestId: first.requestId })), false, "ohne success ist es keine Antwort");
  assert.equal(runtime.hasInFlightRequest, true);
  assert.equal(runtime.appliedRevision, 0);
  close();
});

test("erst die passende Antwort gibt die nächste Anfrage frei", async () => {
  const { store, runtime, sent, deliver, envelope, ready, close } = fixture();
  runtime.start(); ready();
  setTitle(store, "Erster Stand");
  await wait(70);
  const first = sent[0].message;

  deliver(envelope({ revision: 1, action: "update-result", requestId: "fremde-id", success: true }));
  assert.equal(runtime.hasInFlightRequest, true);
  assert.equal(runtime.appliedRevision, 0);

  setTitle(store, "Zweiter Stand");
  deliver(envelope({ revision: 1, action: "update-result", requestId: first.requestId, success: true }));
  assert.equal(runtime.appliedRevision, 1);
  await wait(20);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].message.baseRevision, 1);
  close();
});

test("eine abgelehnte Anfrage führt zum Neuaufbau statt zu einem halben Stand", async () => {
  const { store, runtime, sent, srcdocs, deliver, envelope, ready, close } = fixture();
  runtime.start(); ready();
  setTitle(store, "Wird abgelehnt");
  await wait(70);
  const request = sent[0].message;
  assert.equal(srcdocs.length, 1);

  deliver(envelope({ revision: 1, action: "update-result", requestId: request.requestId, success: false, reason: "unknown-target" }));
  assert.equal(srcdocs.length, 2, "der Rahmen wird vollständig neu gerendert");
  assert.match(srcdocs.at(-1), /Wird abgelehnt/);
  close();
});

test("eine unbeantwortete Anfrage läuft ab und wird durch einen Vollrender ersetzt", async () => {
  const { store, runtime, sent, srcdocs, deliver, ready, close } = fixture();
  runtime.start(); ready();
  const veralteteInstanz = runtime.instanceId;
  const veralteteGeneration = runtime.renderGeneration;
  setTitle(store, "Zeitüberschreitung");
  await wait(70);
  const request = sent[0].message;

  await wait(370);
  assert.equal(srcdocs.length, 2);
  assert.notEqual(runtime.instanceId, veralteteInstanz);
  assert.equal(runtime.renderGeneration, veralteteGeneration + 1);
  assert.match(srcdocs.at(-1), /Zeitüberschreitung/);

  // The late answer belongs to a document that no longer exists.
  const late = { channel: PREVIEW_CHANNEL, version: PREVIEW_PROTOCOL_VERSION, instanceId: veralteteInstanz, renderGeneration: veralteteGeneration, revision: 1, action: "update-result", requestId: request.requestId, success: true };
  assert.equal(deliver(late), false);
  close();
});

test("ein stummes Dokument baut sich von selbst genau einmal neu auf und meldet sich dann als veraltet", { timeout: 9000 }, async () => {
  const { runtime, srcdocs, status, close } = fixture();
  runtime.start();
  assert.equal(srcdocs.length, 1);
  await wait(2100);
  assert.equal(srcdocs.length, 2, "ein Wiederholungsversuch");
  await wait(2100);
  assert.equal(srcdocs.length, 2, "und keine Endlosschleife");
  // Früher endete es genau hier — stumm und für immer. Der erschöpfte Pfad ist jetzt ein sichtbarer
  // Zustand statt eines Endzustands.
  assert.equal(runtime.isStale, true);
  assert.deepEqual(status, ["stale"], "der Benutzer erfährt einmal, dass die Vorschau nicht aktuell ist");
  close();
});

test("nach erschöpften Versuchen holt die nächste Änderung die Vorschau zurück, ohne Warteschlange und ohne Wiederholungsschleife", { timeout: 20_000 }, async () => {
  const { store, runtime, srcdocs, status, ready, close } = fixture();
  runtime.start();
  await wait(4300);
  assert.equal(srcdocs.length, 2);
  assert.equal(runtime.isStale, true);

  // 500 Änderungen gegen eine Vorschau, die nicht antwortet: früher wuchs `pending` monoton mit,
  // `applied` blieb 0 und es passierte gar nichts mehr.
  for (let index = 0; index < 500; index += 1) setTitle(store, `Stand ${index}`);
  assert.ok(runtime.pendingCount <= 200, `die Warteschlange bleibt begrenzt (war ${runtime.pendingCount})`);
  await wait(70);
  assert.equal(srcdocs.length, 3, "eine neue Änderung stösst genau einen neuen Versuch an");
  assert.match(srcdocs.at(-1), /Stand 499/, "und zwar mit dem jüngsten Stand");
  assert.deepEqual(status, ["stale"], "aber keine zweite Meldung im selben Zustand");

  // Und der neue Versuch dreht sich nicht von selbst weiter.
  await wait(2200);
  assert.equal(srcdocs.length, 3, "keine Endlosschleife");

  // Antwortet das Dokument wieder, ist die Vorschau zurück — und sagt es.
  assert.equal(ready(), true);
  assert.equal(runtime.isStale, false);
  assert.deepEqual(status, ["stale", "live"]);
  assert.equal(runtime.appliedRevision, 500);
  close();
});

test("ein verspätetes Bereit-Signal kann einen bereits gepatchten Stand nicht zurückdrehen", async () => {
  const { store, runtime, sent, srcdocs, deliver, envelope, ready, close } = fixture();
  runtime.start(); ready();
  const instanceId = runtime.instanceId;
  const renderGeneration = runtime.renderGeneration;
  setTitle(store, "Gepatchter Stand");
  await wait(70);
  deliver(envelope({ revision: 1, action: "update-result", requestId: sent[0].message.requestId, success: true }));
  assert.equal(runtime.appliedRevision, 1);

  assert.equal(deliver({ channel: PREVIEW_CHANNEL, version: PREVIEW_PROTOCOL_VERSION, instanceId, renderGeneration, revision: 0, action: "ready" }), true);
  await wait(20);
  assert.equal(runtime.appliedRevision, 1);
  assert.equal(srcdocs.length, 1);
  close();
});

test("eine unsichtbare Änderung bewegt den Rahmen nicht und reisst trotzdem keine Lücke", async () => {
  const { store, runtime, sent, srcdocs, deliver, envelope, ready, close } = fixture((draft) => {
    draft.staff.push({ clientId: "staff-1", name: "Anna", email: "", role: "", bio: "", specialties: [], active: true, serviceClientIds: [], workingHours: draft.businessHours.map((day) => ({ ...day, closed: true, ranges: [] })), portraitAssetLocalId: null });
  });
  runtime.start(); ready();

  store.mutate((draft) => {
    const person = draft.staff[0];
    person.workingHours = person.workingHours.map((day) => day.dayOfWeek === 3 ? { ...day, closed: false, ranges: [{ from: "09:00", to: "17:00" }] } : day);
  }, { intent: { type: "set-staff-hours", staffClientId: "staff-1" }, history: { label: "Arbeitszeiten" } });
  await wait(70);
  assert.equal(sent.length, 0, "nichts auf der Seite zeigt persönliche Arbeitszeiten");
  assert.equal(srcdocs.length, 1, "und trotzdem kein Neuaufbau");
  assert.equal(runtime.appliedRevision, 0);

  setTitle(store, "Nach der unsichtbaren Änderung");
  await wait(70);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.baseRevision, 0, "die übersprungene Revision erzeugt keine Lücke");
  assert.equal(sent[0].message.revision, 2);
  deliver(envelope({ revision: 2, action: "update-result", requestId: sent[0].message.requestId, success: true }));
  assert.equal(runtime.appliedRevision, 2);
  assert.equal(srcdocs.length, 1);
  close();
});

test("Navigations- und Scroll-Meldungen werden weitergereicht statt als Patch missdeutet", async () => {
  const { runtime, deliver, envelope, navigated, ready, close } = fixture();
  runtime.start(); ready();

  assert.equal(deliver(envelope({ action: "navigate-to-editor", target: { kind: "field", field: "copy.heroTitle" } })), true);
  assert.deepEqual(navigated, [{ kind: "field", field: "copy.heroTitle" }]);
  assert.equal(deliver(envelope({ action: "navigate-to-editor", target: { kind: "field", field: "salon.erfunden" } })), false);
  assert.equal(navigated.length, 1);

  assert.equal(deliver(envelope({ action: "preview-scroll", position: { section: "leistungen", offsetWithinSection: 120, fallbackScrollY: 800 } })), true);
  assert.deepEqual(runtime.scrollState, { section: "leistungen", offsetWithinSection: 120, fallbackScrollY: 800 });
  close();
});

test("die gemeldete Scrollposition überlebt den nächsten Vollrender", async () => {
  const { runtime, deliver, envelope, srcdocs, ready, close } = fixture();
  runtime.start(); ready();
  deliver(envelope({ action: "preview-scroll", position: { section: "zeiten", offsetWithinSection: 40, fallbackScrollY: 1200 } }));
  runtime.renderFull();
  assert.match(srcdocs.at(-1), /"restore":\{"section":"zeiten","offsetWithinSection":40,"fallbackScrollY":1200\}/);
  close();
});

test("nach destroy() wird nichts mehr gerendert und nichts mehr gesendet", async () => {
  const { store, runtime, sent, srcdocs, ready, close } = fixture();
  runtime.start(); ready();
  close();
  setTitle(store, "Nach dem Ende");
  await wait(70);
  assert.equal(sent.length, 0);
  assert.equal(srcdocs.length, 1);
});
