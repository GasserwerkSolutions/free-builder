import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { cloneDraft, createClosedSchedule, createDefaultDraft, createDefaultSchedule, uniqueSlug } from "../assets/domain.js";
import { MemoryDraftRepository } from "../assets/persistence.js";
import { BuilderStore } from "../assets/store.js";
import { EDITABLE_FIELDS } from "../assets/preview-contract.js";
import { planPreviewUpdate } from "../assets/preview-update-planner.js";
import { buildWebsiteHtml } from "../assets/website.js";

// Der mechanische Prüfstand für das Vorschau-Protokoll.
//
// Für jede Mutationsart wird die Seite zweimal vollständig gerendert — vor und nach der Änderung —,
// der Plan des Planers auf das ALTE Dokument angewendet und das Ergebnis gegen den neuen Vollrender
// gehalten. Damit ist "welche Regionen ändern sich wirklich?" nicht mehr eine Behauptung im Kopf des
// Planers, sondern eine gemessene Grösse:
//
//   Unterdeckung  — eine Region ändert sich, wird aber nicht angefordert: der gepatchte Körper weicht
//                   vom Vollrender ab und der Test fällt. Genau das war der Fund M-1, der bis dahin
//                   nur zufällig dadurch nicht schadete, dass das Vorschau-Dokument das Bündel ablehnt.
//   Überdeckung   — eine Region wird angefordert, ändert sich aber nie: jeder unnötige Regionentausch
//                   zerstört im Kind die Textselektion, also ist er ein Fehler. Wo der Entwurf NACH
//                   der Änderung nicht mehr hergibt, ob sich etwas bewegt hat (eine entfernte Person
//                   ist weg), bleibt eine vorsorgliche Anforderung zulässig — sie muss sich aber in
//                   mindestens einem Szenario derselben Abhängigkeit als nötig erweisen. Alle
//                   vorsorglichen Tausche werden zusätzlich als Diagnose ausgegeben.
//
// BEWUSST AUSSERHALB: der <head>. Titel, Meta-Description und JSON-LD werden nie gepatcht; verglichen
// wird deshalb `body`. Das ist die dokumentierte Lücke M-2 — siehe preview-update-planner.ts.
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test" });
globalThis.DOMParser = dom.window.DOMParser;

const RENDER_OPTIONS = { preview: true, previewInstanceId: "coverage", parentOrigin: "https://editor.test", previewScroll: null, previewRevision: 0, renderGeneration: 1 };
const PLAN_OPTIONS = { previewInstanceId: "coverage", parentOrigin: "https://editor.test", previewScroll: null, revision: 0, renderGeneration: 1 };

const DAMEN = "service-damenschnitt";
const HERREN = "service-herrenschnitt";

const staffMember = (over = {}) => ({ clientId: "staff-1", name: "Anna Beispiel", email: "", role: "Coiffeuse", bio: "", specialties: [], active: true, serviceClientIds: [], workingHours: createDefaultSchedule(), portraitAssetLocalId: null, ...over });
const voice = (over = {}) => ({ clientId: "voice-1", quote: "Sehr gute Beratung und ein toller Schnitt.", name: "Mia Muster", detail: "", ...over });

const withStaff = (...people) => (draft) => { draft.staff = people; };
const withVoices = (...items) => (draft) => { draft.testimonials = { enabled: true, items }; };

// --- Mutationen, so wie die Editor-Oberfläche sie auslöst -------------------------------------

const setField = (store, path, value) => store.mutate((draft) => {
  const [group, key] = path.split(".");
  draft[group][key] = value;
}, { intent: { type: "set-field", field: path }, history: { label: path } });

const setService = (store, clientId, field, value) => store.mutate((draft) => {
  const service = draft.services.find((item) => item.clientId === clientId);
  service[field] = value;
  if (field === "name") service.slug = uniqueSlug(value, draft.services, clientId);
}, { intent: { type: "set-service-field", serviceClientId: clientId, field }, history: { label: "Leistung" } });

const setStaff = (store, clientId, field, value) => store.mutate((draft) => {
  const person = draft.staff.find((item) => item.clientId === clientId);
  person[field] = value;
}, { intent: { type: "set-staff-field", staffClientId: clientId, field }, history: { label: "Person" } });

const setVoice = (store, clientId, field, value) => store.mutate((draft) => {
  const item = draft.testimonials.items.find((entry) => entry.clientId === clientId);
  item[field] = value;
}, { intent: { type: "set-testimonial-field", testimonialClientId: clientId, field }, history: { label: "Kundenstimme" } });

const insert = (store, collection, clientId, mutator) => store.mutate(mutator, { intent: { type: "insert-collection-item", collection, clientId }, history: { label: "Hinzugefügt" } });
const remove = (store, collection, clientId, mutator) => store.mutate(mutator, { intent: { type: "remove-collection-item", collection, clientId }, history: { label: "Entfernt" } });
const move = (store, collection, clientId, mutator) => store.mutate(mutator, { intent: { type: "move-collection-item", collection, clientId }, history: { label: "Verschoben" } });

const moveFirstToEnd = (list) => { const [first] = list.splice(0, 1); list.push(first); };

// --- Szenarien -------------------------------------------------------------------------------
// `key` bündelt Szenarien zu einer Abhängigkeit; die Überdeckungsprüfung urteilt je Bündel.

const SCENARIOS = [
  { key: "field-set:salon.name", name: "Salonname mit vorhandener Tagline", mutate: (store) => setField(store, "salon.name", "Salon Nord") },
  { key: "field-set:salon.name", name: "Salonname ohne Tagline", prepare: (draft) => { draft.salon.tagline = ""; }, mutate: (store) => setField(store, "salon.name", "Salon Nord") },
  { key: "field-set:salon.tagline", name: "Tagline geändert", mutate: (store) => setField(store, "salon.tagline", "Handwerk mit Haltung") },
  { key: "field-set:salon.tagline", name: "Tagline geleert", mutate: (store) => setField(store, "salon.tagline", "") },
  { key: "field-set:salon.phone", name: "Telefon geändert", mutate: (store) => setField(store, "salon.phone", "+41 44 111 11 11") },
  { key: "field-set:salon.phone", name: "Telefon geleert", mutate: (store) => setField(store, "salon.phone", "") },
  { key: "field-set:salon.email", name: "E-Mail geändert", mutate: (store) => setField(store, "salon.email", "team@studio-miro.ch") },
  { key: "field-set:salon.address", name: "Strasse geändert", mutate: (store) => setField(store, "salon.address", "Bahnhofstrasse 1") },
  { key: "field-set:salon.postalCode", name: "PLZ geändert", mutate: (store) => setField(store, "salon.postalCode", "8004") },
  { key: "field-set:salon.city", name: "Ort geändert", mutate: (store) => setField(store, "salon.city", "Winterthur") },
  { key: "field-set:salon.instagram", name: "Instagram gesetzt", mutate: (store) => setField(store, "salon.instagram", "https://instagram.com/studio-miro") },
  { key: "field-set:salon.instagram", name: "Instagram gewechselt", prepare: (draft) => { draft.salon.instagram = "https://instagram.com/alt"; }, mutate: (store) => setField(store, "salon.instagram", "https://instagram.com/neu") },
  { key: "field-set:copy.heroLabel", name: "Hero-Label", mutate: (store) => setField(store, "copy.heroLabel", "Neues Label") },
  { key: "field-set:copy.heroTitle", name: "Haupttitel", mutate: (store) => setField(store, "copy.heroTitle", "Ein neuer Haupttitel") },
  { key: "field-set:copy.heroTitle", name: "Haupttitel geleert", mutate: (store) => setField(store, "copy.heroTitle", "") },
  { key: "field-set:copy.heroSubtitle", name: "Hero-Text", mutate: (store) => setField(store, "copy.heroSubtitle", "Ein neuer Hero-Text.") },
  { key: "field-set:copy.servicesTitle", name: "Leistungs-Titel", mutate: (store) => setField(store, "copy.servicesTitle", "Unsere Leistungen") },
  { key: "field-set:copy.servicesSubtitle", name: "Leistungs-Text", mutate: (store) => setField(store, "copy.servicesSubtitle", "Alles transparent.") },
  { key: "field-set:copy.bookingTitle", name: "Buchungs-Titel", mutate: (store) => setField(store, "copy.bookingTitle", "Jetzt buchen") },
  { key: "field-set:copy.bookingSubtitle", name: "Buchungs-Text", mutate: (store) => setField(store, "copy.bookingSubtitle", "In zwei Minuten erledigt.") },
  { key: "field-set:theme.primary", name: "Primärfarbe", mutate: (store) => setField(store, "theme.primary", "#123456") },
  { key: "field-set:theme.accent", name: "Akzentfarbe", mutate: (store) => setField(store, "theme.accent", "#654321") },
  { key: "field-set:testimonials.enabled", name: "Stimmen eingeschaltet, mit Inhalt", prepare: (draft) => { draft.testimonials = { enabled: false, items: [voice()] }; }, mutate: (store) => setField(store, "testimonials.enabled", true) },
  { key: "field-set:testimonials.enabled", name: "Stimmen ausgeschaltet, mit Inhalt", prepare: withVoices(voice()), mutate: (store) => setField(store, "testimonials.enabled", false) },
  { key: "field-set:testimonials.enabled", name: "Stimmen eingeschaltet, ohne Inhalt", mutate: (store) => setField(store, "testimonials.enabled", true) },

  { key: "service-field-set:name", name: "Leistungsname ohne Team", mutate: (store) => setService(store, DAMEN, "name", "Damenschnitt lang") },
  { key: "service-field-set:name", name: "Leistungsname, Person bietet sie an", prepare: withStaff(staffMember({ serviceClientIds: [DAMEN] })), mutate: (store) => setService(store, DAMEN, "name", "Damenschnitt lang") },
  { key: "service-field-set:name", name: "Leistungsname, Person bietet sie nicht an", prepare: withStaff(staffMember({ serviceClientIds: [HERREN] })), mutate: (store) => setService(store, DAMEN, "name", "Damenschnitt lang") },
  { key: "service-field-set:name", name: "Leistungsname geleert, Person bietet sie an", prepare: withStaff(staffMember({ serviceClientIds: [DAMEN] })), mutate: (store) => setService(store, DAMEN, "name", "") },
  { key: "service-field-set:category", name: "Kategorie", prepare: withStaff(staffMember({ serviceClientIds: [DAMEN] })), mutate: (store) => setService(store, DAMEN, "category", "Styling") },
  { key: "service-field-set:description", name: "Beschreibung", prepare: withStaff(staffMember({ serviceClientIds: [DAMEN] })), mutate: (store) => setService(store, DAMEN, "description", "Neu beschrieben.") },
  { key: "service-field-set:durationMinutes", name: "Dauer", prepare: withStaff(staffMember({ serviceClientIds: [DAMEN] })), mutate: (store) => setService(store, DAMEN, "durationMinutes", 90) },
  { key: "service-field-set:price", name: "Preis", prepare: withStaff(staffMember({ serviceClientIds: [DAMEN] })), mutate: (store) => setService(store, DAMEN, "price", 95) },
  { key: "service-field-set:priceType", name: "Preisart", prepare: withStaff(staffMember({ serviceClientIds: [DAMEN] })), mutate: (store) => setService(store, DAMEN, "priceType", "on-request") },
  { key: "service-field-set:bookable", name: "Buchbarkeit", prepare: withStaff(staffMember({ serviceClientIds: [DAMEN] })), mutate: (store) => setService(store, DAMEN, "bookable", false) },

  { key: "collection-insert:services", name: "Leistung hinzugefügt", mutate: (store) => insert(store, "services", "service-neu", (draft) => {
    draft.services.push({ clientId: "service-neu", slug: uniqueSlug("Neue Leistung", draft.services), category: "Schnitt", name: "Neue Leistung", description: "", durationMinutes: 30, price: 0, priceType: "fixed", bookable: true });
  }) },
  { key: "collection-remove:services", name: "Leistung entfernt, kein Team", mutate: (store) => remove(store, "services", DAMEN, (draft) => {
    draft.services = draft.services.filter((service) => service.clientId !== DAMEN);
    draft.staff.forEach((person) => { person.serviceClientIds = person.serviceClientIds.filter((id) => id !== DAMEN); });
  }) },
  { key: "collection-remove:services", name: "Leistung entfernt, Person bietet sie an", prepare: withStaff(staffMember({ serviceClientIds: [DAMEN] })), mutate: (store) => remove(store, "services", DAMEN, (draft) => {
    draft.services = draft.services.filter((service) => service.clientId !== DAMEN);
    draft.staff.forEach((person) => { person.serviceClientIds = person.serviceClientIds.filter((id) => id !== DAMEN); });
  }) },
  { key: "collection-remove:services", name: "Leistung entfernt, Person bietet sie nicht an", prepare: withStaff(staffMember({ serviceClientIds: [HERREN] })), mutate: (store) => remove(store, "services", DAMEN, (draft) => {
    draft.services = draft.services.filter((service) => service.clientId !== DAMEN);
    draft.staff.forEach((person) => { person.serviceClientIds = person.serviceClientIds.filter((id) => id !== DAMEN); });
  }) },
  { key: "collection-move:services", name: "Leistung verschoben", mutate: (store) => move(store, "services", DAMEN, (draft) => moveFirstToEnd(draft.services)) },

  { key: "staff-field-set:name", name: "Personenname geändert", prepare: withStaff(staffMember()), mutate: (store) => setStaff(store, "staff-1", "name", "Anna Neu") },
  { key: "staff-field-set:name", name: "Personenname geleert (einzige Person)", prepare: withStaff(staffMember()), mutate: (store) => setStaff(store, "staff-1", "name", "") },
  { key: "staff-field-set:name", name: "Personenname gefüllt (erste sichtbare Person)", prepare: withStaff(staffMember({ name: "" })), mutate: (store) => setStaff(store, "staff-1", "name", "Anna Beispiel") },
  { key: "staff-field-set:role", name: "Rolle geändert", prepare: withStaff(staffMember()), mutate: (store) => setStaff(store, "staff-1", "role", "Inhaberin") },
  { key: "staff-field-set:role", name: "Rolle einer unsichtbaren Person", prepare: withStaff(staffMember({ active: false })), mutate: (store) => setStaff(store, "staff-1", "role", "Inhaberin") },
  { key: "staff-field-set:bio", name: "Kurztext geändert", prepare: withStaff(staffMember()), mutate: (store) => setStaff(store, "staff-1", "bio", "Seit 2010 im Beruf.") },
  { key: "staff-field-set:email", name: "Personen-E-Mail geändert", prepare: withStaff(staffMember()), mutate: (store) => setStaff(store, "staff-1", "email", "anna@studio-miro.ch") },
  { key: "staff-field-set:active", name: "Einzige Person deaktiviert", prepare: withStaff(staffMember()), mutate: (store) => setStaff(store, "staff-1", "active", false) },
  { key: "staff-field-set:active", name: "Eine von zwei Personen deaktiviert", prepare: withStaff(staffMember(), staffMember({ clientId: "staff-2", name: "Bea Beispiel" })), mutate: (store) => setStaff(store, "staff-1", "active", false) },

  { key: "staff-services-set", name: "Zuordnung einer sichtbaren Person", prepare: withStaff(staffMember()), mutate: (store) => store.mutate((draft) => { draft.staff[0].serviceClientIds = [DAMEN]; }, { intent: { type: "set-staff-services", staffClientId: "staff-1" }, history: { label: "Zuordnung" } }) },
  { key: "staff-services-set", name: "Zuordnung einer unsichtbaren Person", prepare: withStaff(staffMember({ active: false })), mutate: (store) => store.mutate((draft) => { draft.staff[0].serviceClientIds = [DAMEN]; }, { intent: { type: "set-staff-services", staffClientId: "staff-1" }, history: { label: "Zuordnung" } }) },

  { key: "collection-insert:staff", name: "Erste Person angelegt", mutate: (store) => insert(store, "staff", "staff-neu", (draft) => { draft.staff.push(staffMember({ clientId: "staff-neu", name: "Neue Person", workingHours: createClosedSchedule() })); }) },
  { key: "collection-insert:staff", name: "Zweite Person angelegt", prepare: withStaff(staffMember()), mutate: (store) => insert(store, "staff", "staff-neu", (draft) => { draft.staff.push(staffMember({ clientId: "staff-neu", name: "Neue Person", workingHours: createClosedSchedule() })); }) },
  { key: "collection-insert:staff", name: "Person ohne Namen angelegt", prepare: withStaff(staffMember()), mutate: (store) => insert(store, "staff", "staff-neu", (draft) => { draft.staff.push(staffMember({ clientId: "staff-neu", name: "", workingHours: createClosedSchedule() })); }) },
  { key: "collection-remove:staff", name: "Einzige Person entfernt", prepare: withStaff(staffMember()), mutate: (store) => remove(store, "staff", "staff-1", (draft) => { draft.staff = draft.staff.filter((person) => person.clientId !== "staff-1"); }) },
  { key: "collection-remove:staff", name: "Eine von zwei Personen entfernt", prepare: withStaff(staffMember(), staffMember({ clientId: "staff-2", name: "Bea Beispiel" })), mutate: (store) => remove(store, "staff", "staff-1", (draft) => { draft.staff = draft.staff.filter((person) => person.clientId !== "staff-1"); }) },
  { key: "collection-move:staff", name: "Person verschoben", prepare: withStaff(staffMember(), staffMember({ clientId: "staff-2", name: "Bea Beispiel" })), mutate: (store) => move(store, "staff", "staff-1", (draft) => moveFirstToEnd(draft.staff)) },

  { key: "testimonial-field-set:quote", name: "Zitat geändert", prepare: withVoices(voice(), voice({ clientId: "voice-2", name: "Tim Muster" })), mutate: (store) => setVoice(store, "voice-1", "quote", "Immer wieder gerne.") },
  { key: "testimonial-field-set:quote", name: "Zitat geleert (einzige Stimme)", prepare: withVoices(voice()), mutate: (store) => setVoice(store, "voice-1", "quote", "") },
  { key: "testimonial-field-set:name", name: "Name geändert", prepare: withVoices(voice()), mutate: (store) => setVoice(store, "voice-1", "name", "Mia Neu") },
  { key: "testimonial-field-set:detail", name: "Zusatz geändert", prepare: withVoices(voice()), mutate: (store) => setVoice(store, "voice-1", "detail", "Stammkundin") },
  { key: "testimonial-field-set:detail", name: "Zusatz einer unfertigen Stimme", prepare: withVoices(voice({ name: "" })), mutate: (store) => setVoice(store, "voice-1", "detail", "Stammkundin") },

  { key: "collection-insert:testimonials", name: "Erste Stimme angelegt", mutate: (store) => insert(store, "testimonials", "voice-neu", (draft) => {
    draft.testimonials.items.push({ clientId: "voice-neu", quote: "", name: "", detail: "" });
    draft.testimonials.enabled = true;
  }) },
  { key: "collection-insert:testimonials", name: "Weitere Stimme neben einer sichtbaren angelegt", prepare: withVoices(voice()), mutate: (store) => insert(store, "testimonials", "voice-neu", (draft) => {
    draft.testimonials.items.push({ clientId: "voice-neu", quote: "", name: "", detail: "" });
    draft.testimonials.enabled = true;
  }) },
  { key: "collection-remove:testimonials", name: "Einzige Stimme entfernt", prepare: withVoices(voice()), mutate: (store) => remove(store, "testimonials", "voice-1", (draft) => {
    draft.testimonials.items = draft.testimonials.items.filter((item) => item.clientId !== "voice-1");
    if (!draft.testimonials.items.length) draft.testimonials.enabled = false;
  }) },
  { key: "collection-remove:testimonials", name: "Eine von zwei Stimmen entfernt", prepare: withVoices(voice(), voice({ clientId: "voice-2", name: "Tim Muster" })), mutate: (store) => remove(store, "testimonials", "voice-1", (draft) => {
    draft.testimonials.items = draft.testimonials.items.filter((item) => item.clientId !== "voice-1");
  }) },
  { key: "collection-move:testimonials", name: "Stimme verschoben", prepare: withVoices(voice(), voice({ clientId: "voice-2", name: "Tim Muster" })), mutate: (store) => move(store, "testimonials", "voice-1", (draft) => moveFirstToEnd(draft.testimonials.items)) },

  { key: "business-hours-set", name: "Öffnungstag geschlossen", mutate: (store) => store.mutate((draft) => { draft.businessHours = draft.businessHours.map((day) => day.dayOfWeek === 3 ? { ...day, closed: true, ranges: [] } : day); }, { intent: { type: "set-business-hours" }, history: { label: "Zeiten" } }) },
  { key: "staff-hours-set", name: "Persönliche Arbeitszeiten", prepare: withStaff(staffMember({ workingHours: createClosedSchedule() })), mutate: (store) => store.mutate((draft) => {
    const person = draft.staff[0];
    person.workingHours = person.workingHours.map((day) => day.dayOfWeek === 3 ? { ...day, closed: false, ranges: [{ from: "09:00", to: "17:00" }] } : day);
  }, { intent: { type: "set-staff-hours", staffClientId: "staff-1" }, history: { label: "Arbeitszeiten" } }) },

  { key: "theme-set", name: "Farbwelt gewechselt", mutate: (store) => store.mutate((draft) => { draft.theme.preset = "bold"; draft.theme.primary = "#311b4d"; draft.theme.accent = "#f0a32f"; }, { intent: { type: "set-theme" }, history: { label: "Farbwelt" } }) },
  { key: "draft-replace", name: "Entwurf ersetzt", mutate: (store) => store.replace(createDefaultDraft("2026-07-23T10:00:00.000Z"), false, "reset") },
  { key: "unverified-batch", name: "Unbeschriebene Sammeländerung", mutate: (store) => store.mutate((draft) => { draft.salon.city = "Bern"; draft.copy.heroTitle = "Anders"; }, { intent: { type: "batch" }, history: { label: "Sammeländerung" } }) },
];

// --- Prüfstand -------------------------------------------------------------------------------

const parse = (html) => new JSDOM(html).window.document;
const render = (draft) => buildWebsiteHtml(cloneDraft(draft), RENDER_OPTIONS);

function regionHtml(doc) {
  const map = new Map();
  for (const element of doc.querySelectorAll("[data-preview-region]")) map.set(element.getAttribute("data-preview-region"), element.outerHTML);
  return map;
}

function changedRegions(beforeDoc, afterDoc) {
  const before = regionHtml(beforeDoc);
  const after = regionHtml(afterDoc);
  return [...new Set([...before.keys(), ...after.keys()])].filter((region) => before.get(region) !== after.get(region)).sort();
}

/** Wende den Plan auf das alte Dokument an — genau das, was die Brücke im Kind tut. */
function applyOperations(doc, operations, label) {
  for (const operation of operations) {
    if (operation.type === "replace-region") {
      const matches = [...doc.querySelectorAll("[data-preview-region]")].filter((element) => element.getAttribute("data-preview-region") === operation.region);
      assert.equal(matches.length, 1, `${label}: Region "${operation.region}" gibt es im bisherigen Dokument nicht genau einmal — das Bündel wäre abgelehnt worden`);
      const template = doc.createElement("template");
      template.innerHTML = operation.html.trim();
      matches[0].replaceWith(template.content.firstElementChild);
    } else if (operation.type === "patch-text") {
      const key = JSON.stringify(operation.target);
      const matches = [...doc.querySelectorAll("[data-preview-target]")].filter((element) => element.getAttribute("data-preview-target") === key
        && (operation.occurrence === undefined || element.getAttribute("data-preview-occurrence") === operation.occurrence));
      assert.equal(matches.length, 1, `${label}: Textziel ${key} kommt nicht genau einmal vor`);
      matches[0].textContent = operation.value;
    }
    // patch-theme schreibt zwei Custom Properties auf <html> und das theme-color-Meta — beides
    // ausserhalb von <body> und damit ausserhalb dieses Vergleichs.
  }
}

function runScenario(scenario) {
  const draft = createDefaultDraft("2026-07-23T09:00:00.000Z");
  scenario.prepare?.(draft);
  const store = new BuilderStore(draft, new MemoryDraftRepository(), 1000);
  const before = cloneDraft(store.snapshot);
  const mutation = scenario.mutate(store);
  assert.ok(mutation, `${scenario.name}: die Mutation wurde nicht angenommen`);
  const beforeHtml = render(before);
  const afterHtml = render(store.snapshot);
  const plan = planPreviewUpdate([mutation], store.snapshot, PLAN_OPTIONS);
  const operations = plan.kind === "patch" ? plan.operations : [];
  return {
    scenario,
    mutation,
    plan,
    beforeHtml,
    afterHtml,
    operations,
    requested: operations.filter((operation) => operation.type === "replace-region").map((operation) => operation.region),
    changed: changedRegions(parse(beforeHtml), parse(afterHtml)),
  };
}

let cached = null;
const results = () => (cached ??= SCENARIOS.map(runScenario));

test("Unterdeckung: der gepatchte Stand ist Zeichen für Zeichen der Vollrender", () => {
  for (const result of results()) {
    // Ein Vollrender ist per Konstruktion richtig — er ist derselbe Renderer wie der Export.
    if (result.plan.kind === "full") continue;
    const doc = parse(result.beforeHtml);
    applyOperations(doc, result.operations, result.scenario.name);
    assert.equal(
      doc.body.innerHTML,
      parse(result.afterHtml).body.innerHTML,
      `${result.scenario.name}: gepatchter Stand ≠ Vollrender. Tatsächlich geändert: [${result.changed.join(", ") || "nichts"}], angefordert: [${result.requested.join(", ") || "nichts"}]`,
    );
  }
});

test("Überdeckung: keine Region wird angefordert, die sich nie ändert", (t) => {
  const requested = new Map();
  const proven = new Map();
  const precautionary = [];
  for (const result of results()) {
    const key = result.scenario.key;
    if (!requested.has(key)) { requested.set(key, new Set()); proven.set(key, new Set()); }
    result.requested.forEach((region) => requested.get(key).add(region));
    result.requested.filter((region) => result.changed.includes(region)).forEach((region) => proven.get(key).add(region));
    const extra = result.requested.filter((region) => !result.changed.includes(region));
    if (extra.length) precautionary.push(`${result.scenario.name} → ${extra.join(", ")}`);
  }
  if (precautionary.length) {
    t.diagnostic(`Vorsorglich getauschte Regionen (zulässig nur dort, wo der Entwurf nach der Änderung nicht mehr hergibt, ob sich etwas bewegt hat):\n  ${precautionary.join("\n  ")}`);
  }
  for (const [key, regions] of requested) {
    for (const region of regions) {
      assert.ok(proven.get(key).has(region), `Überdeckung: "${key}" fordert die Region "${region}" an, die sich in keinem Szenario ändert`);
    }
  }
});

test("der Prüfstand deckt jede Mutationsart und jedes bindbare Feld ab", () => {
  const effects = new Set(results().map((result) => result.mutation.effect.type));
  const expectedEffects = [
    "field-set", "service-field-set", "testimonial-field-set", "staff-field-set", "staff-services-set",
    "business-hours-set", "staff-hours-set", "collection-insert", "collection-remove", "collection-move",
    "theme-set", "draft-replace", "unverified-batch",
  ];
  for (const type of expectedEffects) assert.ok(effects.has(type), `Mutationsart "${type}" ist im Prüfstand nicht abgedeckt`);
  assert.deepEqual([...effects].sort(), [...expectedEffects].sort(), "der Prüfstand kennt eine Mutationsart, die hier nicht gelistet ist");

  const fields = new Set(results().filter((result) => result.mutation.effect.type === "field-set").map((result) => result.mutation.effect.field));
  for (const field of EDITABLE_FIELDS) assert.ok(fields.has(field), `Das bindbare Feld "${field}" hat kein Szenario`);
});

test("die belegten Abhängigkeiten der Kopf-Navigation", () => {
  const byName = new Map(results().map((result) => [result.scenario.name, result]));
  // M-1: Die Kopfzeile blendet die Sprungmarken "Team" und "Stimmen" ein, sobald es die Abschnitte
  // gibt. Ein solcher Übergang ändert immer zwei Regionen, und eine davon existiert im Dokument noch
  // gar nicht — deshalb ist er nie ein Patch, sondern ein Neuaufbau, und der Planer entscheidet das
  // selbst statt es das Vorschau-Dokument ablehnen zu lassen.
  for (const name of ["Erste Person angelegt", "Personenname gefüllt (erste sichtbare Person)", "Stimmen eingeschaltet, mit Inhalt"]) {
    const result = byName.get(name);
    assert.equal(result.plan.kind, "full", `${name}: 0 → n muss zum Neuaufbau führen`);
    assert.equal(result.plan.reason, "layout");
    assert.ok(result.changed.includes("header"), `${name}: die Kopfzeile ändert sich hier tatsächlich`);
  }
  for (const name of ["Einzige Person entfernt", "Personenname geleert (einzige Person)", "Einzige Person deaktiviert", "Einzige Stimme entfernt", "Zitat geleert (einzige Stimme)", "Stimmen ausgeschaltet, mit Inhalt"]) {
    const result = byName.get(name);
    assert.equal(result.plan.kind, "full", `${name}: n → 0 muss zum Neuaufbau führen`);
    assert.ok(result.changed.includes("header"), `${name}: die Kopfzeile ändert sich hier tatsächlich`);
  }
  // M-4: sieben der acht Leistungsfelder erreichen den Team-Block nicht.
  assert.deepEqual(byName.get("Dauer").requested, ["services"]);
  assert.deepEqual(byName.get("Preis").requested, ["services"]);
  assert.deepEqual(byName.get("Kategorie").requested, ["services"]);
  assert.deepEqual(byName.get("Leistungsname, Person bietet sie an").requested, ["services", "team"]);
  // M-4: der Salonname steht nur dann im Intro-Streifen, wenn dort keine Tagline steht.
  assert.deepEqual(byName.get("Salonname mit vorhandener Tagline").requested, ["header", "details", "footer"]);
  assert.deepEqual(byName.get("Salonname ohne Tagline").requested, ["header", "intro", "details", "footer"]);
});
