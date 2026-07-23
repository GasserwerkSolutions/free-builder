import test from "node:test";
import assert from "node:assert/strict";
import {
  PRESETS,
  copyBusinessHoursToStaff,
  createDefaultDraft,
  createStaffDraft,
  normalizeDraftV2,
  setAllBookableServicesForStaff,
  setAtPath,
  setDayClosed,
  uniqueSlug,
} from "../assets/domain.js";
import { MemoryDraftRepository } from "../assets/persistence.js";
import { BuilderStore } from "../assets/store.js";
import {
  createDraftEffect,
  draftsEqualIgnoringUpdatedAt,
  invertDraftEffect,
  requiresSnapshotInversion,
} from "../assets/draft-mutations.js";

const FIXED_NOW = "2026-07-17T12:00:00.000Z";

function baseDraft() {
  const draft = createDefaultDraft(FIXED_NOW);
  const person = { ...createStaffDraft(), clientId: "staff-anna", name: "Anna", serviceClientIds: ["service-damenschnitt"] };
  draft.staff.push(person);
  return normalizeDraftV2(draft);
}

test("updatedAt allein ist keine Mutation", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.updatedAt = "2026-08-01T00:00:00.000Z";
  assert.equal(draftsEqualIgnoringUpdatedAt(before, after), true);
  assert.throws(() => createDraftEffect(before, after, { type: "set-field", field: "salon.name" }), /MUTATION_EFFECT_FOR_NOOP/);
});

test("Feld-Effekt wird verifiziert und eine fremde Zweitänderung fliegt raus", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.copy.heroTitle = "Neuer Titel";
  assert.deepEqual(createDraftEffect(before, after, { type: "set-field", field: "copy.heroTitle" }), {
    type: "field-set", field: "copy.heroTitle", previousPresence: "present", nextPresence: "present",
  });
  after.salon.name = "Unzulässige zweite Änderung";
  assert.throws(() => createDraftEffect(before, after, { type: "set-field", field: "copy.heroTitle" }), /UNEXPECTED_FIELD_CHANGE/);
});

test("eine Absicht, die das falsche Feld benennt, wird abgewiesen", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.salon.name = "Anderer Salon";
  assert.throws(() => createDraftEffect(before, after, { type: "set-field", field: "copy.heroTitle" }), /INVALID_FIELD_SET|UNEXPECTED_FIELD_CHANGE/);
});

test("das Umbenennen einer Leistung darf den Slug mitziehen, aber nichts anderes", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.services[0].name = "Ansatzfarbe";
  after.services[0].slug = "ansatzfarbe";
  assert.deepEqual(createDraftEffect(before, after, { type: "set-service-field", serviceClientId: "service-damenschnitt", field: "name" }), {
    type: "service-field-set", serviceClientId: "service-damenschnitt", field: "name", previousPresence: "present", nextPresence: "present",
  });
  after.services[1].price = 999;
  assert.throws(() => createDraftEffect(before, after, { type: "set-service-field", serviceClientId: "service-damenschnitt", field: "name" }), /UNEXPECTED_SERVICE_FIELD_CHANGE/);
});

test("eine Umbenennung, die nur den abgeleiteten Slug nachzieht, bleibt gültig", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  // Ein frei gewordener Basis-Slug rückt nach, der Name bleibt netto unverändert.
  after.services[0].slug = "damenschnitt-frei";
  assert.deepEqual(createDraftEffect(before, after, { type: "set-service-field", serviceClientId: "service-damenschnitt", field: "name" }), {
    type: "service-field-set", serviceClientId: "service-damenschnitt", field: "name", previousPresence: "present", nextPresence: "present",
  });
  // Fremdes läuft weiterhin nicht mit.
  after.services[0].description = "Heimlich geändert";
  assert.throws(() => createDraftEffect(before, after, { type: "set-service-field", serviceClientId: "service-damenschnitt", field: "name" }), /UNEXPECTED_SERVICE_FIELD_CHANGE/);
});

test("eine Absicht ohne abgeleitetes Feld verlangt weiterhin eine Änderung genau dieses Feldes", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.services[0].slug = "damenschnitt-frei";
  assert.throws(() => createDraftEffect(before, after, { type: "set-service-field", serviceClientId: "service-damenschnitt", field: "price" }), /INVALID_SERVICE_FIELD_SET/);
});

test("eine Preisänderung darf den Slug nicht mitverändern", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.services[0].price = 120;
  after.services[0].slug = "heimlich-umbenannt";
  assert.throws(() => createDraftEffect(before, after, { type: "set-service-field", serviceClientId: "service-damenschnitt", field: "price" }), /UNEXPECTED_SERVICE_FIELD_CHANGE/);
});

test("Sammlungs-Einfügung und ihre Inversion nutzen den geprüften Index", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.services.splice(1, 0, { ...before.services[0], clientId: "service-neu", slug: "service-neu", name: "Neue Leistung" });
  const effect = createDraftEffect(before, after, { type: "insert-collection-item", collection: "services", clientId: "service-neu" });
  assert.deepEqual(effect, { type: "collection-insert", collection: "services", clientId: "service-neu", index: 1 });
  assert.deepEqual(invertDraftEffect(effect), { type: "collection-remove", collection: "services", clientId: "service-neu", previousIndex: 1 });
});

test("das Entfernen einer Leistung darf nur die Zuordnungen mitziehen", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.services = after.services.filter((service) => service.clientId !== "service-damenschnitt");
  after.staff.forEach((person) => { person.serviceClientIds = person.serviceClientIds.filter((id) => id !== "service-damenschnitt"); });
  assert.deepEqual(createDraftEffect(before, after, { type: "remove-collection-item", collection: "services", clientId: "service-damenschnitt" }), {
    type: "collection-remove", collection: "services", clientId: "service-damenschnitt", previousIndex: 0,
  });
  after.staff[0].name = "Heimlich umbenannt";
  assert.throws(() => createDraftEffect(before, after, { type: "remove-collection-item", collection: "services", clientId: "service-damenschnitt" }), /UNEXPECTED_COLLECTION_REMOVE_DRAFT_CHANGE/);
});

test("Öffnungszeiten-Absicht lehnt eine gleichzeitige Arbeitszeiten-Änderung ab", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.businessHours = setDayClosed(after.businessHours, 2, true);
  assert.deepEqual(createDraftEffect(before, after, { type: "set-business-hours" }), {
    type: "business-hours-set", previousOpenDays: 5, nextOpenDays: 4,
  });
  after.staff[0].workingHours = setDayClosed(after.staff[0].workingHours, 3, false);
  assert.throws(() => createDraftEffect(before, after, { type: "set-business-hours" }), /UNEXPECTED_BUSINESS_HOURS_CHANGE/);
});

test("Arbeitszeiten-Absicht lehnt eine gleichzeitige Öffnungszeiten-Änderung ab", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.staff[0].workingHours = setDayClosed(after.staff[0].workingHours, 3, false);
  assert.deepEqual(createDraftEffect(before, after, { type: "set-staff-hours", staffClientId: "staff-anna" }), {
    type: "staff-hours-set", staffClientId: "staff-anna", previousOpenDays: 0, nextOpenDays: 1,
  });
  after.businessHours = setDayClosed(after.businessHours, 2, true);
  assert.throws(() => createDraftEffect(before, after, { type: "set-staff-hours", staffClientId: "staff-anna" }), /UNEXPECTED_STAFF_HOURS_CHANGE/);
});

test("die Leistungszuordnung einer Person ist ihr eigener Änderungsbereich", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.staff[0].serviceClientIds = ["service-damenschnitt", "service-balayage"];
  const effect = createDraftEffect(before, after, { type: "set-staff-services", staffClientId: "staff-anna" });
  assert.deepEqual(effect, { type: "staff-services-set", staffClientId: "staff-anna", previousCount: 1, nextCount: 2 });
  assert.deepEqual(invertDraftEffect(effect), { type: "staff-services-set", staffClientId: "staff-anna", previousCount: 2, nextCount: 1 });
  after.staff[0].active = false;
  assert.throws(() => createDraftEffect(before, after, { type: "set-staff-services", staffClientId: "staff-anna" }), /UNEXPECTED_STAFF_SERVICES_CHANGE/);
});

test("Verschiebe-Effekt invertiert die tatsächliche Richtung", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  const [moved] = after.services.splice(2, 1);
  after.services.splice(0, 0, moved);
  const effect = createDraftEffect(before, after, { type: "move-collection-item", collection: "services", clientId: moved.clientId });
  assert.deepEqual(effect, { type: "collection-move", collection: "services", clientId: moved.clientId, previousIndex: 2, nextIndex: 0 });
  assert.deepEqual(invertDraftEffect(effect), { type: "collection-move", collection: "services", clientId: moved.clientId, previousIndex: 0, nextIndex: 2 });
});

test("das Einfügen einer Kundenstimme darf den Abschnitts-Schalter mitziehen", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.testimonials.items.push({ clientId: "voice-1", quote: "", name: "", detail: "" });
  after.testimonials.enabled = true;
  assert.deepEqual(createDraftEffect(before, after, { type: "insert-collection-item", collection: "testimonials", clientId: "voice-1" }), {
    type: "collection-insert", collection: "testimonials", clientId: "voice-1", index: 0,
  });
});

test("Theme-Effekt ist nicht statisch invertierbar und meldet das", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.theme.preset = "bold";
  after.theme.primary = PRESETS.bold.primary;
  after.theme.accent = PRESETS.bold.accent;
  const effect = createDraftEffect(before, after, { type: "set-theme" });
  assert.deepEqual(effect, { type: "theme-set", changed: ["preset", "primary", "accent"] });
  assert.equal(requiresSnapshotInversion(effect), true);
  assert.throws(() => invertDraftEffect(effect), /THEME_EFFECT_REQUIRES_SNAPSHOT_VERIFICATION/);
});

test("eine unbeschriebene Sammel-Mutation bleibt als unverifiziert gekennzeichnet", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.salon.name = "Zwei";
  after.copy.heroTitle = "Änderungen";
  assert.deepEqual(createDraftEffect(before, after, { type: "batch" }), { type: "unverified-batch" });
  assert.equal(requiresSnapshotInversion({ type: "unverified-batch" }), false);
  assert.deepEqual(invertDraftEffect({ type: "unverified-batch" }), { type: "unverified-batch" });
});

test("eine unbrauchbare Kontaktangabe wird als invalid gemeldet, nicht als present", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.salon.email = "das-ist-keine-mail";
  assert.deepEqual(createDraftEffect(before, after, { type: "set-field", field: "salon.email" }), {
    type: "field-set", field: "salon.email", previousPresence: "present", nextPresence: "invalid",
  });
  const phoneAfter = structuredClone(before);
  phoneAfter.salon.phone = "ruf mich an";
  assert.equal(createDraftEffect(before, phoneAfter, { type: "set-field", field: "salon.phone" }).nextPresence, "invalid");
  const instagramAfter = structuredClone(before);
  instagramAfter.salon.instagram = "https://example.ch/kein-profil";
  assert.equal(createDraftEffect(before, instagramAfter, { type: "set-field", field: "salon.instagram" }).nextPresence, "invalid");
});

test("eine leere Kontaktangabe bleibt empty und eine gültige bleibt present", () => {
  const before = baseDraft();
  const empty = structuredClone(before);
  empty.salon.email = "";
  assert.equal(createDraftEffect(before, empty, { type: "set-field", field: "salon.email" }).nextPresence, "empty");
  const valid = structuredClone(before);
  valid.salon.instagram = "https://www.instagram.com/studio.miro/";
  assert.equal(createDraftEffect(before, valid, { type: "set-field", field: "salon.instagram" }).nextPresence, "present");
});

test("die E-Mail einer Person wird gleich streng bewertet wie die des Salons", () => {
  const before = baseDraft();
  const after = structuredClone(before);
  after.staff[0].email = "anna(at)example.ch";
  assert.deepEqual(createDraftEffect(before, after, { type: "set-staff-field", staffClientId: "staff-anna", field: "email" }), {
    type: "staff-field-set", staffClientId: "staff-anna", field: "email", previousPresence: "empty", nextPresence: "invalid",
  });
});

test("die gebundenen Eingabefelder decken Text, Schalter und Farbe ab", () => {
  const store = new BuilderStore(createDefaultDraft(FIXED_NOW), new MemoryDraftRepository(), 1000);
  const bind = (path, value) => store.mutate(
    (draft) => setAtPath(draft, path, value),
    { intent: { type: "set-field", field: path }, history: { key: `field:${path}`, label: "Feld angepasst" } },
  );
  assert.equal(bind("salon.city", "Bern").effect.nextPresence, "present");
  // Derselbe Wert nochmals ist keine Änderung und erzeugt weder Revision noch Speicherung.
  assert.equal(bind("salon.city", "Bern"), null);
  assert.deepEqual(bind("testimonials.enabled", true).effect, { type: "field-set", field: "testimonials.enabled", previousPresence: "empty", nextPresence: "present" });
  assert.equal(bind("theme.primary", "#123456").effect.field, "theme.primary");
  assert.equal(store.snapshot.theme.primary, "#123456");
  // Eine ungültige Farbe wird vom Normalizer auf die Preset-Farbe zurückgesetzt — auch das ist eine
  // echte, verifizierte Änderung genau dieses Feldes.
  bind("theme.primary", "kein-hex");
  assert.equal(store.snapshot.theme.primary, PRESETS.elegant.primary);
  assert.throws(() => bind("salon.gibtsNicht", "x"), /UNKNOWN_BIND_PATH/);
});

test("die realen Editor-Mutationen erfüllen ihre deklarierten Absichten", () => {
  const store = new BuilderStore(createDefaultDraft(FIXED_NOW), new MemoryDraftRepository(), 1000);
  const serviceClientId = "service-neu";

  store.mutate((draft) => {
    draft.services.push({ clientId: serviceClientId, slug: uniqueSlug("Neue Leistung", draft.services), category: "Schnitt", name: "Neue Leistung", description: "", durationMinutes: 30, price: 0, priceType: "fixed", bookable: true });
  }, { intent: { type: "insert-collection-item", collection: "services", clientId: serviceClientId }, history: { label: "Leistung hinzugefügt" } });

  store.mutate((draft) => {
    const service = draft.services.find((item) => item.clientId === serviceClientId);
    service.name = "Ansatzfarbe";
    service.slug = uniqueSlug("Ansatzfarbe", draft.services, service.clientId);
  }, { intent: { type: "set-service-field", serviceClientId, field: "name" }, history: { label: "Leistung bearbeitet" } });
  assert.equal(store.snapshot.services.at(-1).slug, "ansatzfarbe");

  const person = createStaffDraft();
  store.mutate((draft) => { draft.staff.push(person); }, { intent: { type: "insert-collection-item", collection: "staff", clientId: person.clientId }, history: { label: "Person hinzugefügt" } });

  store.mutate((draft) => setAllBookableServicesForStaff(draft, person.clientId, true), { intent: { type: "set-staff-services", staffClientId: person.clientId }, history: { label: "Alle buchbaren Leistungen zugeordnet" } });
  assert.equal(store.snapshot.staff[0].serviceClientIds.length, 4);

  store.mutate((draft) => { copyBusinessHoursToStaff(draft, person.clientId, { overwrite: true }); }, { intent: { type: "set-staff-hours", staffClientId: person.clientId }, history: { label: "Öffnungszeiten als Arbeitszeiten übernommen" } });
  assert.deepEqual(store.snapshot.staff[0].workingHours, store.snapshot.businessHours);

  store.mutate((draft) => {
    draft.services = draft.services.filter((service) => service.clientId !== serviceClientId);
    draft.staff.forEach((member) => { member.serviceClientIds = member.serviceClientIds.filter((id) => id !== serviceClientId); });
  }, { intent: { type: "remove-collection-item", collection: "services", clientId: serviceClientId }, history: { label: "Leistung entfernt" } });
  assert.equal(store.snapshot.staff[0].serviceClientIds.includes(serviceClientId), false);

  const voiceClientId = "voice-neu";
  store.mutate((draft) => {
    draft.testimonials.items.push({ clientId: voiceClientId, quote: "", name: "", detail: "" });
    draft.testimonials.enabled = true;
  }, { intent: { type: "insert-collection-item", collection: "testimonials", clientId: voiceClientId }, history: { label: "Kundenstimme hinzugefügt" } });
  store.mutate((draft) => {
    draft.testimonials.items = draft.testimonials.items.filter((item) => item.clientId !== voiceClientId);
    if (!draft.testimonials.items.length) draft.testimonials.enabled = false;
  }, { intent: { type: "remove-collection-item", collection: "testimonials", clientId: voiceClientId }, history: { label: "Kundenstimme entfernt" } });
  assert.equal(store.snapshot.testimonials.enabled, false);

  store.mutate((draft) => { draft.theme.preset = "bold"; draft.theme.primary = PRESETS.bold.primary; draft.theme.accent = PRESETS.bold.accent; },
    { intent: { type: "set-theme" }, history: { label: "Farbwelt geändert" } });
  assert.equal(store.snapshot.theme.preset, "bold");
});
