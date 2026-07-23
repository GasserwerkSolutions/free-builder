import test from "node:test";
import assert from "node:assert/strict";
import { bootEditor, choose, clearToast, click, toastText, toggle, type, withCapturedErrors } from "./helpers/editor-dom.mjs";
import { navigateToEditorTarget } from "../assets/preview-navigation.js";
import { PREVIEW_CHANNEL, PREVIEW_PROTOCOL_VERSION } from "../assets/preview-contract.js";

// Real clicks, real typing, real event registration.
//
// The editor listens for "input" AND "change" with the same handler (ui.ts), so every commit of a
// text field runs the mutation twice with the same value. Nothing covered that before; the helpers
// used here reproduce it by default instead of hiding it.

const serviceCards = (document) => [...document.querySelectorAll("[data-service-card]")];
const cardField = (card, field) => card.querySelector(`[data-service-field="${field}"]`);

test("eine Leistung wird über echte Klicks angelegt, benannt und wieder entfernt", async () => {
  const { document, store, cleanup } = await bootEditor();
  const before = store.snapshot.services.length;

  click(document.querySelector('[data-action="add-service"]'));
  assert.equal(store.snapshot.services.length, before + 1);
  assert.equal(serviceCards(document).length, before + 1);

  const card = serviceCards(document).at(-1);
  type(cardField(card, "name"), "Waschen & Föhnen");
  const created = store.snapshot.services.at(-1);
  assert.equal(created.name, "Waschen & Föhnen");
  assert.equal(created.slug, "waschen-fohnen");
  assert.equal(card.querySelector("[data-service-number]").textContent, `${before + 1}. Waschen & Föhnen`);

  type(cardField(card, "description"), "Kurz und gut");
  choose(cardField(card, "priceType"), "on-request");
  type(cardField(card, "durationMinutes"), "45");
  toggle(cardField(card, "bookable"), false);
  const edited = store.snapshot.services.at(-1);
  assert.equal(edited.description, "Kurz und gut");
  assert.equal(edited.priceType, "on-request");
  assert.equal(edited.durationMinutes, 45);
  assert.equal(edited.bookable, false);
  assert.equal(toastText(document), null);

  click(card.querySelector('[data-action="remove-service"]'));
  assert.equal(store.snapshot.services.length, before);
  assert.equal(serviceCards(document).length, before);
  cleanup();
});

test("input und change mit demselben Wert erzeugen keinen Fehler und keinen zweiten Undo-Schritt", async () => {
  const { document, store, cleanup } = await bootEditor();
  const input = document.querySelector('[data-bind="salon.name"]');
  const original = store.snapshot.salon.name;

  // type() fires input and then change — exactly what a browser does when a field is committed.
  type(input, "Salon Doppelklang");
  assert.equal(store.snapshot.salon.name, "Salon Doppelklang");
  assert.equal(store.revision, 1, "der identische change-Aufruf darf keine zweite Revision erzeugen");
  assert.equal(toastText(document), null);

  // One undo has to land back on the original value; two steps would mean the duplicate was recorded.
  store.undo();
  assert.equal(store.snapshot.salon.name, original);
  assert.equal(store.canUndo, false);
  cleanup();
});

test("auch eine Checkbox feuert input und change und bleibt trotzdem ein Schritt", async () => {
  const { document, store, cleanup } = await bootEditor();
  const box = document.querySelector('[data-bind="testimonials.enabled"]');
  toggle(box, true);
  assert.equal(store.snapshot.testimonials.enabled, true);
  assert.equal(store.revision, 1);
  store.undo();
  assert.equal(store.snapshot.testimonials.enabled, false);
  assert.equal(store.canUndo, false);
  cleanup();
});

test("der Slug-Ablauf aus dem Review bleibt über echte DOM-Ereignisse widerspruchsfrei", async () => {
  const { document, store, cleanup } = await bootEditor();
  const base = store.snapshot.services.length;

  const add = document.querySelector('[data-action="add-service"]');
  click(add); click(add); click(add);
  const created = store.snapshot.services.slice(base);
  assert.deepEqual(created.map((service) => service.slug), ["neue-leistung", "neue-leistung-2", "neue-leistung-3"]);

  const cards = serviceCards(document).slice(base);
  // Renaming the first one frees the slug "neue-leistung" for whoever asks next.
  type(cardField(cards[0], "name"), "Föhnen");
  assert.equal(store.snapshot.services[base].slug, "fohnen");

  // Now type a character into the second one and delete it again inside the 900 ms grouping window.
  // The name comes back to where it started, but the slug does not: it reclaims the freed base.
  const second = cardField(cards[1], "name");
  type(second, "Neue LeistungX", { commit: false });
  type(second, "Neue Leistung", { commit: false });

  const services = store.snapshot.services;
  assert.equal(services[base + 1].name, "Neue Leistung");
  assert.equal(services[base + 1].slug, "neue-leistung");
  assert.equal(new Set(services.map((service) => service.slug)).size, services.length, "Slugs bleiben eindeutig");
  assert.equal(toastText(document), null, "kein abgewiesener Mutationsversuch");

  // The surface still shows exactly what the draft holds.
  serviceCards(document).forEach((card, index) => {
    assert.equal(cardField(card, "name").value, store.snapshot.services[index].name);
  });
  cleanup();
});

test("Öffnungszeiten lassen sich über echte Ereignisse schliessen, ergänzen und ändern", async () => {
  const { document, store, cleanup } = await bootEditor();
  click(document.querySelector('[data-panel-target="hours"]'));

  const dayRow = (day) => document.querySelector(`#hoursList [data-day-of-week="${day}"]`);
  toggle(dayRow(3).querySelector('[data-hour-field="closed"]'), true);
  assert.equal(store.snapshot.businessHours.find((day) => day.dayOfWeek === 3).closed, true);
  assert.ok(dayRow(3).classList.contains("is-closed"));

  click(dayRow(4).querySelector('[data-hour-action="add-range"]'));
  assert.equal(store.snapshot.businessHours.find((day) => day.dayOfWeek === 4).ranges.length, 2);

  const from = dayRow(4).querySelectorAll('[data-hour-field="from"]')[1];
  type(from, "19:00", { commit: false });
  assert.equal(store.snapshot.businessHours.find((day) => day.dayOfWeek === 4).ranges[1].from, "19:00");

  click(dayRow(4).querySelectorAll('[data-hour-action="remove-range"]')[1]);
  assert.equal(store.snapshot.businessHours.find((day) => day.dayOfWeek === 4).ranges.length, 1);
  assert.equal(toastText(document), null);
  cleanup();
});

test("Kundenstimmen werden über die Oberfläche angelegt, getippt und entfernt", async () => {
  const { document, store, cleanup } = await bootEditor();
  click(document.querySelector('[data-panel-target="voices"]'));

  click(document.querySelector('[data-action="add-testimonial"]'));
  assert.equal(store.snapshot.testimonials.items.length, 1);
  assert.equal(store.snapshot.testimonials.enabled, true);
  assert.equal(document.querySelector('[data-bind="testimonials.enabled"]').checked, true);

  const card = document.querySelector("[data-testimonial-card]");
  type(card.querySelector('[data-testimonial-field="quote"]'), "Sehr persönlich.");
  type(card.querySelector('[data-testimonial-field="name"]'), "Laura M.");
  assert.deepEqual(
    { quote: store.snapshot.testimonials.items[0].quote, name: store.snapshot.testimonials.items[0].name },
    { quote: "Sehr persönlich.", name: "Laura M." },
  );

  click(card.querySelector('[data-action="remove-testimonial"]'));
  assert.equal(store.snapshot.testimonials.items.length, 0);
  assert.equal(store.snapshot.testimonials.enabled, false);
  assert.equal(document.querySelector('[data-bind="testimonials.enabled"]').checked, false);
  cleanup();
});

test("ein Preset-Klick setzt die Farbwelt und synchronisiert die Farbfelder", async () => {
  const { document, store, cleanup } = await bootEditor();
  click(document.querySelector('[data-panel-target="design"]'));
  click(document.querySelector('[data-preset="bold"]'));

  assert.equal(store.snapshot.theme.preset, "bold");
  assert.equal(document.querySelector('[data-bind="theme.primary"]').value, store.snapshot.theme.primary);
  assert.equal(document.querySelector('[data-bind="theme.accent"]').value, store.snapshot.theme.accent);
  assert.equal(document.querySelector('[data-preset="bold"]').getAttribute("aria-checked"), "true");
  assert.equal(document.querySelector('[data-preset="elegant"]').getAttribute("aria-checked"), "false");
  cleanup();
});

test("eine Person wird angelegt, benannt und erhält eine ausdrückliche Leistungszuordnung", async () => {
  const { document, store, cleanup } = await bootEditor();
  click(document.querySelector('[data-panel-target="team"]'));
  click(document.querySelector('[data-team-action="add-staff"]'));
  assert.equal(store.snapshot.staff.length, 1);

  const card = document.querySelector("[data-staff-card]");
  type(card.querySelector('[data-staff-field="name"]'), "Anna Muster", { commit: false });
  assert.equal(store.snapshot.staff[0].name, "Anna Muster");
  assert.equal(card.querySelector("[data-staff-number]").textContent, "1. Anna Muster");

  const first = store.snapshot.services[0].clientId;
  toggle(document.querySelector(`[data-staff-service="${first}"]`), true);
  assert.deepEqual(store.snapshot.staff[0].serviceClientIds, [first]);

  // No silent defaults: assignment stays empty until it is set again.
  toggle(document.querySelector(`[data-staff-service="${first}"]`), false);
  assert.deepEqual(store.snapshot.staff[0].serviceClientIds, []);
  assert.equal(toastText(document), null);
  cleanup();
});

test("persönliche Arbeitszeiten bleiben von den Öffnungszeiten getrennt", async () => {
  const { document, store, cleanup } = await bootEditor();
  click(document.querySelector('[data-team-action="add-staff"]'));
  const staffRow = document.querySelector('[data-staff-card] [data-day-of-week="2"]');
  toggle(staffRow.querySelector('[data-staff-hour-field="closed"]'), false);

  const person = store.snapshot.staff[0];
  assert.equal(person.workingHours.find((day) => day.dayOfWeek === 2).closed, false);
  // The salon schedule must not have moved with it — two separate truths.
  assert.deepEqual(store.snapshot.businessHours, (await import("../assets/domain.js")).createDefaultSchedule());
  assert.equal(toastText(document), null);
  cleanup();
});

test("nach einem Verifikationsfehler wird weitergerendert und Oberfläche und Entwurf laufen nicht auseinander", async () => {
  const { document, store, cleanup } = await bootEditor();

  // A binding that points nowhere is a bug in the editor, not a user error. setAtPath rejects it,
  // safeMutate catches it, and the surface has to survive the rejection intact.
  const broken = document.createElement("input");
  broken.type = "text";
  broken.dataset.bind = "salon.unbekannt";
  document.querySelector('[data-panel="salon"]').appendChild(broken);

  const nameBefore = store.snapshot.salon.name;
  const { logged } = await withCapturedErrors(async () => { type(broken, "Wert ohne Ziel"); });

  assert.equal(store.revision, 0, "der Entwurf bleibt auf dem zuletzt geprüften Stand");
  assert.equal(store.snapshot.salon.name, nameBefore);
  assert.match(toastText(document) ?? "", /nicht übernommen/);
  // Both the input and the change registration report it, and both name the code.
  assert.equal(logged.length, 2);
  logged.forEach((entry) => assert.match(String(entry.at(-1)), /UNKNOWN_BIND_PATH:salon\.unbekannt/));

  clearToast(document);
  // The editor keeps working: the very next real edit lands and renders.
  type(document.querySelector('[data-bind="salon.city"]'), "Winterthur");
  assert.equal(store.snapshot.salon.city, "Winterthur");
  assert.equal(store.revision, 1);
  assert.equal(toastText(document), null);

  // And every bound control still shows exactly what the draft holds.
  document.querySelectorAll("[data-bind]").forEach((input) => {
    const path = input.dataset.bind;
    if (path === "salon.unbekannt") return;
    const value = path.split(".").reduce((carrier, key) => carrier?.[key], store.snapshot);
    if (input.type === "checkbox") assert.equal(input.checked, Boolean(value));
    else assert.equal(input.value, String(value ?? ""));
  });
  cleanup();
});

test("eine abgewiesene Entfernung lässt die Liste im Einklang mit dem Entwurf", async () => {
  const { document, store, cleanup } = await bootEditor();
  click(document.querySelector('[data-panel-target="voices"]'));
  // Section on, list empty: a removal with an id that was never in the list would flip the toggle —
  // a change the declared intent cannot back up, so the verifier rejects the whole mutation.
  toggle(document.querySelector('[data-bind="testimonials.enabled"]'), true);
  assert.equal(store.snapshot.testimonials.enabled, true);
  const revisionBefore = store.revision;

  const stale = document.createElement("article");
  stale.dataset.testimonialCard = "";
  stale.dataset.testimonialId = "voice-existiert-nicht";
  stale.innerHTML = '<button type="button" data-action="remove-testimonial">×</button>';
  document.getElementById("testimonialList").appendChild(stale);

  const { logged } = await withCapturedErrors(async () => { click(stale.querySelector("button")); });
  assert.equal(store.revision, revisionBefore);
  assert.equal(store.snapshot.testimonials.enabled, true);
  assert.match(String(logged.at(-1)?.at(-1)), /INVALID_COLLECTION_REMOVE/);
  assert.match(toastText(document) ?? "", /nicht übernommen/);

  // renderTestimonials ran after the rejection: the injected card is gone, the empty state is back.
  assert.equal(document.querySelector('[data-testimonial-id="voice-existiert-nicht"]'), null);
  assert.match(document.getElementById("testimonialList").textContent, /Keine Kundenstimmen/);
  cleanup();
});

// --- Klick in der Vorschau -> Sprung ins Editor-Feld -------------------------------------------

// navigateToEditorTarget only reads from the surface; these are the elements it touches. Since the
// jump also has to make the surface reachable first (collapsed sidebar, mobile preview mode), that
// now includes the sidebar elements.
const navContext = (document, store) => ({
  store,
  workspace: document.getElementById("builder-main"),
  controlSurface: document.getElementById("controlSurface"),
  surfaceStage: document.getElementById("surfaceStage"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  surfaceCard: document.getElementById("surfaceCard"),
  readinessSummary: document.getElementById("readinessSummary"),
  readinessList: document.getElementById("readinessList"),
  mobileMode: "edit",
});

test("ein Vorschau-Ziel öffnet den passenden Bereich und setzt den Fokus ins Feld", async () => {
  const { document, store, cleanup } = await bootEditor();

  navigateToEditorTarget(navContext(document, store), { kind: "field", field: "copy.heroTitle" });
  assert.equal(document.activeElement.getAttribute("data-bind"), "copy.heroTitle");
  assert.equal(document.querySelector('[data-panel="copy"]').hidden, false);
  assert.equal(store.canUndo, false, "eine Navigation ist keine Änderung");

  const serviceId = store.snapshot.services[1].clientId;
  navigateToEditorTarget(navContext(document, store), { kind: "service", serviceClientId: serviceId, field: "name" });
  assert.equal(document.activeElement.closest("[data-service-card]").dataset.serviceId, serviceId);
  assert.equal(document.activeElement.dataset.serviceField, "name");
  assert.equal(document.querySelector('[data-panel="services"]').hidden, false);

  navigateToEditorTarget(navContext(document, store), { kind: "panel", panel: "hours" });
  assert.equal(document.querySelector('[data-panel="hours"]').hidden, false);
  cleanup();
});

test("ein Vorschau-Ziel auf Kundenstimme und Person trifft die richtige Karte", async () => {
  const { document, store, cleanup } = await bootEditor();
  click(document.querySelector('[data-action="add-testimonial"]'));
  click(document.querySelector('[data-team-action="add-staff"]'));

  const voiceId = store.snapshot.testimonials.items[0].clientId;
  navigateToEditorTarget(navContext(document, store), { kind: "testimonial", testimonialClientId: voiceId, field: "quote" });
  assert.equal(document.activeElement.closest("[data-testimonial-card]").dataset.testimonialId, voiceId);

  const staffId = store.snapshot.staff[0].clientId;
  navigateToEditorTarget(navContext(document, store), { kind: "staff", staffClientId: staffId, field: "bio" });
  assert.equal(document.activeElement.closest("[data-staff-card]").dataset.staffId, staffId);
  assert.equal(document.activeElement.dataset.staffField, "bio");
  cleanup();
});

test("ein Sprung auf eine Überschrift gibt den Tabstopp beim Verlassen wieder zurück", async () => {
  const { document, store, cleanup } = await bootEditor();
  navigateToEditorTarget(navContext(document, store), { kind: "panel", panel: "hours" });
  const heading = document.activeElement;
  assert.equal(heading.tagName, "H2");
  assert.equal(heading.getAttribute("tabindex"), "-1", "sonst wäre die Überschrift gar nicht fokussierbar");

  document.querySelector('[data-bind="salon.name"]').focus();
  assert.equal(heading.hasAttribute("tabindex"), false, "eine Überschrift bleibt kein dauerhafter Tabstopp");
  cleanup();
});

test("ein Ziel auf einen gelöschten Eintrag landet ruhig auf der Bereichsüberschrift", async () => {
  const { document, store, cleanup } = await bootEditor();
  navigateToEditorTarget(navContext(document, store), { kind: "service", serviceClientId: "gibt-es-nicht", field: "name" });
  assert.equal(document.activeElement.textContent, "Leistungen & Preise");
  assert.match(document.getElementById("previewAnnouncer").textContent, /nicht mehr vorhanden/);
  assert.equal(store.canUndo, false);
  cleanup();
});

test("eine Navigationsmeldung aus dem Vorschaurahmen erreicht das Editor-Feld", async () => {
  const { window, document, store, ui, cleanup } = await bootEditor();
  const frame = document.getElementById("previewFrame");
  const source = frame.contentWindow;
  assert.ok(source, "der Vorschaurahmen hat einen Browsing-Kontext");

  const preview = ui.previewRuntime;
  const message = {
    channel: PREVIEW_CHANNEL,
    version: PREVIEW_PROTOCOL_VERSION,
    instanceId: preview.instanceId,
    renderGeneration: preview.renderGeneration,
    revision: store.revision,
    action: "navigate-to-editor",
    target: { kind: "field", field: "salon.city" },
  };
  window.dispatchEvent(new window.MessageEvent("message", { data: message, source, origin: "null" }));
  assert.equal(document.activeElement.getAttribute("data-bind"), "salon.city");
  assert.equal(document.querySelector('[data-panel="salon"]').hidden, false);

  // Same message, but not from the preview: it must not move the editor at all.
  document.querySelector('[data-bind="salon.name"]').focus();
  window.dispatchEvent(new window.MessageEvent("message", { data: { ...message, target: { kind: "field", field: "copy.heroTitle" } }, source: window, origin: "null" }));
  assert.equal(document.activeElement.getAttribute("data-bind"), "salon.name");
  cleanup();
});

test("jeder Historienschritt merkt sich, um welches Editor-Feld es ging", async () => {
  const { document, store, cleanup } = await bootEditor();

  type(document.querySelector('[data-bind="salon.city"]'), "Winterthur");
  assert.deepEqual(store.nextUndoAction.target, { kind: "field", field: "salon.city" });

  click(document.querySelector('[data-action="add-service"]'));
  const created = store.snapshot.services.at(-1).clientId;
  assert.deepEqual(store.nextUndoAction.target, { kind: "service", serviceClientId: created, field: "name" });

  click(document.querySelector('[data-team-action="add-staff"]'));
  const person = store.snapshot.staff[0].clientId;
  assert.deepEqual(store.nextUndoAction.target, { kind: "staff", staffClientId: person, field: "name" });

  click(document.querySelector('[data-panel-target="design"]'));
  click(document.querySelector('[data-preset="modern"]'));
  assert.deepEqual(store.nextUndoAction.target, { kind: "panel", panel: "design" });

  // A field the preview does not render gets the panel, never an invented target.
  const staffCard = document.querySelector("[data-staff-card]");
  type(staffCard.querySelector('[data-staff-field="email"]'), "anna@example.test", { commit: false });
  assert.deepEqual(store.nextUndoAction.target, { kind: "panel", panel: "team" });

  // Auch die Übernahme der Öffnungszeiten als Arbeitszeiten ist ein Schritt mit Ziel — sie war der
  // einzige Aufruf, der keines mitgab.
  click(document.querySelector('[data-team-action="copy-business-hours"]'));
  assert.deepEqual(store.nextUndoAction.target, { kind: "panel", panel: "team" });
  cleanup();
});

test("destroy() nimmt jeden Zuhörer zurück und räumt die Meldezeile ab", async () => {
  const { window, document, store, ui, cleanup } = await bootEditor();
  const source = document.getElementById("previewFrame").contentWindow;
  const preview = ui.previewRuntime;
  const message = {
    channel: PREVIEW_CHANNEL,
    version: PREVIEW_PROTOCOL_VERSION,
    instanceId: preview.instanceId,
    renderGeneration: preview.renderGeneration,
    revision: store.revision,
    action: "navigate-to-editor",
    target: { kind: "service", serviceClientId: "gibt-es-nicht", field: "name" },
  };
  window.dispatchEvent(new window.MessageEvent("message", { data: message, source, origin: "null" }));
  assert.ok(document.getElementById("previewAnnouncer"), "die Meldezeile entsteht bei Bedarf");

  const services = store.snapshot.services.length;
  ui.destroy();
  assert.equal(document.getElementById("previewAnnouncer"), null, "und verschwindet mit dem Abräumen wieder");

  // Klick, Eingabe und Änderung laufen jetzt ins Leere statt weiter in den Entwurf zu schreiben.
  click(document.querySelector('[data-action="add-service"]'));
  assert.equal(store.snapshot.services.length, services, "kein Klick-Zuhörer mehr");
  type(document.querySelector('[data-bind="salon.city"]'), "Winterthur");
  assert.equal(store.snapshot.salon.city, "Zürich", "kein input-/change-Zuhörer mehr");
  cleanup();
});
