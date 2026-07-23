import test from "node:test";
import assert from "node:assert/strict";
import { bootEditor, click, type } from "./helpers/editor-dom.mjs";
import { MAX_PUBLISH_PAYLOAD_BYTES, PUBLISH_INTENT_PATH } from "../assets/publish-contract.js";

// Die Publish-Oberfläche im echten DOM: echte Knöpfe, echte Felder, echte Delegation.
// Der Endpunkt ist immer ein Stub — kein Test berührt die echte Gegenstelle.

/** Lässt die angefangene Übergabe bis zur Antwort durchlaufen. */
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const ok = async () => ({ status: 200, text: async () => JSON.stringify({ ok: true }) });
const answering = (status, payload) => async () => ({ status, text: async () => JSON.stringify(payload) });

const statusText = (document) => document.getElementById("publishStatus").textContent;
const publishButton = (document) => document.getElementById("publishButton");

/** Ein Entwurf, an dem nichts mehr offen ist: der Standardentwurf plus eine buchbare Person. */
async function readyEditor(options = {}) {
  const booted = await bootEditor(options);
  booted.store.replace({
    ...booted.store.snapshot,
    staff: [{
      clientId: "staff-1", name: "Anna Muster", email: "", role: "Coiffeuse", bio: "",
      specialties: [], active: true,
      serviceClientIds: booted.store.snapshot.services.map((service) => service.clientId),
      workingHours: booted.store.snapshot.businessHours.map((day) => ({ ...day, ranges: day.ranges.map((range) => ({ ...range })) })),
      portraitAssetLocalId: null,
    }],
  }, false, "import");
  click(booted.document.querySelector('[data-panel-target="publish"]'));
  return booted;
}

async function submitWith(booted, address) {
  type(booted.document.getElementById("publishEmail"), address);
  click(publishButton(booted.document));
  await settle();
}

// --- Rangfolge der Aktionen ---------------------------------------------------------------------

test("„Website veröffentlichen“ ist die Hauptaktion, der HTML-Export ist nachgeordnet", async () => {
  const { document, cleanup } = await bootEditor();
  const topbar = document.querySelector(".topbar__actions");
  assert.equal(topbar.querySelector('[data-action="export"]'), null, "der Export ist nicht mehr der Abschluss des Builders");
  assert.equal(topbar.querySelector('[data-panel-target="publish"]').textContent, "Website veröffentlichen");

  const panel = document.querySelector('[data-panel="publish"]');
  const primary = panel.querySelector(".button--primary");
  assert.equal(primary.dataset.publishAction, "submit");
  assert.match(primary.textContent, /veröffentlichen/i);

  const exportButton = panel.querySelector('[data-action="export"]');
  assert.ok(exportButton, "erreichbar bleibt er");
  assert.ok(exportButton.closest("details"), "aber eingeklappt, nicht als Produktziel");
  assert.match(exportButton.className, /button--quiet/);
  cleanup();
});

test("die Publish-Fläche fragt nach einer E-Mail-Adresse und hält einen Platz für Bilder frei", async () => {
  const { document, cleanup } = await bootEditor();
  const email = document.getElementById("publishEmail");
  assert.equal(email.type, "email");
  assert.equal(email.getAttribute("autocomplete"), "email");
  const assets = document.getElementById("publishAssetStep");
  assert.ok(assets, "der Schritt „lokale Assets nach Auth hochladen“ hat strukturell einen Ort");
  assert.equal(assets.hidden, true, "heute gibt es keine lokalen Bilder, also zeigt er auch nichts");
  cleanup();
});

// --- Mängelliste führt den Weg -------------------------------------------------------------------

test("ein offener Blocker hält den Versand auf und führt zum zuständigen Feld", async () => {
  const { document, publishCalls, cleanup } = await readyEditor();
  type(document.querySelector('[data-bind="salon.name"]'), "");
  click(document.querySelector('[data-panel-target="publish"]'));

  await submitWith({ document }, "hallo@studio-miro.ch");
  assert.equal(publishCalls.length, 0, "mit offenen Blockern wird kein Versuch verbrannt");
  assert.match(statusText(document), /Noch nicht abgeschickt/);
  assert.match(statusText(document), /offen/);

  const jump = document.querySelector("#publishStatus [data-editor-target]");
  assert.ok(jump, "der Blocker trägt sein Sprungziel mit");
  click(jump);
  assert.equal(document.querySelector('[data-panel="salon"]').hidden, false, "der Sprung öffnet den zuständigen Bereich");
  assert.equal(document.activeElement.dataset.bind, "salon.name");
  cleanup();
});

test("eine fehlende und eine unbrauchbare Adresse werden unterschiedlich beantwortet", async () => {
  const { document, cleanup } = await readyEditor();
  click(publishButton(document));
  await settle();
  assert.match(statusText(document), /Trag deine E-Mail-Adresse ein/);
  assert.equal(document.activeElement.id, "publishEmail", "der Fokus landet dort, wo die Korrektur passiert");

  await submitWith({ document }, "kein-at-zeichen");
  assert.match(statusText(document), /Tippfehler/);
  cleanup();
});

// --- Der glückliche Weg --------------------------------------------------------------------------

test("ein erfolgreicher Versand übergibt Adresse und Entwurf an den relativen Pfad", async () => {
  const { document, publishCalls, cleanup } = await readyEditor({ publishTransport: ok });
  await submitWith({ document }, "hallo@studio-miro.ch");

  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].url, PUBLISH_INTENT_PATH, "relativ — die Auslieferung ist same-origin");
  assert.equal(publishCalls[0].init.method, "POST");
  assert.equal(publishCalls[0].body.email, "hallo@studio-miro.ch");
  assert.equal(publishCalls[0].body.draft.schemaVersion, 2);
  assert.equal(publishCalls[0].body.draft.salon.name, "Studio Miro");
  cleanup();
});

test("ein Doppelklick schickt den Entwurf nicht zweimal", async () => {
  const { document, publishCalls, cleanup } = await readyEditor({ publishTransport: ok });
  type(document.getElementById("publishEmail"), "hallo@studio-miro.ch");
  click(publishButton(document));
  click(publishButton(document));
  click(publishButton(document));
  await settle();

  assert.equal(publishCalls.length, 1, "der Rate-Limit ist adressunabhängig — ein Doppelklick darf keinen Versuch kosten");
  assert.match(statusText(document), /Abgeschickt/);
  cleanup();
});

test("eine Änderung direkt nach dem Klick bricht den Vorgang ab, bevor etwas rausgeht", async () => {
  const { document, publishCalls, cleanup } = await readyEditor({ publishTransport: ok });
  type(document.getElementById("publishEmail"), "hallo@studio-miro.ch");
  click(publishButton(document));
  // Der Nutzer tippt weiter, während der Entwurf noch lokal gesichert wird.
  type(document.querySelector('[data-bind="salon.tagline"]'), "Coiffeur in Winterthur");
  await settle();

  assert.equal(publishCalls.length, 0, "abgebrochen heisst: nichts ging raus");
  assert.match(statusText(document), /Abgebrochen/);
  assert.match(statusText(document), /nichts angekommen/);
  cleanup();
});

// --- Fehlerzustände, jeder einzeln ----------------------------------------------------------------

const FAILURES = [
  { name: "413", transport: answering(413, { error: "Payload zu gross" }), expect: /Zu gross für die Übergabe/ },
  { name: "400 Ungültige Anfrage", transport: answering(400, { error: "Ungültige Anfrage" }), expect: /konnte die Anfrage nicht lesen/ },
  { name: "400 Ungültige Eingabe", transport: answering(400, { error: "Ungültige Eingabe" }), expect: /Inhalt abgelehnt/ },
  { name: "429", transport: answering(429, { error: "Zu viele Versuche" }), expect: /Zu viele Versuche/ },
  { name: "500", transport: answering(500, {}), expect: /Der Server hatte ein Problem/ },
  { name: "Netzwerkfehler", transport: async () => { throw new TypeError("Failed to fetch"); }, expect: /Keine Verbindung/ },
  {
    name: "Zeitüberschreitung",
    transport: async () => { const error = new Error("abgebrochen"); error.name = "AbortError"; throw error; },
    expect: /Keine Antwort in der erwarteten Zeit/,
  },
];

for (const failure of FAILURES) {
  test(`der Fehlerfall ${failure.name} bekommt eine eigene, handlungsleitende Meldung`, async () => {
    const { document, cleanup } = await readyEditor({ publishTransport: failure.transport });
    await submitWith({ document }, "hallo@studio-miro.ch");

    assert.match(statusText(document), failure.expect);
    assert.doesNotMatch(statusText(document), /Abgeschickt am/, "ein Fehlschlag darf keinen Versand behaupten");
    assert.equal(document.getElementById("publishRetry").hidden, false, "jeder Fehlschlag bietet einen erneuten Versuch an");
    cleanup();
  });
}

test("alle Fehlermeldungen unterscheiden sich voneinander", async () => {
  const seen = new Set();
  for (const failure of FAILURES) {
    const { document, cleanup } = await readyEditor({ publishTransport: failure.transport });
    await submitWith({ document }, "hallo@studio-miro.ch");
    const message = statusText(document);
    assert.equal(seen.has(message), false, `„${failure.name}“ wiederholt eine bestehende Meldung`);
    assert.ok(message.length > 60, "eine Meldung ohne Handlungsanweisung ist für den Benutzer wertlos");
    seen.add(message);
    cleanup();
  }
});

test("nach einem Fehlschlag führt der erneute Versuch zum Erfolg", async () => {
  let attempt = 0;
  const transport = async () => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("Failed to fetch");
    return { status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  const { document, publishCalls, cleanup } = await readyEditor({ publishTransport: transport });
  await submitWith({ document }, "hallo@studio-miro.ch");
  assert.match(statusText(document), /Keine Verbindung/);

  click(document.getElementById("publishRetry"));
  await settle();
  assert.match(statusText(document), /Abgeschickt/);
  assert.equal(document.getElementById("publishRetry").hidden, true);
  assert.equal(publishCalls.length, 2);
  cleanup();
});

test("eine zu grosse Nutzlast wird gemeldet, ohne den Endpunkt zu belasten", async () => {
  const { document, store, publishCalls, cleanup } = await readyEditor({ publishTransport: ok });
  store.replace({ ...store.snapshot, copy: { ...store.snapshot.copy, heroSubtitle: "x".repeat(MAX_PUBLISH_PAYLOAD_BYTES) } }, false, "import");
  await submitWith({ document }, "hallo@studio-miro.ch");

  assert.equal(publishCalls.length, 0);
  assert.match(statusText(document), /zu gross/);
  assert.match(statusText(document), /256 KB/);
  cleanup();
});
