import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bootEditor, clearToast, click, keydown, pointer, stackRects, toastText, type } from "./helpers/editor-dom.mjs";
import { PREVIEW_CHANNEL, PREVIEW_PROTOCOL_VERSION } from "../assets/preview-contract.js";

// Die Bedienung, auf der Ebene, auf der sie lebt: echte Knöpfe, echte Tasten, echte Zeiger.

const serviceCards = (document) => [...document.querySelectorAll("[data-service-card]")];
const serviceIds = (store) => store.snapshot.services.map((service) => service.clientId);
const cardIds = (document) => serviceCards(document).map((card) => card.dataset.serviceId);
const handleOf = (card) => card.querySelector("[data-reorder-handle]");

// --- Undo und Redo ----------------------------------------------------------------------------

test("die Historienknöpfe sind erst nach einer Änderung bedienbar und benennen den Schritt", async () => {
  const { document, store, cleanup } = await bootEditor();
  const undoButton = document.getElementById("undoButton");
  const redoButton = document.getElementById("redoButton");
  assert.equal(undoButton.disabled, true, "am Anfang gibt es nichts rückgängig zu machen");
  assert.equal(redoButton.disabled, true);

  type(document.querySelector('[data-bind="salon.city"]'), "Winterthur");
  assert.equal(undoButton.disabled, false);
  assert.match(undoButton.title, /Rückgängig: Salonangabe angepasst/);
  assert.match(undoButton.getAttribute("aria-label"), /Strg oder Cmd \+ Z/);

  click(undoButton);
  assert.equal(store.snapshot.salon.city, "Zürich");
  assert.equal(document.querySelector('[data-bind="salon.city"]').value, "Zürich", "die Oberfläche folgt dem Entwurf");
  assert.match(toastText(document), /wurde rückgängig gemacht/);
  assert.equal(undoButton.disabled, true);
  assert.equal(redoButton.disabled, false);
  assert.match(redoButton.title, /Wiederholen: Salonangabe angepasst/);

  click(redoButton);
  assert.equal(store.snapshot.salon.city, "Winterthur");
  assert.equal(document.querySelector('[data-bind="salon.city"]').value, "Winterthur");
  assert.match(toastText(document), /wurde wiederhergestellt/);
  cleanup();
});

test("ein Undo führt zurück zu dem Feld, um das es ging", async () => {
  const { document, store, cleanup } = await bootEditor();
  click(document.querySelector('[data-action="add-service"]'));
  const created = store.snapshot.services.at(-1).clientId;
  click(document.querySelector('[data-panel-target="design"]'));

  click(document.getElementById("undoButton"));
  assert.equal(store.snapshot.services.some((service) => service.clientId === created), false);
  assert.equal(document.querySelector('[data-panel="services"]').hidden, false, "der zuständige Bereich ist wieder offen");
  cleanup();
});

test("Strg + Z ausserhalb eines Textfelds macht rückgängig, Umschalt + Strg + Z stellt wieder her", async () => {
  const { document, store, cleanup } = await bootEditor();
  type(document.querySelector('[data-bind="salon.city"]'), "Winterthur");

  const outside = document.getElementById("undoButton");
  outside.focus();
  const undoEvent = keydown(outside, "z", { ctrlKey: true });
  assert.equal(store.snapshot.salon.city, "Zürich");
  assert.equal(undoEvent.defaultPrevented, true, "der Browser darf daraus nichts eigenes machen");

  keydown(outside, "z", { ctrlKey: true, shiftKey: true });
  assert.equal(store.snapshot.salon.city, "Winterthur");
  // Auf Windows ist Strg + Y die zweite gelernte Wiederholen-Taste.
  keydown(outside, "z", { ctrlKey: true });
  keydown(outside, "y", { ctrlKey: true });
  assert.equal(store.snapshot.salon.city, "Winterthur");
  cleanup();
});

test("im Textfeld bleibt Strg + Z beim Browser und beisst sich nicht mit dem Editor", async () => {
  const { document, store, cleanup } = await bootEditor();
  const input = document.querySelector('[data-bind="salon.city"]');
  type(input, "Winterthur");
  const revision = store.revision;

  input.focus();
  const event = keydown(input, "z", { ctrlKey: true });
  assert.equal(event.defaultPrevented, false, "die Texthistorie des Browsers bleibt unangetastet");
  assert.equal(store.snapshot.salon.city, "Winterthur", "der Entwurf wird nicht hinter dem Feld zurückgedreht");
  assert.equal(store.revision, revision);

  // Dasselbe gilt für den mehrzeiligen Text; eine Checkbox hat dagegen keine eigene Texthistorie.
  const textarea = document.querySelector('[data-bind="copy.heroTitle"]');
  textarea.focus();
  assert.equal(keydown(textarea, "z", { ctrlKey: true }).defaultPrevented, false);
  const checkbox = document.querySelector('[data-bind="testimonials.enabled"]');
  checkbox.focus();
  assert.equal(keydown(checkbox, "z", { ctrlKey: true }).defaultPrevented, true);
  cleanup();
});

// --- Umsortieren ------------------------------------------------------------------------------

test("Leistungen lassen sich per Pfeilknopf umsortieren, und der Schritt ist umkehrbar", async () => {
  const { document, store, cleanup } = await bootEditor();
  const before = serviceIds(store);
  const movedName = store.snapshot.services[0].name;

  click(serviceCards(document)[0].querySelector('[data-reorder-direction="down"]'));
  assert.deepEqual(serviceIds(store), [before[1], before[0], before[2]]);
  assert.deepEqual(cardIds(document), serviceIds(store), "die Liste zeigt die neue Reihenfolge");
  assert.equal(serviceCards(document)[0].querySelector("[data-service-number]").textContent, `1. ${store.snapshot.services[0].name}`);
  assert.equal(toastText(document), null, "eine Umsortierung ist kein Fehlerfall");

  // Der Schritt läuft über die geprüfte Mutationsschicht, also ist er wie jede andere Änderung umkehrbar.
  assert.equal(store.nextUndoAction.label, `Leistung „${movedName}“ verschoben`);
  assert.deepEqual(store.nextUndoAction.target, { kind: "service", serviceClientId: before[0], field: "name" });
  click(document.getElementById("undoButton"));
  assert.deepEqual(serviceIds(store), before);
  assert.deepEqual(cardIds(document), before);
  cleanup();
});

test("die Pfeilknöpfe sind an den Rändern gesperrt und der Griff bei einer einzelnen Karte", async () => {
  const { document, store, cleanup } = await bootEditor();
  const cards = serviceCards(document);
  assert.equal(cards[0].querySelector('[data-reorder-direction="up"]').disabled, true);
  assert.equal(cards[0].querySelector('[data-reorder-direction="down"]').disabled, false);
  assert.equal(cards.at(-1).querySelector('[data-reorder-direction="down"]').disabled, true);
  assert.match(cards[0].querySelector('[data-reorder-direction="down"]').getAttribute("aria-label"), /^Leistung .* nach unten$/);

  click(document.querySelector('[data-panel-target="voices"]'));
  click(document.querySelector('[data-action="add-testimonial"]'));
  const only = document.querySelector("[data-testimonial-card]");
  assert.equal(handleOf(only).disabled, true, "eine einzelne Karte kann nirgendwo hin");
  assert.equal(only.querySelector('[data-reorder-direction="up"]').disabled, true);
  assert.equal(store.revision, 1, "das Betrachten der Knöpfe ändert nichts");
  cleanup();
});

test("Alt + Pfeil am Griff verschiebt und behält den Griff im Fokus", async () => {
  const { document, store, cleanup } = await bootEditor();
  const before = serviceIds(store);
  const handle = handleOf(serviceCards(document)[2]);
  handle.focus();

  const event = keydown(handle, "ArrowUp", { altKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(serviceIds(store), [before[0], before[2], before[1]]);
  assert.equal(document.activeElement.closest("[data-service-card]").dataset.serviceId, before[2], "der Fokus wandert mit der Karte");

  // Ohne Alt ist der Pfeil wieder ganz normale Tastaturbedienung.
  const plain = keydown(document.activeElement, "ArrowUp");
  assert.equal(plain.defaultPrevented, false);
  assert.deepEqual(serviceIds(store), [before[0], before[2], before[1]]);
  cleanup();
});

test("Ziehen sortiert um, und Escape bricht das Ziehen folgenlos ab", async () => {
  const { document, store, cleanup } = await bootEditor();
  const before = serviceIds(store);
  stackRects(serviceCards(document));

  const handle = handleOf(serviceCards(document)[0]);
  pointer(handle, "pointerdown", { clientY: 10 });
  assert.equal(serviceCards(document)[0].classList.contains("is-dragging"), true);
  assert.match(document.getElementById("previewAnnouncer").textContent, /wird verschoben/);

  // Zwischen die beiden verbleibenden Karten ziehen: die gezogene Karte ist aus der Rechnung raus,
  // also entscheidet die Mitte der zweiten Karte (150) über die neue Position.
  pointer(handle, "pointermove", { clientY: 120 });
  assert.equal(serviceCards(document)[1].classList.contains("is-drop-target-before"), true, "oberhalb der Mitte bleibt die Karte vorne");
  pointer(handle, "pointermove", { clientY: 180 });
  assert.equal(serviceCards(document)[1].classList.contains("is-drop-target-before"), false);
  assert.equal(serviceCards(document)[2].classList.contains("is-drop-target-before"), true);
  pointer(handle, "pointerup", { clientY: 180 });
  assert.deepEqual(serviceIds(store), [before[1], before[0], before[2]]);
  assert.equal(document.querySelector(".is-dragging"), null, "der Ziehzustand ist abgeräumt");

  // Zweiter Durchgang, diesmal abgebrochen.
  stackRects(serviceCards(document));
  const revision = store.revision;
  const second = handleOf(serviceCards(document)[0]);
  pointer(second, "pointerdown", { clientY: 10 });
  pointer(second, "pointermove", { clientY: 250 });
  keydown(document.body, "Escape");
  pointer(second, "pointerup", { clientY: 250 });
  assert.equal(store.revision, revision, "ein abgebrochenes Ziehen ändert nichts");
  assert.equal(document.querySelector(".is-drop-target-before, .is-drop-target-after"), null);
  cleanup();
});

test("Kundenstimmen und Personen nutzen dieselbe Umsortierung", async () => {
  const { document, store, cleanup } = await bootEditor();
  click(document.querySelector('[data-panel-target="voices"]'));
  click(document.querySelector('[data-action="add-testimonial"]'));
  click(document.querySelector('[data-action="add-testimonial"]'));
  const voices = store.snapshot.testimonials.items.map((item) => item.clientId);
  click(document.querySelectorAll("[data-testimonial-card]")[1].querySelector('[data-reorder-direction="up"]'));
  assert.deepEqual(store.snapshot.testimonials.items.map((item) => item.clientId), [voices[1], voices[0]]);

  click(document.querySelector('[data-panel-target="team"]'));
  click(document.querySelector('[data-team-action="add-staff"]'));
  click(document.querySelector('[data-team-action="add-staff"]'));
  const people = store.snapshot.staff.map((person) => person.clientId);
  const secondPerson = document.querySelectorAll("[data-staff-card]")[1];
  keydown(handleOf(secondPerson), "ArrowUp", { altKey: true });
  assert.deepEqual(store.snapshot.staff.map((person) => person.clientId), [people[1], people[0]]);
  assert.deepEqual([...document.querySelectorAll("[data-staff-card]")].map((card) => card.dataset.staffId), [people[1], people[0]]);

  click(document.getElementById("undoButton"));
  assert.deepEqual(store.snapshot.staff.map((person) => person.clientId), people);
  assert.deepEqual([...document.querySelectorAll("[data-staff-card]")].map((card) => card.dataset.staffId), people, "auch die Personenliste folgt dem Undo");
  cleanup();
});

// --- Mängelliste als Klickziel ------------------------------------------------------------------

test("ein Eintrag der Mängelliste springt in das verantwortliche Feld", async () => {
  const { document, store, cleanup } = await bootEditor();
  type(document.querySelector('[data-bind="salon.name"]'), "");
  click(document.querySelector('[data-panel-target="publish"]'));

  const entries = [...document.querySelectorAll(".readiness-result")];
  assert.ok(entries.length >= 2);
  assert.equal(entries[0].querySelector("strong").textContent, "Salonname fehlt");
  assert.match(document.getElementById("readinessSummary").textContent, /offene Blockierung/);

  click(entries[0]);
  assert.equal(document.activeElement.getAttribute("data-bind"), "salon.name");
  assert.equal(document.querySelector('[data-panel="salon"]').hidden, false);
  assert.equal(store.canRedo, false, "ein Sprung ist keine Änderung");
  cleanup();
});

test("Blocker stehen oben, und ein behobener Punkt verschwindet aus der Liste", async () => {
  const { document, store, cleanup } = await bootEditor();
  type(document.querySelector('[data-bind="salon.instagram"]'), "https://example.test/kein-instagram");
  click(document.querySelector('[data-panel-target="publish"]'));
  const severities = [...document.querySelectorAll(".readiness-result")].map((entry) => entry.className.match(/is-(error|warning)/)[1]);
  assert.deepEqual(severities, [...severities].sort((left) => left === "error" ? -1 : 1));
  assert.ok(severities.includes("warning"));

  const instagram = [...document.querySelectorAll(".readiness-result")].find((entry) => entry.textContent.includes("Instagram"));
  click(instagram);
  type(document.activeElement, "https://instagram.com/studio-miro");
  click(document.querySelector('[data-panel-target="publish"]'));
  assert.equal([...document.querySelectorAll(".readiness-result")].some((entry) => entry.textContent.includes("Instagram")), false);
  assert.equal(store.snapshot.salon.instagram, "https://instagram.com/studio-miro");
  cleanup();
});

test("ohne offene Punkte steht das ausdrücklich da", async () => {
  const { document, cleanup } = await bootEditor();
  click(document.querySelector('[data-team-action="add-staff"]'));
  // Jede Team-Aktion baut die Karte neu auf, deshalb wird sie vor jedem Klick frisch gesucht.
  click(document.querySelector('[data-staff-card] [data-team-action="all-services"]'));
  click(document.querySelector('[data-staff-card] [data-team-action="copy-business-hours"]'));
  click(document.querySelector('[data-panel-target="publish"]'));

  assert.equal(document.querySelectorAll(".readiness-result").length, 0);
  assert.match(document.querySelector(".readiness-empty").textContent, /Keine offenen Punkte/);
  assert.match(document.getElementById("readinessSummary").className, /is-ready/);
  cleanup();
});

// --- Sidebar ------------------------------------------------------------------------------------

test("die Bearbeitungsfläche klappt ein und der Zustand wird gemerkt", async () => {
  const { window, document, cleanup } = await bootEditor();
  const toggle = document.getElementById("sidebarToggle");
  const surface = document.getElementById("controlSurface");
  assert.equal(surface.classList.contains("is-collapsed"), false);

  click(toggle);
  assert.equal(surface.classList.contains("is-collapsed"), true);
  assert.equal(document.getElementById("builder-main").classList.contains("is-sidebar-collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(document.getElementById("surfaceStage").getAttribute("aria-hidden"), "true");
  assert.equal(window.localStorage.getItem("gasserwerk-salon-sidebar-collapsed-v1"), "true");

  click(toggle);
  assert.equal(surface.classList.contains("is-collapsed"), false);
  assert.equal(window.localStorage.getItem("gasserwerk-salon-sidebar-collapsed-v1"), "false");
  cleanup();
});

test("ein gemerkter Einklapp-Zustand gilt beim nächsten Start, und ein Bereichswechsel öffnet wieder", async () => {
  const { document, cleanup } = await bootEditor({ preferences: { "gasserwerk-salon-sidebar-collapsed-v1": "true" } });
  const surface = document.getElementById("controlSurface");
  assert.equal(surface.classList.contains("is-collapsed"), true);

  click(document.querySelector('[data-panel-target="hours"]'));
  assert.equal(surface.classList.contains("is-collapsed"), false, "ein angeklickter Bereich muss auch sichtbar sein");
  assert.equal(document.querySelector('[data-panel="hours"]').hidden, false);
  cleanup();
});

// --- Mobile Modi --------------------------------------------------------------------------------

test("unter 700 px trennen sich Bearbeiten und Vorschau", async () => {
  const { document, cleanup } = await bootEditor({ mobile: true });
  const workspace = document.getElementById("builder-main");
  const previewArea = document.querySelector(".preview-area");
  const surface = document.getElementById("controlSurface");
  assert.equal(workspace.classList.contains("is-mode-edit"), true, "der Bearbeitungsmodus ist der Ausgangspunkt");
  assert.equal(previewArea.hasAttribute("inert"), true, "die Vorschau ist im Bearbeitungsmodus nicht bedienbar");
  assert.match(toastText(document), /Unten wechselst du/);
  clearToast(document);

  click(document.querySelector('[data-mode="preview"]'));
  assert.equal(workspace.classList.contains("is-mode-preview"), true);
  assert.equal(previewArea.hasAttribute("inert"), false);
  assert.equal(surface.getAttribute("aria-hidden"), "true");
  assert.equal(document.querySelector('[data-mode="preview"]').getAttribute("aria-pressed"), "true");
  assert.match(document.getElementById("previewAnnouncer").textContent, /Vorschau ist aktiv/);

  click(document.querySelector('[data-mode="edit"]'));
  assert.equal(workspace.classList.contains("is-mode-edit"), true);
  assert.equal(surface.hasAttribute("inert"), false);
  cleanup();
});

test("die Bereichsauswahl liegt im Bottom-Sheet und schliesst sich nach der Wahl", async () => {
  const { document, cleanup } = await bootEditor({ mobile: true });
  const sheet = document.getElementById("sectionSheet");
  assert.equal(sheet.hidden, true);

  click(document.querySelector("[data-sheet-open]"));
  assert.equal(sheet.hidden, false);
  assert.equal(document.querySelector("[data-sheet-open]").getAttribute("aria-expanded"), "true");
  // Das Sheet spiegelt die Bereichsnavigation, inklusive des zur Laufzeit ergänzten Team-Bereichs.
  const entries = [...sheet.querySelectorAll(".section-sheet__entry")];
  const nav = [...document.querySelectorAll(".surface-nav [data-panel-target]")];
  assert.deepEqual(entries.map((entry) => entry.dataset.panelTarget), nav.map((button) => button.dataset.panelTarget));
  assert.ok(entries.some((entry) => entry.dataset.panelTarget === "team"));
  assert.equal(document.getElementById("builder-main").hasAttribute("inert"), true, "hinter dem Sheet ist nichts bedienbar");

  click(entries.find((entry) => entry.dataset.panelTarget === "hours"));
  assert.equal(sheet.hidden, true);
  assert.equal(document.querySelector('[data-panel="hours"]').hidden, false);
  assert.equal(document.getElementById("builder-main").hasAttribute("inert"), false);
  cleanup();
});

test("Escape schliesst das Sheet, und ein Vorschau-Sprung bietet den Rückweg an", async () => {
  const { window, document, store, ui, cleanup } = await bootEditor({ mobile: true });
  click(document.querySelector("[data-sheet-open]"));
  keydown(document.body, "Escape");
  assert.equal(document.getElementById("sectionSheet").hidden, true);

  click(document.querySelector('[data-mode="preview"]'));
  const returnButton = document.querySelector("[data-return-preview]");
  assert.equal(returnButton.hidden, true);

  // Ein Tipp in der Vorschau öffnet das Feld — der Rückweg zur Vorschau darf danach nicht fehlen.
  const preview = ui.previewRuntime;
  window.dispatchEvent(new window.MessageEvent("message", {
    data: {
      channel: PREVIEW_CHANNEL,
      version: PREVIEW_PROTOCOL_VERSION,
      instanceId: preview.instanceId,
      renderGeneration: preview.renderGeneration,
      revision: store.revision,
      action: "navigate-to-editor",
      target: { kind: "field", field: "salon.city" },
    },
    source: document.getElementById("previewFrame").contentWindow,
    origin: "null",
  }));
  assert.equal(document.activeElement.getAttribute("data-bind"), "salon.city");
  assert.equal(document.getElementById("builder-main").classList.contains("is-mode-edit"), true, "der Sprung holt den Bearbeitungsmodus zurück");
  assert.equal(returnButton.hidden, false);
  click(returnButton);
  assert.equal(document.getElementById("builder-main").classList.contains("is-mode-preview"), true);
  assert.equal(returnButton.hidden, true);
  cleanup();
});

test("der Zoom-Schutz für Android Chrome steht im Stylesheet", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 700px)"));
  assert.match(mobileBlock, /\.field input[^}]*font-size: 16px/, "unter 16px zoomt Android Chrome beim Fokus hinein und nicht wieder heraus");
  assert.match(mobileBlock, /\.mode-switch \{ display: flex; \}/);
});

// --- Befunde des adversarialen Reviews ----------------------------------------------------------

test("wiederholtes Strg + Z macht weiter rückgängig, obwohl der Schritt den Fokus ins Textfeld legt", async () => {
  const { document, store, cleanup } = await bootEditor();
  type(document.querySelector('[data-bind="salon.city"]'), "Winterthur");
  type(document.querySelector('[data-bind="salon.tagline"]'), "Neuer Zusatz");

  const outside = document.getElementById("undoButton");
  outside.focus();
  assert.equal(keydown(outside, "z", { ctrlKey: true }).defaultPrevented, true);
  assert.equal(store.snapshot.salon.tagline, "Coiffeur in Zürich");
  assert.equal(document.activeElement.getAttribute("data-bind"), "salon.tagline", "der Schritt setzt den Fokus in sein Feld");

  // Genau hier war Schluss: im frisch gerenderten Feld hat der Browser keine eigene Texthistorie.
  const second = keydown(document.activeElement, "z", { ctrlKey: true });
  assert.equal(second.defaultPrevented, true, "der zweite Druck gehört weiterhin dem Editor");
  assert.equal(store.snapshot.salon.city, "Zürich");
  assert.equal(store.canUndo, false, "beide Schritte sind zurückgenommen");
  cleanup();
});

test("nach echtem Tippen im Sprungziel gehört Strg + Z wieder dem Browser", async () => {
  const { document, store, cleanup } = await bootEditor();
  type(document.querySelector('[data-bind="salon.city"]'), "Winterthur");
  type(document.querySelector('[data-bind="salon.tagline"]'), "Neuer Zusatz");
  const outside = document.getElementById("undoButton");
  outside.focus();
  keydown(outside, "z", { ctrlKey: true });

  const field = document.activeElement;
  type(field, "Von Hand getippt", { commit: false });
  const revision = store.revision;
  const event = keydown(field, "z", { ctrlKey: true });
  assert.equal(event.defaultPrevented, false, "eine echte Eingabe gibt die Texthistorie an den Browser zurück");
  assert.equal(store.revision, revision);
  assert.equal(store.snapshot.salon.tagline, "Von Hand getippt");
  cleanup();
});

test("auch nach einem Sprung aus der Mängelliste bleibt Strg + Z bedienbar", async () => {
  const { document, store, cleanup } = await bootEditor();
  type(document.querySelector('[data-bind="salon.name"]'), "");
  click(document.querySelector('[data-panel-target="publish"]'));
  click([...document.querySelectorAll(".readiness-result")][0]);
  assert.equal(document.activeElement.getAttribute("data-bind"), "salon.name");

  const event = keydown(document.activeElement, "z", { ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(store.snapshot.salon.name, "Studio Miro");
  cleanup();
});

test("Strg + Z wirkt auch im Zeitfeld, das gar keine Browser-Texthistorie hat", async () => {
  const { document, store, cleanup } = await bootEditor();
  click(document.querySelector('[data-panel-target="hours"]'));
  const tuesday = () => store.snapshot.businessHours.find((day) => day.dayOfWeek === 2);
  const input = document.querySelector('#hoursList [data-day-of-week="2"] [data-hour-field="from"]');
  type(input, "10:30", { commit: false });
  assert.equal(tuesday().ranges[0].from, "10:30");

  input.focus();
  const event = keydown(input, "z", { ctrlKey: true });
  assert.equal(event.defaultPrevented, true, "sonst ist die Taste im ganzen Zeiten-Editor tot");
  assert.equal(tuesday().ranges[0].from, "09:00");
  cleanup();
});

test("Cmd + Y bleibt beim Browser, Strg + Y wiederholt weiterhin", async () => {
  const { document, store, cleanup } = await bootEditor();
  type(document.querySelector('[data-bind="salon.city"]'), "Winterthur");
  const outside = document.getElementById("undoButton");
  outside.focus();
  keydown(outside, "z", { ctrlKey: true });
  assert.equal(store.snapshot.salon.city, "Zürich");

  // Auf macOS ist Cmd + Y „Verlauf anzeigen“ — das gehört dem Browser.
  const hijacked = keydown(outside, "y", { metaKey: true });
  assert.equal(hijacked.defaultPrevented, false);
  assert.equal(store.snapshot.salon.city, "Zürich", "Cmd + Y stellt nichts wieder her");

  keydown(outside, "y", { ctrlKey: true });
  assert.equal(store.snapshot.salon.city, "Winterthur");
  cleanup();
});

test("bei offenem Bottom-Sheet ändert Strg + Z den Entwurf dahinter nicht", async () => {
  const { document, store, cleanup } = await bootEditor({ mobile: true });
  type(document.querySelector('[data-bind="salon.city"]'), "Winterthur");
  click(document.querySelector("[data-sheet-open]"));
  assert.equal(document.getElementById("sectionSheet").hidden, false);

  const revision = store.revision;
  const event = keydown(document.body, "z", { ctrlKey: true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(store.revision, revision);
  assert.equal(store.snapshot.salon.city, "Winterthur");
  cleanup();
});

test("unter der Mobilgrenze wirkt der eingeklappte Zustand nicht und kehrt darüber zurück", async () => {
  const { document, setViewportMobile, cleanup } = await bootEditor({ preferences: { "gasserwerk-salon-sidebar-collapsed-v1": "true" } });
  const surface = document.getElementById("controlSurface");
  const stage = document.getElementById("surfaceStage");
  assert.equal(surface.classList.contains("is-collapsed"), true);

  // Verschmälern, Tabletdrehung, Split-Screen: die Media-Query kippt ohne Neuladen.
  setViewportMobile(true);
  assert.equal(surface.classList.contains("is-collapsed"), false, "sonst bleibt zwischen Kopfzeile und Modusleiste nichts übrig");
  assert.equal(document.getElementById("builder-main").classList.contains("is-sidebar-collapsed"), false);
  assert.equal(stage.getAttribute("aria-hidden"), "false");

  setViewportMobile(false);
  assert.equal(surface.classList.contains("is-collapsed"), true, "der gemerkte Desktop-Zustand bleibt erhalten");
  cleanup();
});

test("ein gemerkter Einklapp-Zustand wird auf dem Handy gar nicht erst angewendet", async () => {
  const { document, cleanup } = await bootEditor({ mobile: true, preferences: { "gasserwerk-salon-sidebar-collapsed-v1": "true" } });
  assert.equal(document.getElementById("controlSurface").classList.contains("is-collapsed"), false);
  assert.equal(document.getElementById("surfaceStage").getAttribute("aria-hidden"), "false");
  assert.equal(document.querySelector('[data-panel="salon"]').hidden, false, "der Bearbeitungsmodus zeigt etwas");
  cleanup();
});

test("ein Ziehen, dessen Karte zwischendurch neu gebaut wurde, bricht ab statt falsch einzusortieren", async () => {
  const { document, store, cleanup } = await bootEditor();
  const before = serviceIds(store);
  stackRects(serviceCards(document));
  const handle = handleOf(serviceCards(document)[0]);
  pointer(handle, "pointerdown", { clientY: 10 });

  // Alt + Pfeil baut die Liste neu auf; die gezogene Karte hängt danach nicht mehr im Dokument.
  keydown(handle, "ArrowDown", { altKey: true });
  const afterStep = serviceIds(store);
  assert.deepEqual(afterStep, [before[1], before[0], before[2]]);
  stackRects(serviceCards(document));

  // Der Zeiger lebt weiter und wird über der unteren Hälfte der zweiten Karte losgelassen.
  pointer(document.body, "pointermove", { clientY: 160 });
  pointer(document.body, "pointerup", { clientY: 160 });
  assert.deepEqual(serviceIds(store), afterStep, "kein stiller Sprung auf eine falsche Position");
  assert.equal(document.querySelector(".is-drop-target-before, .is-drop-target-after"), null);
  assert.match(document.getElementById("previewAnnouncer").textContent, /abgebrochen/);
  cleanup();
});

test("ein abgerissener Zeigerstrom lässt keinen Ziehzustand zurück", async () => {
  const { window, document, store, cleanup } = await bootEditor();
  stackRects(serviceCards(document));
  const handle = handleOf(serviceCards(document)[0]);
  pointer(handle, "pointerdown", { clientY: 10 });
  pointer(handle, "pointermove", { clientY: 160 });
  assert.ok(document.querySelector(".is-dragging"), "das Ziehen läuft");

  window.dispatchEvent(new window.Event("blur"));
  assert.equal(document.querySelector(".is-dragging"), null, "ohne pointerup bliebe die Markierung sonst stehen");
  assert.equal(document.querySelector(".is-drop-target-before, .is-drop-target-after"), null);

  const revision = store.revision;
  pointer(handle, "pointerup", { clientY: 160 });
  assert.equal(store.revision, revision, "ein spätes Loslassen verschiebt nichts mehr");
  cleanup();
});

test("das Umbenennen aktualisiert auch die Beschriftung der Umsortier-Bedienung", async () => {
  const { document, cleanup } = await bootEditor();
  const card = serviceCards(document)[0];
  type(card.querySelector('[data-service-field="name"]'), "Herrenschnitt kurz", { commit: false });
  assert.equal(card.getAttribute("aria-label"), "Leistung „Herrenschnitt kurz“, Position 1 von 3");
  assert.equal(card.querySelector('[data-reorder-direction="down"]').getAttribute("aria-label"), "Leistung „Herrenschnitt kurz“ nach unten");
  assert.match(handleOf(card).getAttribute("aria-label"), /^Leistung „Herrenschnitt kurz“ ziehen/);
  cleanup();
});

test("nach einem Klick auf den Pfeilknopf bleibt der Fokus auf dem Pfeilknopf", async () => {
  const { document, store, cleanup } = await bootEditor();
  const down = serviceCards(document)[0].querySelector('[data-reorder-direction="down"]');
  down.focus();
  click(down);
  assert.equal(document.activeElement.dataset.reorderDirection, "down", "zweimal „↓“ per Tastatur muss gehen");
  assert.equal(document.activeElement.closest("[data-service-card]").dataset.serviceId, store.snapshot.services[1].clientId);

  // Am Listenende ist der Pfeil gesperrt; dann übernimmt der Griff, damit der Fokus nicht verfällt.
  click(document.activeElement);
  assert.equal(document.activeElement.hasAttribute("data-reorder-handle"), true);
  cleanup();
});

test("destroy() gibt Modusklassen und inert-Markierungen zurück", async () => {
  const { document, ui, cleanup } = await bootEditor({ mobile: true });
  const workspace = document.getElementById("builder-main");
  const previewArea = document.querySelector(".preview-area");
  assert.equal(workspace.classList.contains("is-mode-edit"), true);
  assert.equal(previewArea.hasAttribute("inert"), true);

  ui.destroy();
  assert.equal(workspace.classList.contains("is-mode-edit"), false);
  assert.equal(previewArea.hasAttribute("inert"), false);
  assert.equal(previewArea.hasAttribute("aria-hidden"), false);
  cleanup();
});

test("die Zusammenfassung verspricht keine Exportsperre, und ein Export mit Blockern sagt es", async () => {
  const { document, cleanup } = await bootEditor();
  click(document.querySelector('[data-panel-target="publish"]'));
  const summary = document.getElementById("readinessSummary");
  assert.doesNotMatch(summary.textContent, /kann exportiert werden/, "das Wort war eine Bedingung, die niemand durchsetzt");

  type(document.querySelector('[data-bind="salon.name"]'), "");
  click(document.querySelector('[data-panel-target="publish"]'));
  assert.match(summary.className, /is-blocked/);
  clearToast(document);

  click([...document.querySelectorAll('[data-action="export"]')].at(-1));
  assert.match(toastText(document) ?? "", /offen/, "ein Export mit Blockern darf nicht klingen, als sei alles in Ordnung");
  cleanup();
});
