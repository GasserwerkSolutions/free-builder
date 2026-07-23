import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultDraft } from "../assets/domain.js";
import { MemoryDraftRepository } from "../assets/persistence.js";
import { BuilderStore } from "../assets/store.js";
import {
  MAX_PUBLISH_PAYLOAD_BYTES,
  PUBLISH_INTENT_PATH,
  outcomeForResponse,
  parseRetryAfter,
  payloadByteLength,
} from "../assets/publish-contract.js";
import { publishEndpoint, sendPublishIntent } from "../assets/publish-client.js";
import { draftIdentity, readDraftIdentity, sameDraftIdentity } from "../assets/publish-identity.js";
import { findBinaryValues, runPublishPreflight, sameStamp, stampOf } from "../assets/publish-preflight.js";
import { PublishFlow, initialPublishState } from "../assets/publish-flow.js";

// Die Publish-Logik ohne Oberfläche: Vertrag, Vorprüfung, Netzweg und Zustandsmaschine.
// Kein Aufruf geht gegen die echte Gegenstelle — der Transport ist immer ein Stub.

const STAMP = { revision: 3, generation: 0 };

function publishableDraft(overrides = {}) {
  // Der Standardentwurf ist absichtlich fast fertig; für einen sauberen Publish fehlt nur das Team.
  const draft = createDefaultDraft("2026-07-23T09:00:00.000Z");
  draft.staff = [{
    clientId: "staff-1",
    name: "Anna Muster",
    email: "",
    role: "Coiffeuse",
    bio: "",
    specialties: [],
    active: true,
    serviceClientIds: draft.services.map((service) => service.clientId),
    workingHours: draft.businessHours.map((day) => ({ ...day, ranges: day.ranges.map((range) => ({ ...range })) })),
    portraitAssetLocalId: null,
  }];
  return { ...draft, ...overrides };
}

function jsonResponse(status, payload) {
  return { status, text: async () => (payload === undefined ? "" : JSON.stringify(payload)) };
}

/** Lässt alle bereits fälligen Mikrotasks durchlaufen. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

// --- Vertrag ------------------------------------------------------------------------------------

test("der Endpunktpfad bleibt relativ, und eine Basis-URL wird nur vorangestellt", () => {
  assert.equal(publishEndpoint(), PUBLISH_INTENT_PATH);
  assert.equal(publishEndpoint(""), PUBLISH_INTENT_PATH);
  assert.equal(publishEndpoint("https://app.gasserwerk.ch"), `https://app.gasserwerk.ch${PUBLISH_INTENT_PATH}`);
  assert.equal(publishEndpoint("https://app.gasserwerk.ch/"), `https://app.gasserwerk.ch${PUBLISH_INTENT_PATH}`);
  assert.match(PUBLISH_INTENT_PATH, /^\//, "ein absoluter Fremdhost wäre ein CORS-Umweg");
});

test("jede Antwortart des Endpunkts wird auf einen eigenen Code abgebildet", () => {
  assert.deepEqual(outcomeForResponse(200, { ok: true }), { ok: true });
  assert.equal(outcomeForResponse(413, { error: "Payload zu gross" }).code, "PAYLOAD_TOO_LARGE");
  assert.equal(outcomeForResponse(400, { error: "Ungültige Anfrage" }).code, "MALFORMED_REQUEST");
  assert.equal(outcomeForResponse(400, { error: "Ungültige Eingabe" }).code, "SCHEMA_REJECTED");
  assert.equal(outcomeForResponse(429, { error: "Zu viele Versuche" }).code, "RATE_LIMITED");
  assert.equal(outcomeForResponse(503, null).code, "SERVER_ERROR");
  assert.equal(outcomeForResponse(418, null).code, "UNEXPECTED_RESPONSE");
});

test("ein 400 ohne erklärenden Text gilt als abgelehnter Inhalt, nicht als unlesbarer Körper", () => {
  // Dieser Client serialisiert immer mit JSON.stringify — einen unlesbaren Körper kann er praktisch
  // nicht senden. Der frühere Standard schickte jeden unerklärten 400 in „wir haben Müll gesendet“
  // und damit den Benutzer an eine Stelle, an der er nichts tun kann.
  assert.equal(outcomeForResponse(400, null).code, "SCHEMA_REJECTED");
  assert.equal(outcomeForResponse(400, {}).code, "SCHEMA_REJECTED");
  assert.equal(outcomeForResponse(400, { error: "services[0].price ist nicht verwendbar" }).code, "SCHEMA_REJECTED");
  assert.equal(outcomeForResponse(400, { error: "Malformed JSON body" }).code, "MALFORMED_REQUEST", "nur eine ausdrückliche Aussage kehrt das um");
  assert.equal(outcomeForResponse(400, { error: "Ungültige Anfrage" }).code, "MALFORMED_REQUEST");
});

test("Retry-After wird als Sekunden und als Zeitpunkt gelesen — sonst gar nicht", () => {
  const now = Date.parse("2026-07-23T10:00:00.000Z");
  assert.equal(parseRetryAfter("120", now), 120_000);
  assert.equal(parseRetryAfter("  30 ", now), 30_000);
  assert.equal(parseRetryAfter("Thu, 23 Jul 2026 10:02:00 GMT", now), 120_000);
  assert.equal(parseRetryAfter("bald", now), null, "eine erfundene Wartezeit wäre schlimmer als keine");
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter(undefined, now), null);
  assert.equal(parseRetryAfter("0", now), null, "keine Wartezeit ist keine Aussage");
  assert.equal(parseRetryAfter("Thu, 23 Jul 2026 09:58:00 GMT", now), null, "ein vergangener Zeitpunkt auch nicht");
});

test("eine freundlich aussehende Antwort ohne ok:true gilt nicht als Erfolg", () => {
  assert.equal(outcomeForResponse(200, { success: true }).ok, false);
  assert.equal(outcomeForResponse(200, { ok: "true" }).code, "UNEXPECTED_RESPONSE");
  assert.equal(outcomeForResponse(200, null).code, "UNEXPECTED_RESPONSE");
});

test("die Nutzlast wird in UTF-8-Bytes gemessen, nicht in Zeichen", () => {
  assert.equal(payloadByteLength("abc"), 3);
  assert.equal(payloadByteLength("Zürich"), 7, "das Umlaut-Zeichen zählt doppelt");
  assert.equal(MAX_PUBLISH_PAYLOAD_BYTES, 262144);
});

// --- Netzweg ------------------------------------------------------------------------------------

test("der Client sendet POST mit JSON-Körper an den relativen Pfad", async () => {
  const calls = [];
  const outcome = await sendPublishIntent({ email: "a@b.ch", body: '{"email":"a@b.ch"}' }, {
    transport: async (url, init) => { calls.push({ url, init }); return jsonResponse(200, { ok: true }); },
  });
  assert.deepEqual(outcome, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PUBLISH_INTENT_PATH);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.body, '{"email":"a@b.ch"}');
});

test("ein Netzwerkfehler und eine Zeitüberschreitung sind zwei verschiedene Ergebnisse", async () => {
  const offline = await sendPublishIntent({ email: "a@b.ch", body: "{}" }, {
    transport: async () => { throw new TypeError("Failed to fetch"); },
  });
  assert.equal(offline.code, "NETWORK");

  const slow = await sendPublishIntent({ email: "a@b.ch", body: "{}" }, {
    timeoutMs: 5,
    transport: (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });
  assert.equal(slow.code, "TIMEOUT");
});

test("eine kaputte Antwort verwandelt einen sauberen Status nicht in einen Absturz", async () => {
  const outcome = await sendPublishIntent({ email: "a@b.ch", body: "{}" }, {
    transport: async () => ({ status: 429, text: async () => "<html>Too many requests</html>" }),
  });
  assert.equal(outcome.code, "RATE_LIMITED", "der Status trägt die Aussage, nicht der Körper");
});

test("der Client reicht Retry-After bis in das Ergebnis durch, und ein fehlender Kopf bleibt leer", async () => {
  const named = await sendPublishIntent({ email: "a@b.ch", body: "{}" }, {
    transport: async () => ({
      status: 429,
      text: async () => "",
      headers: { get: (name) => (String(name).toLowerCase() === "retry-after" ? "45" : null) },
    }),
  });
  assert.equal(named.code, "RATE_LIMITED");
  assert.equal(named.retryAfterMs, 45_000);

  const silent = await sendPublishIntent({ email: "a@b.ch", body: "{}" }, {
    transport: async () => ({ status: 429, text: async () => "" }),
  });
  assert.equal(silent.retryAfterMs, null, "ohne Kopf gibt es nichts zu versprechen");
});

test("eine zu grosse Nutzlast wird gar nicht erst hochgeladen", async () => {
  let called = false;
  const outcome = await sendPublishIntent({ email: "a@b.ch", body: "x".repeat(MAX_PUBLISH_PAYLOAD_BYTES + 1) }, {
    transport: async () => { called = true; return jsonResponse(200, { ok: true }); },
  });
  assert.equal(outcome.code, "PAYLOAD_TOO_LARGE");
  assert.equal(called, false, "die Grenze gilt vor dem Upload, nicht danach");
});

// --- Vorprüfung ---------------------------------------------------------------------------------

test("ein vollständiger Entwurf mit gültiger Adresse kommt durch die Vorprüfung", () => {
  const result = runPublishPreflight({ draft: publishableDraft(), email: " hallo@studio-miro.ch ", stamp: STAMP });
  assert.equal(result.ok, true);
  assert.equal(result.request.email, "hallo@studio-miro.ch", "die Adresse wird getrimmt übernommen");
  assert.deepEqual(JSON.parse(result.request.body).email, "hallo@studio-miro.ch");
  assert.equal(JSON.parse(result.request.body).draft.schemaVersion, 2);
  assert.ok(result.bytes > 0);
});

test("ohne Adresse und mit unbrauchbarer Adresse blockiert die Vorprüfung unterschiedlich", () => {
  const missing = runPublishPreflight({ draft: publishableDraft(), email: "   ", stamp: STAMP });
  assert.equal(missing.ok, false);
  assert.equal(missing.blocks[0].code, "EMAIL_MISSING");

  const invalid = runPublishPreflight({ draft: publishableDraft(), email: "kein-at-zeichen", stamp: STAMP });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.blocks[0].code, "EMAIL_INVALID");
});

test("ein offener Blocker aus der Mängelliste hält den Publish auf und benennt den ersten Eintrag", () => {
  const draft = publishableDraft();
  draft.salon = { ...draft.salon, name: "" };
  const result = runPublishPreflight({ draft, email: "hallo@studio-miro.ch", stamp: STAMP });
  assert.equal(result.ok, false);
  const block = result.blocks.find((entry) => entry.code === "READINESS_BLOCKED");
  assert.ok(block, "der Blocker muss den Publish-Weg führen");
  assert.ok(block.count >= 1);
  assert.equal(block.first.target.kind, "field", "der Eintrag trägt sein Sprungziel mit");
  assert.equal(block.first.target.field, "salon.name");
});

test("eine Nutzlast über 256 KB wird von der Vorprüfung abgefangen", () => {
  const draft = publishableDraft();
  draft.copy = { ...draft.copy, heroSubtitle: "x".repeat(MAX_PUBLISH_PAYLOAD_BYTES) };
  const result = runPublishPreflight({ draft, email: "hallo@studio-miro.ch", stamp: STAMP });
  assert.equal(result.ok, false);
  const block = result.blocks.find((entry) => entry.code === "PAYLOAD_TOO_LARGE");
  assert.ok(block);
  assert.equal(block.limit, MAX_PUBLISH_PAYLOAD_BYTES);
  assert.ok(block.bytes > MAX_PUBLISH_PAYLOAD_BYTES);
});

test("ein Blob im Entwurf blockiert den Publish, statt still verloren zu gehen", () => {
  const clean = publishableDraft();
  assert.deepEqual(findBinaryValues(clean), [], "heute liegen im Entwurf nur Referenzen");

  const withBlob = publishableDraft();
  withBlob.assets = [{
    localId: "asset-1", kind: "HERO", ownerClientId: null, fileName: "hero.jpg", mimeType: "image/jpeg",
    bytes: 10, width: null, height: null, alt: "", focalPoint: null, uploadedAssetId: null,
    // So etwas gehört nie in den Draft — der Vertrag ist textonly.
    blob: new Blob(["binary"]),
  }];
  const paths = findBinaryValues(withBlob);
  assert.equal(paths.length, 1);
  assert.match(paths[0], /assets\[0\]\.blob/);

  const result = runPublishPreflight({ draft: withBlob, email: "hallo@studio-miro.ch", stamp: STAMP });
  assert.equal(result.ok, false);
  assert.ok(result.blocks.some((entry) => entry.code === "BINARY_IN_DRAFT"));
});

test("ein Text, der wie ein data-Schema aussieht, bleibt Text und blockiert nichts", () => {
  // Der frühere Guard hat jeden Freitext mit „data:“ am Anfang dauerhaft gesperrt — ein Zustand ohne
  // Ausgang. Gefangen hat er dabei nie, wofür er gedacht war: normalizeDraftV2 wirft fremde Felder
  // längst vorher weg. Was ein langer data-Text wirklich riskiert, ist Grösse, und dafür gibt es
  // PAYLOAD_TOO_LARGE mit einer Meldung, die auch sagt, was zu tun ist.
  const draft = publishableDraft();
  draft.copy = { ...draft.copy, heroSubtitle: "data: unser neues Konzept" };
  draft.salon = { ...draft.salon, instagram: "data:image/png;base64,AAAA" };
  assert.deepEqual(findBinaryValues(draft), []);

  const result = runPublishPreflight({ draft, email: "hallo@studio-miro.ch", stamp: STAMP });
  assert.equal(result.ok, true, "sonst käme der Benutzer aus diesem Zustand nicht mehr heraus");
});

// --- Identität des abgeschickten Stands -----------------------------------------------------------

test("die Identität eines Entwurfs trennt Inhalte und überlebt den Weg durch JSON", () => {
  const draft = publishableDraft();
  const copy = structuredClone(draft);
  assert.deepEqual(draftIdentity(draft), draftIdentity(copy), "gleicher Inhalt, gleiche Identität");
  assert.equal(sameDraftIdentity(draftIdentity(draft), draftIdentity(copy)), true);

  copy.salon = { ...copy.salon, city: "Winterthur" };
  assert.equal(sameDraftIdentity(draftIdentity(draft), draftIdentity(copy)), false);

  // Gleiche Länge, andere Reihenfolge: eine reine Längenprüfung würde das nicht sehen.
  const left = structuredClone(draft); left.copy = { ...left.copy, heroTitle: "abcd" };
  const right = structuredClone(draft); right.copy = { ...right.copy, heroTitle: "dcba" };
  assert.equal(draftIdentity(left).length, draftIdentity(right).length);
  assert.notEqual(draftIdentity(left).fingerprint, draftIdentity(right).fingerprint);
});

test("eine beschädigte oder fremdgeformte Notiz gilt als keine Notiz", () => {
  const identity = draftIdentity(publishableDraft());
  const stored = JSON.parse(JSON.stringify({ at: "2026-07-23T10:00:00.000Z", ...identity }));
  assert.deepEqual(readDraftIdentity(stored), identity, "eine vollständige Notiz kommt unverändert zurück");

  assert.equal(readDraftIdentity(null), null);
  assert.equal(readDraftIdentity("nichts"), null);
  assert.equal(readDraftIdentity({ ...identity, draftId: "" }), null);
  assert.equal(readDraftIdentity({ ...identity, fingerprint: "zz" }), null);
  assert.equal(readDraftIdentity({ ...identity, length: "viel" }), null);
});

// --- Stempel ------------------------------------------------------------------------------------

test("der Stempel bindet an Revision und Generation", async () => {
  const repository = new MemoryDraftRepository();
  const draft = publishableDraft();
  await repository.putDraft(draft);
  const store = new BuilderStore(draft, repository, 0);

  assert.deepEqual(stampOf(store), { revision: 0, generation: 0 });
  store.mutate((next) => { next.salon.city = "Winterthur"; }, { intent: { type: "set-field", field: "salon.city" }, history: { label: "Ort" } });
  assert.deepEqual(stampOf(store), { revision: 1, generation: 0 });

  // Eine autoritative Ersetzung mit gleichem Inhalt bewegt die Revision nicht — die Generation schon.
  store.replace({ ...store.snapshot }, false, "reset");
  assert.equal(store.revision, 1, "gleicher Inhalt, also keine neue Revision");
  assert.equal(store.generation, 1, "aber ein anderer Entwurf");
  assert.equal(sameStamp({ revision: 1, generation: 0 }, stampOf(store)), false);
});

// --- Zustandsmaschine ---------------------------------------------------------------------------

function makeFlow(options = {}) {
  const draft = options.draft ?? publishableDraft();
  const state = { revision: 0, generation: 0 };
  const sent = [];
  const host = {
    readDraft: () => draft,
    readStamp: () => ({ ...state }),
    flush: options.flush ?? (async () => {}),
    send: options.send ?? (async (request) => { sent.push(request); return { ok: true }; }),
    now: options.now ?? (() => "2026-07-23T10:00:00.000Z"),
  };
  const flow = new PublishFlow(host);
  // Eine echte Änderung bewegt beides, genau wie im Store: den Inhalt und die Zähler.
  const editDraft = (change) => { change(draft); state.revision += 1; };
  return { flow, host, state, sent, draft, editDraft };
}

test("der Anfangszustand behauptet nichts", () => {
  assert.deepEqual(initialPublishState(), {
    phase: "ready", blocks: [], stopCode: null, stopDetail: null,
    submittedAt: null, submittedDraft: null, staleSinceSubmit: false,
    retryNotBefore: null, retryAfterMs: null, localCopySecured: false,
  });
});

test("der glückliche Weg endet bei „abgeschickt“, nicht bei „veröffentlicht“", async () => {
  const { flow, sent, draft } = makeFlow();
  const seen = [];
  flow.subscribe((state) => seen.push(state.phase));
  flow.setEmail("hallo@studio-miro.ch");

  const final = await flow.submit();
  assert.equal(final.phase, "submitted");
  assert.equal(final.submittedAt, "2026-07-23T10:00:00.000Z");
  assert.deepEqual(final.submittedDraft, draftIdentity(draft), "festgehalten wird der Inhalt, nicht ein Sitzungszähler");
  assert.equal(final.staleSinceSubmit, false);
  assert.equal(final.stopCode, null);
  assert.equal(sent.length, 1);
  assert.deepEqual(seen, ["ready", "checking", "sending", "submitted"]);
});

test("ein zweiter Klick während des Sendens schickt nicht ein zweites Mal", async () => {
  const sent = [];
  let resolveSend = () => {};
  const { flow } = makeFlow({
    send: (request) => new Promise((resolve) => { sent.push(request); resolveSend = () => resolve({ ok: true }); }),
  });
  flow.setEmail("hallo@studio-miro.ch");

  const first = flow.submit();
  // Direkt hinterher, während der erste Lauf noch prüft: der zweite Klick startet keinen Lauf.
  const second = flow.submit();
  assert.equal(flow.snapshot.phase, "checking", "der zweite Klick hat den ersten Lauf nicht zurückgesetzt");
  assert.equal((await second).phase, "checking", "der zweite Klick gibt nur den laufenden Zustand zurück");

  await tick();
  assert.equal(flow.snapshot.phase, "sending", "der erste Lauf ist jetzt wirklich unterwegs");
  const third = flow.submit();
  assert.equal((await third).phase, "sending");
  assert.equal(sent.length, 1, "der Rate-Limit ist adressunabhängig — ein Doppelklick darf keinen Versuch verbrennen");

  resolveSend();
  assert.equal((await first).phase, "submitted");
  assert.equal(sent.length, 1);
});

test("eine Mutation während des Vorgangs bricht den Publish ab, bevor etwas gesendet wird", async () => {
  const sent = [];
  const { flow, state } = makeFlow({
    // Der Nutzer tippt weiter, während der Entwurf lokal gesichert wird.
    flush: async () => { state.revision += 1; },
    send: async (request) => { sent.push(request); return { ok: true }; },
  });
  flow.setEmail("hallo@studio-miro.ch");

  const final = await flow.submit();
  assert.equal(final.phase, "failed");
  assert.equal(final.stopCode, "DRAFT_CHANGED");
  assert.equal(sent.length, 0, "abgebrochen heisst: nichts ging raus");
  assert.equal(final.submittedAt, null);
});

test("auch eine autoritative Ersetzung während des Vorgangs bricht ab", async () => {
  const sent = [];
  const { flow, state } = makeFlow({
    flush: async () => { state.generation += 1; },
    send: async (request) => { sent.push(request); return { ok: true }; },
  });
  flow.setEmail("hallo@studio-miro.ch");
  assert.equal((await flow.submit()).stopCode, "DRAFT_CHANGED");
  assert.equal(sent.length, 0);
});

test("jeder Fehlerzustand des Endpunkts landet einzeln in der Zustandsmaschine", async () => {
  for (const code of ["PAYLOAD_TOO_LARGE", "MALFORMED_REQUEST", "SCHEMA_REJECTED", "RATE_LIMITED", "SERVER_ERROR", "NETWORK", "TIMEOUT", "UNEXPECTED_RESPONSE"]) {
    const { flow } = makeFlow({ send: async () => ({ ok: false, code, status: null, detail: null }) });
    flow.setEmail("hallo@studio-miro.ch");
    const final = await flow.submit();
    assert.equal(final.phase, "failed", `${code} muss ein Fehlerzustand sein`);
    assert.equal(final.stopCode, code);
    assert.equal(final.submittedAt, null, `${code} darf keinen Versand behaupten`);
  }
});

test("nach einem Fehlschlag führt ein erneuter Versuch zum Erfolg", async () => {
  let attempt = 0;
  const { flow } = makeFlow({
    send: async () => {
      attempt += 1;
      return attempt === 1 ? { ok: false, code: "NETWORK", status: null, detail: null } : { ok: true };
    },
  });
  flow.setEmail("hallo@studio-miro.ch");

  assert.equal((await flow.submit()).stopCode, "NETWORK");
  const retried = await flow.submit();
  assert.equal(retried.phase, "submitted");
  assert.equal(retried.stopCode, null);
  assert.equal(attempt, 2);
});

test("ein offener Blocker führt in den Mängelzustand, ohne den Endpunkt zu berühren", async () => {
  const draft = publishableDraft();
  draft.salon = { ...draft.salon, name: "" };
  const sent = [];
  const { flow } = makeFlow({ draft, send: async (request) => { sent.push(request); return { ok: true }; } });
  flow.setEmail("hallo@studio-miro.ch");

  const final = await flow.submit();
  assert.equal(final.phase, "blocked");
  assert.ok(final.blocks.some((block) => block.code === "READINESS_BLOCKED"));
  assert.equal(sent.length, 0);
});

test("eine korrigierte Adresse räumt die alte Abweisung weg, einen Versand aber nicht", async () => {
  const { flow } = makeFlow();
  flow.setEmail("kaputt");
  assert.equal((await flow.submit()).phase, "blocked");

  flow.setEmail("hallo@studio-miro.ch");
  assert.equal(flow.snapshot.phase, "ready");
  assert.deepEqual(flow.snapshot.blocks, []);

  await flow.submit();
  flow.setEmail("anders@studio-miro.ch");
  assert.equal(flow.snapshot.phase, "submitted", "ein bereits abgeschickter Stand bleibt eine Tatsache");
});

test("eine Änderung nach dem Absenden markiert den abgeschickten Stand als überholt", async () => {
  const { flow, editDraft } = makeFlow();
  flow.setEmail("hallo@studio-miro.ch");
  await flow.submit();
  assert.equal(flow.snapshot.staleSinceSubmit, false);

  editDraft((draft) => { draft.salon.city = "Winterthur"; });
  flow.noteDraftChanged();
  assert.equal(flow.snapshot.phase, "submitted", "der Versand wird nicht rückwirkend zum Fehler");
  assert.equal(flow.snapshot.staleSinceSubmit, true, "spätere Änderungen erreichen das SaaS nicht mehr");
});

test("eine blosse Zählerbewegung ohne Inhaltsänderung meldet keinen überholten Stand", async () => {
  const { flow, state } = makeFlow();
  flow.setEmail("hallo@studio-miro.ch");
  await flow.submit();

  // Rückgängig und wieder vorwärts, ein Speicherlauf, ein Neuladen: die Revision wandert, der Inhalt
  // nicht. Genau hier hat die alte Prüfung den überzähligen Versand empfohlen.
  state.revision += 3;
  flow.noteDraftChanged();
  assert.equal(flow.snapshot.staleSinceSubmit, false, "was zählt, ist der Inhalt");
});

test("eine Änderung während des Fluges wird sofort als überholt gemeldet", async () => {
  let harness;
  harness = makeFlow({ send: async () => { harness.editDraft((draft) => { draft.salon.city = "Winterthur"; }); return { ok: true }; } });
  const sentIdentity = draftIdentity(harness.draft);
  harness.flow.setEmail("hallo@studio-miro.ch");

  const final = await harness.flow.submit();
  assert.equal(final.phase, "submitted", "die Anfrage ist raus — das lässt sich nicht zurücknehmen");
  assert.equal(final.staleSinceSubmit, true);
  assert.deepEqual(final.submittedDraft, sentIdentity, "abgeschickt wurde der Stand von vorher");
});

test("die Identität des gesendeten Stands wird vor dem Absenden festgehalten", async () => {
  let harness;
  // Zurücksetzen während des Fluges: ein völlig anderer Entwurf steht da, wenn die Antwort kommt.
  harness = makeFlow({ send: async () => { harness.editDraft((draft) => { draft.draftId = "draft-frisch"; }); return { ok: true }; } });
  const sentIdentity = draftIdentity(harness.draft);
  harness.flow.setEmail("hallo@studio-miro.ch");

  const accepted = await harness.flow.submit();
  assert.deepEqual(accepted.submittedDraft, sentIdentity, "die Notiz gehört dem Entwurf, der gesendet wurde");
  assert.equal(harness.flow.snapshot.phase, "ready", "der neue Entwurf erbt den Versand nicht");
  assert.equal(harness.flow.snapshot.submittedAt, null);
  assert.equal(harness.flow.snapshot.submittedDraft, null);
});

test("ein ausgetauschter Entwurf erbt den Versandzustand nicht", async () => {
  const harness = makeFlow();
  harness.flow.setEmail("hallo@studio-miro.ch");
  await harness.flow.submit();
  assert.equal(harness.flow.snapshot.phase, "submitted");

  harness.editDraft((draft) => { draft.draftId = "draft-fremd"; });
  harness.flow.noteDraftChanged();
  assert.equal(harness.flow.snapshot.phase, "ready", "ein anderer Entwurf hat keinen Versandzustand");
  assert.equal(harness.flow.snapshot.submittedAt, null);
  assert.equal(harness.flow.snapshot.submittedDraft, null);
  assert.equal(harness.flow.snapshot.staleSinceSubmit, false);
});

test("ein wiederhergestellter Versand nennt Zeitpunkt und Entwurf — und nur den eigenen", () => {
  const { flow, draft } = makeFlow();
  const earlier = draftIdentity(draft);
  draft.salon.city = "Winterthur";
  flow.restoreSubmission("2026-07-22T08:00:00.000Z", earlier);
  assert.equal(flow.snapshot.phase, "submitted");
  assert.equal(flow.snapshot.submittedAt, "2026-07-22T08:00:00.000Z");
  assert.equal(flow.snapshot.staleSinceSubmit, true, "seither wurde weitergearbeitet");

  const fremd = makeFlow();
  fremd.flow.restoreSubmission("2026-07-22T08:00:00.000Z", { ...draftIdentity(fremd.draft), draftId: "draft-fremd" });
  assert.equal(fremd.flow.snapshot.phase, "ready", "eine Notiz für einen anderen Entwurf wird gar nicht erst angelegt");
  assert.equal(fremd.flow.snapshot.submittedAt, null);
});

test("ein unveränderter Entwurf gilt nach der Wiederherstellung nicht als überholt", () => {
  const { flow, draft } = makeFlow();
  flow.restoreSubmission("2026-07-22T08:00:00.000Z", draftIdentity(draft));
  assert.equal(flow.snapshot.phase, "submitted");
  assert.equal(flow.snapshot.staleSinceSubmit, false, "eine frische Sitzung ist keine Änderung");
});

// --- Lokales Sichern, Sperrfrist -----------------------------------------------------------------

test("ein fehlgeschlagenes lokales Sichern ist ein eigener Zustand und kein Netzwerkfehler", async () => {
  const { flow, sent } = makeFlow({ flush: async () => { throw new Error("QuotaExceededError"); } });
  flow.setEmail("hallo@studio-miro.ch");

  const final = await flow.submit();
  assert.equal(final.phase, "failed");
  assert.equal(final.stopCode, "LOCAL_SAVE_FAILED");
  assert.equal(final.localCopySecured, false, "die Zusage „lokal gesichert“ hat hier keine Grundlage");
  assert.equal(final.stopDetail, "QuotaExceededError");
  assert.equal(sent.length, 0, "ohne gesicherte lokale Kopie geht nichts raus");
});

test("erst eine durchgelaufene Sicherung belegt die Zusage „lokal gesichert“", async () => {
  const { flow } = makeFlow({ send: async () => ({ ok: false, code: "NETWORK", status: null, detail: null }) });
  flow.setEmail("hallo@studio-miro.ch");
  const final = await flow.submit();
  assert.equal(final.stopCode, "NETWORK");
  assert.equal(final.localCopySecured, true, "die Sicherung lief vor dem Versuch durch");
});

test("nach 429 hält eine Sperrfrist den nächsten Versuch zurück, auch nach einem Tastendruck", async () => {
  let calls = 0;
  const { flow } = makeFlow({
    send: async () => { calls += 1; return { ok: false, code: "RATE_LIMITED", status: 429, detail: null, retryAfterMs: 120_000 }; },
  });
  flow.setEmail("hallo@studio-miro.ch");
  await flow.submit();
  assert.equal(flow.snapshot.stopCode, "RATE_LIMITED");
  assert.equal(flow.snapshot.retryAfterMs, 120_000, "was der Server sagt, wird übernommen");
  assert.equal(flow.rateLimited, true);

  flow.setEmail("hallo@studio-miro.chh");
  assert.equal(flow.snapshot.phase, "failed", "die Meldung bleibt stehen");
  assert.equal(flow.snapshot.stopCode, "RATE_LIMITED");

  await flow.submit();
  assert.equal(calls, 1, "die Sperrfrist lässt keinen zweiten Versuch durch");
});

test("ohne Retry-After gilt eine eigene, kurze Sperre — und keine erfundene Zeitangabe", async () => {
  const { flow } = makeFlow({ send: async () => ({ ok: false, code: "RATE_LIMITED", status: 429, detail: null }) });
  flow.setEmail("hallo@studio-miro.ch");
  await flow.submit();
  assert.equal(flow.snapshot.retryAfterMs, null, "der Server hat nichts gesagt");
  assert.equal(flow.rateLimited, true, "gesperrt wird trotzdem, damit kein Versuch verbrannt wird");
});

test("nach Ablauf der Sperrfrist wird der Versuch von selbst wieder freigegeben", async () => {
  let clock = Date.parse("2026-07-23T10:00:00.000Z");
  let calls = 0;
  const { flow } = makeFlow({
    now: () => new Date(clock).toISOString(),
    send: async () => { calls += 1; return { ok: false, code: "RATE_LIMITED", status: 429, detail: null, retryAfterMs: 60_000 }; },
  });
  flow.setEmail("hallo@studio-miro.ch");
  await flow.submit();

  flow.refreshRateLimit();
  assert.equal(flow.snapshot.retryNotBefore !== null, true, "vor Ablauf ändert sich nichts");

  clock += 61_000;
  flow.refreshRateLimit();
  assert.equal(flow.snapshot.retryNotBefore, null);
  assert.equal(flow.rateLimited, false);

  await flow.submit();
  assert.equal(calls, 2, "danach ist ein Versuch wieder erlaubt");
});

test("wirft der Wirt statt zu antworten, bleibt die Maschine nicht im Senden stecken", async () => {
  const { flow } = makeFlow({ send: async () => { throw new Error("kaputt"); } });
  flow.setEmail("hallo@studio-miro.ch");
  const final = await flow.submit();
  assert.equal(final.phase, "failed");
  assert.equal(final.stopCode, "NETWORK");
  assert.equal(flow.busy, false);
});
