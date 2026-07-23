import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bootEditor, click, keydown, type } from "./helpers/editor-dom.mjs";
import { createDefaultDraft } from "../assets/domain.js";
import { MAX_PUBLISH_PAYLOAD_BYTES, PUBLISH_INTENT_PATH } from "../assets/publish-contract.js";

// Die Publish-Oberfläche im echten DOM: echte Knöpfe, echte Felder, echte Delegation.
// Der Endpunkt ist immer ein Stub — kein Test berührt die echte Gegenstelle.

/** Lässt die angefangene Übergabe bis zur Antwort durchlaufen. */
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const ok = async () => ({ status: 200, text: async () => JSON.stringify({ ok: true }) });
const answering = (status, payload) => async () => ({ status, text: async () => JSON.stringify(payload) });
/** Eine 429-Antwort, wahlweise mit Retry-After im Kopf. */
const rateLimited = (retryAfter = null) => async () => ({
  status: 429,
  text: async () => JSON.stringify({ error: "Zu viele Versuche" }),
  headers: { get: (name) => (String(name).toLowerCase() === "retry-after" ? retryAfter : null) },
});

/** Eine Übergabe, die erst weiterläuft, wenn der Test sie freigibt. */
function gatedTransport() {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    transport: async () => { await gate; return { status: 200, text: async () => JSON.stringify({ ok: true }) }; },
    release: () => release(),
  };
}

/** Alles, was dieser Browser sich gemerkt hat — genau das, was ein Neuladen wiederfindet. */
const rememberedPreferences = (window) => Object.fromEntries(
  Object.keys(window.localStorage).map((key) => [key, window.localStorage.getItem(key)]),
);

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

// --- Ehrlichkeitspflichten -----------------------------------------------------------------------

test("der Erfolg behauptet weder ein Konto noch eine zugestellte E-Mail", async () => {
  const { document, cleanup } = await readyEditor({ publishTransport: ok });
  await submitWith({ document }, "hallo@studio-miro.ch");
  const text = statusText(document);

  assert.match(text, /Abgeschickt am/);
  assert.match(text, /Falls diese Adresse verwendbar ist/, "die konstante Antwort erlaubt keine Zusage");
  assert.match(text, /Postfach/, "der Weg führt über die E-Mail weiter");
  assert.doesNotMatch(text, /Konto (wurde )?(erstellt|angelegt)/i);
  assert.doesNotMatch(text, /E-Mail wurde (ver|zuge)schickt/i);
  assert.doesNotMatch(text, /veröffentlicht|ist online|ist live/i, "veröffentlicht wird erst nach der Aktivierung im SaaS");
  cleanup();
});

test("ein erfolgreicher Versand erfindet keine intentId und lässt den Draft-Vertrag unberührt", async () => {
  const { document, store, cleanup } = await readyEditor({ publishTransport: ok });
  const before = structuredClone(store.snapshot.publication);
  await submitWith({ document }, "hallo@studio-miro.ch");

  assert.deepEqual(store.snapshot.publication, before, "der Server gibt keine intentId zurück — also wird auch keine notiert");
  assert.equal(store.snapshot.publication.intentId, null);
  assert.equal(store.snapshot.publication.state, "LOCAL", "lokal ist bestätigt worden: nichts");
  assert.equal(store.snapshot.schemaVersion, 2);
  cleanup();
});

test("nach dem Absenden erfährt der Benutzer, dass spätere Änderungen nicht mehr drüben ankommen", async () => {
  const { document, cleanup } = await readyEditor({ publishTransport: ok });
  await submitWith({ document }, "hallo@studio-miro.ch");
  assert.doesNotMatch(statusText(document), /noch nicht drüben/i);

  type(document.querySelector('[data-bind="salon.tagline"]'), "Coiffeur in Winterthur");
  const text = statusText(document);
  assert.match(text, /noch nicht drüben/i, "sonst editiert der Benutzer weiter und wundert sich");
  assert.match(text, /Erneut senden/, "und er erfährt, wie er den neuen Stand nachreicht");
  assert.equal(publishButton(document).textContent, "Erneut senden");
  cleanup();
});

test("ein erneutes Senden nach einer Änderung räumt den Überholt-Hinweis wieder weg", async () => {
  const { document, publishCalls, cleanup } = await readyEditor({ publishTransport: ok });
  await submitWith({ document }, "hallo@studio-miro.ch");
  type(document.querySelector('[data-bind="salon.tagline"]'), "Coiffeur in Winterthur");
  assert.match(statusText(document), /noch nicht drüben/i);

  click(publishButton(document));
  await settle();
  assert.equal(publishCalls.length, 2);
  assert.equal(publishCalls[1].body.draft.salon.tagline, "Coiffeur in Winterthur", "übergeben wird der aktuelle Stand");
  assert.doesNotMatch(statusText(document), /noch nicht drüben/i);
  cleanup();
});

test("ein Versand aus einer früheren Sitzung überlebt den Neuladen und bleibt ehrlich", async () => {
  const first = await readyEditor({ publishTransport: ok });
  await submitWith({ document: first.document }, "hallo@studio-miro.ch");
  const draft = structuredClone(first.store.snapshot);
  const remembered = rememberedPreferences(first.window);
  first.cleanup();

  const second = await bootEditor({ draft, preferences: remembered, publishTransport: ok });
  click(second.document.querySelector('[data-panel-target="publish"]'));
  assert.match(statusText(second.document), /Abgeschickt am/);
  assert.match(statusText(second.document), /Falls diese Adresse verwendbar ist/);
  assert.equal(second.store.snapshot.publication.intentId, null, "auch über den Neustart wird nichts erfunden");
  second.cleanup();
});

// --- Wem der Versand gehört, und welchem Stand ----------------------------------------------------

test("nach dem Neuladen ohne eine einzige Änderung steht kein Überholt-Hinweis auf der Fläche", async () => {
  const first = await readyEditor({ publishTransport: ok });
  await submitWith({ document: first.document }, "hallo@studio-miro.ch");
  const draft = structuredClone(first.store.snapshot);
  const remembered = rememberedPreferences(first.window);
  first.cleanup();

  const second = await bootEditor({ draft, preferences: remembered, publishTransport: ok });
  click(second.document.querySelector('[data-panel-target="publish"]'));
  assert.match(statusText(second.document), /Abgeschickt am/);
  assert.doesNotMatch(
    statusText(second.document),
    /noch nicht drüben/i,
    "es wurde nichts geändert — ein Überholt-Hinweis würde hier zu einem überzähligen Versand raten",
  );
  second.cleanup();
});

test("nach dem Neuladen meldet die erste echte Änderung den Überholt-Hinweis", async () => {
  const first = await readyEditor({ publishTransport: ok });
  await submitWith({ document: first.document }, "hallo@studio-miro.ch");
  const draft = structuredClone(first.store.snapshot);
  const remembered = rememberedPreferences(first.window);
  first.cleanup();

  const second = await bootEditor({ draft, preferences: remembered, publishTransport: ok });
  click(second.document.querySelector('[data-panel-target="publish"]'));
  type(second.document.querySelector('[data-bind="salon.tagline"]'), "Coiffeur in Winterthur");
  assert.match(
    statusText(second.document),
    /noch nicht drüben/i,
    "der Stand auf dem Schirm ist nicht mehr der übergebene, und das muss gesagt werden",
  );
  second.cleanup();
});

test("ein Zurücksetzen während des Fluges heftet den Versand nicht an den neuen Entwurf", async () => {
  const gate = gatedTransport();
  const booted = await readyEditor({ publishTransport: gate.transport });
  type(booted.document.getElementById("publishEmail"), "hallo@studio-miro.ch");
  click(publishButton(booted.document));
  await settle();
  assert.match(statusText(booted.document), /Wird übergeben/, "die Anfrage hängt jetzt wirklich in der Luft");

  // Zurücksetzen: ein frischer Entwurf mit eigener draftId nimmt den Platz ein, während gesendet wird.
  booted.store.replace(createDefaultDraft("2026-07-23T11:00:00.000Z"), false, "reset");
  gate.release();
  await settle();

  assert.doesNotMatch(statusText(booted.document), /Abgeschickt am/, "der frische Entwurf hat nichts abgeschickt");
  const draft = structuredClone(booted.store.snapshot);
  const remembered = rememberedPreferences(booted.window);
  booted.cleanup();

  const second = await bootEditor({ draft, preferences: remembered, publishTransport: ok });
  click(second.document.querySelector('[data-panel-target="publish"]'));
  assert.doesNotMatch(statusText(second.document), /Abgeschickt am/, "und behauptet es auch nach dem Neuladen nicht");
  second.cleanup();
});

test("ein ausgetauschter Entwurf erbt den Versand des vorherigen nicht", async () => {
  const { document, store, window, cleanup } = await readyEditor({ publishTransport: ok });
  await submitWith({ document }, "hallo@studio-miro.ch");
  assert.match(statusText(document), /Abgeschickt am/);

  store.replace(createDefaultDraft("2026-07-23T11:00:00.000Z"), false, "import");
  assert.doesNotMatch(statusText(document), /Abgeschickt am/, "eine Notiz gehört genau einem Entwurf");
  assert.doesNotMatch(statusText(document), /hallo@studio-miro\.ch/);

  const draft = structuredClone(store.snapshot);
  const remembered = rememberedPreferences(window);
  cleanup();

  const second = await bootEditor({ draft, preferences: remembered, publishTransport: ok });
  click(second.document.querySelector('[data-panel-target="publish"]'));
  assert.doesNotMatch(statusText(second.document), /Abgeschickt am/, "auch der Neustart erbt ihn nicht");
  second.cleanup();
});

// --- Ein lokaler Speicherfehler ist kein Netzwerkfehler --------------------------------------------

test("ein fehlgeschlagenes lokales Sichern wird nicht als Verbindungsproblem gemeldet", async () => {
  const { document, repository, publishCalls, cleanup } = await readyEditor({ publishTransport: ok });
  repository.putDraft = async () => { throw new Error("QuotaExceededError"); };
  await submitWith({ document }, "hallo@studio-miro.ch");

  assert.equal(publishCalls.length, 0, "ohne gesicherte lokale Kopie geht nichts raus");
  assert.doesNotMatch(statusText(document), /Keine Verbindung/, "das Netz war nie das Problem");
  assert.doesNotMatch(
    statusText(document),
    /lokal (gespeichert|gesichert)/i,
    "genau hier darf die gefährlichste Zusage der Fläche nicht fallen",
  );
  assert.match(statusText(document), /konnte nicht gesichert werden/i);
  assert.equal(document.getElementById("publishRetry").hidden, false, "auch dieser Zustand bietet einen Ausweg an");
  cleanup();
});

test("ein echter Netzwerkfehler darf die lokale Sicherung weiterhin zusagen", async () => {
  const { document, cleanup } = await readyEditor({ publishTransport: async () => { throw new TypeError("Failed to fetch"); } });
  await submitWith({ document }, "hallo@studio-miro.ch");
  assert.match(statusText(document), /Keine Verbindung/);
  assert.match(statusText(document), /lokal gesichert/i, "hier ist die Zusage belegt: die Sicherung lief vor dem Versuch durch");
  cleanup();
});

// --- Nach 429: eine Sperrfrist, die ein Tastendruck nicht aufhebt -----------------------------------

test("nach einer 429-Antwort geht ein sofortiger zweiter Versuch nicht mehr raus", async () => {
  const { document, publishCalls, cleanup } = await readyEditor({ publishTransport: rateLimited() });
  await submitWith({ document }, "hallo@studio-miro.ch");
  assert.equal(publishCalls.length, 1);
  assert.match(statusText(document), /Zu viele Versuche/);

  click(document.getElementById("publishRetry"));
  click(publishButton(document));
  await settle();
  assert.equal(publishCalls.length, 1, "die Sperrfrist lässt keinen zweiten Versuch durch");
  assert.equal(publishButton(document).disabled, true, "und der Knopf sagt das auch");
  cleanup();
});

test("eine Tippfehlerkorrektur hebt die 429-Sperre nicht auf", async () => {
  const { document, cleanup } = await readyEditor({ publishTransport: rateLimited() });
  await submitWith({ document }, "hallo@studio-miro.ch");
  assert.match(statusText(document), /Zu viele Versuche/);

  type(document.getElementById("publishEmail"), "hallo@studio-miro.chh");
  assert.match(statusText(document), /Zu viele Versuche/, "ein Tastendruck ist keine Entsperrung");
  assert.doesNotMatch(statusText(document), /^Bereit/, "„Bereit“ wäre hier schlicht falsch");
  cleanup();
});

test("ein Retry-After aus der Antwort wird konkret genannt", async () => {
  const { document, cleanup } = await readyEditor({ publishTransport: rateLimited("120") });
  await submitWith({ document }, "hallo@studio-miro.ch");
  assert.match(statusText(document), /2 Minuten/, "wenn der Server eine Zeit nennt, wird sie genannt");
  cleanup();
});

test("ohne Retry-After verspricht die Fläche keine Wartezeit", async () => {
  const { document, cleanup } = await readyEditor({ publishTransport: rateLimited() });
  await submitWith({ document }, "hallo@studio-miro.ch");
  assert.match(statusText(document), /sagt der Server nicht/);
  assert.doesNotMatch(statusText(document), /\d+\s*(Sekunden?|Minuten?)/, "eine erfundene Wartezeit wäre schlimmer als keine");
  cleanup();
});

// --- Kein Zustand ohne Ausgang ---------------------------------------------------------------------

test("ein „data:“-Text im Freitext blockiert den Versand nicht", async () => {
  const { document, publishCalls, cleanup } = await readyEditor({ publishTransport: ok });
  type(document.querySelector('[data-bind="copy.heroSubtitle"]'), "data: unser neues Konzept");
  click(document.querySelector('[data-panel-target="publish"]'));
  await submitWith({ document }, "hallo@studio-miro.ch");

  assert.equal(publishCalls.length, 1, "Freitext ist Text — aus diesem Zustand gab es vorher kein Entrinnen");
  assert.equal(publishCalls[0].body.draft.copy.heroSubtitle, "data: unser neues Konzept");
  assert.match(statusText(document), /Abgeschickt/);
  cleanup();
});

test("Enter im Adressfeld schickt ab", async () => {
  const { document, publishCalls, cleanup } = await readyEditor({ publishTransport: ok });
  const email = document.getElementById("publishEmail");
  type(email, "hallo@studio-miro.ch");
  keydown(email, "Enter");
  await settle();

  assert.equal(publishCalls.length, 1, "die Taste, die man dort drückt, tut auch etwas");
  assert.match(statusText(document), /Abgeschickt/);
  cleanup();
});

test("der Topbar-Knopf des offenen Bereichs trägt eine Auszeichnung, für die es auch eine Regel gibt", async () => {
  const { document, cleanup } = await bootEditor();
  const topbarButton = document.querySelector('.topbar__actions [data-panel-target="publish"]');
  click(topbarButton);
  assert.match(topbarButton.className, /is-active/);
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.button\.is-active\s*\{/, "eine Klasse ohne Regel ist eine Auszeichnung ohne Wirkung");
  cleanup();
});

test("die Mängelliste verspricht keine Exportsperre und nennt die echte Folge offener Punkte", async () => {
  const { document, cleanup } = await readyEditor();
  type(document.querySelector('[data-bind="salon.name"]'), "");
  click(document.querySelector('[data-panel-target="publish"]'));
  const summary = document.getElementById("readinessSummary").textContent;

  assert.doesNotMatch(summary, /exportier/i, "der Export war nie gesperrt und ist es weiterhin nicht");
  assert.match(summary, /wird nichts übergeben/, "was gesagt wird, wird auch durchgesetzt");
  cleanup();
});
