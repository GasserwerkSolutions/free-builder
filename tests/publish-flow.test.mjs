import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultDraft } from "../assets/domain.js";
import { MemoryDraftRepository } from "../assets/persistence.js";
import { BuilderStore } from "../assets/store.js";
import {
  MAX_PUBLISH_PAYLOAD_BYTES,
  PUBLISH_INTENT_PATH,
  outcomeForResponse,
  payloadByteLength,
} from "../assets/publish-contract.js";
import { publishEndpoint, sendPublishIntent } from "../assets/publish-client.js";
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

test("auch eine eingebettete data-URL gilt als Binärinhalt", () => {
  const draft = publishableDraft();
  draft.salon = { ...draft.salon, instagram: "data:image/png;base64,AAAA" };
  assert.deepEqual(findBinaryValues(draft), ["salon.instagram"]);
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
    now: () => options.now ?? "2026-07-23T10:00:00.000Z",
  };
  const flow = new PublishFlow(host);
  return { flow, host, state, sent, draft };
}

test("der Anfangszustand behauptet nichts", () => {
  assert.deepEqual(initialPublishState(), {
    phase: "ready", blocks: [], stopCode: null, stopDetail: null,
    submittedAt: null, submittedRevision: null, staleSinceSubmit: false,
  });
});

test("der glückliche Weg endet bei „abgeschickt“, nicht bei „veröffentlicht“", async () => {
  const { flow, sent } = makeFlow();
  const seen = [];
  flow.subscribe((state) => seen.push(state.phase));
  flow.setEmail("hallo@studio-miro.ch");

  const final = await flow.submit();
  assert.equal(final.phase, "submitted");
  assert.equal(final.submittedAt, "2026-07-23T10:00:00.000Z");
  assert.equal(final.submittedRevision, 0);
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
  const { flow, state } = makeFlow();
  flow.setEmail("hallo@studio-miro.ch");
  await flow.submit();
  assert.equal(flow.snapshot.staleSinceSubmit, false);

  state.revision += 1;
  flow.noteDraftChanged();
  assert.equal(flow.snapshot.phase, "submitted", "der Versand wird nicht rückwirkend zum Fehler");
  assert.equal(flow.snapshot.staleSinceSubmit, true, "spätere Änderungen erreichen das SaaS nicht mehr");
});

test("eine Änderung während des Fluges wird sofort als überholt gemeldet", async () => {
  const { flow, state } = makeFlow({ send: async () => { state.revision += 1; return { ok: true }; } });
  flow.setEmail("hallo@studio-miro.ch");
  const final = await flow.submit();
  assert.equal(final.phase, "submitted", "die Anfrage ist raus — das lässt sich nicht zurücknehmen");
  assert.equal(final.staleSinceSubmit, true);
  assert.equal(final.submittedRevision, 0, "abgeschickt wurde der Stand von vorher");
});

test("ein wiederhergestellter Versand aus einer früheren Sitzung nennt nur Zeitpunkt und Revision", () => {
  const { flow, state } = makeFlow();
  state.revision = 4;
  flow.restoreSubmission("2026-07-22T08:00:00.000Z", 2);
  assert.equal(flow.snapshot.phase, "submitted");
  assert.equal(flow.snapshot.submittedAt, "2026-07-22T08:00:00.000Z");
  assert.equal(flow.snapshot.staleSinceSubmit, true);
});

test("wirft der Wirt statt zu antworten, bleibt die Maschine nicht im Senden stecken", async () => {
  const { flow } = makeFlow({ send: async () => { throw new Error("kaputt"); } });
  flow.setEmail("hallo@studio-miro.ch");
  const final = await flow.submit();
  assert.equal(final.phase, "failed");
  assert.equal(final.stopCode, "NETWORK");
  assert.equal(flow.busy, false);
});
