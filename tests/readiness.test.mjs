import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultDraft, createDefaultSchedule, getTeamReadinessIssues } from "../assets/domain.js";
import { evaluateReadiness } from "../assets/readiness.js";
import { isPreviewTargetShape } from "../assets/preview-contract.js";

// Die Mängelliste: sortiert nach Schwere, und jeder Eintrag ist ein Sprungziel.

const staffMember = (over = {}) => ({ clientId: "staff-1", name: "Anna Beispiel", email: "", role: "Coiffeuse", bio: "", specialties: [], active: true, serviceClientIds: ["service-damenschnitt", "service-herrenschnitt", "service-balayage"], workingHours: createDefaultSchedule(), portraitAssetLocalId: null, ...over });

/** Ein Entwurf, an dem nichts mehr fehlt — Ausgangspunkt für jede Einzelverletzung. */
function readyDraft() {
  const draft = createDefaultDraft("2026-07-23T09:00:00.000Z");
  draft.staff = [staffMember()];
  return draft;
}

const ids = (draft) => evaluateReadiness(draft).results.map((item) => item.id);

test("ein vollständiger Entwurf meldet nichts und gilt als bereit", () => {
  const summary = evaluateReadiness(readyDraft());
  assert.deepEqual(summary.results, []);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.warningCount, 0);
  assert.equal(summary.ready, true);
  assert.equal(summary.clean, true);
});

test("jeder Eintrag nennt ein Ziel, das der Vorschau-Vertrag anerkennt", () => {
  const draft = readyDraft();
  draft.salon.name = "";
  draft.salon.phone = "keine nummer";
  draft.salon.email = "";
  draft.salon.instagram = "https://example.test/nicht-instagram";
  draft.copy.heroTitle = "";
  draft.copy.heroSubtitle = "";
  draft.services[0].name = "";
  draft.services[1].price = 0;
  draft.staff = [];
  const summary = evaluateReadiness(draft);
  assert.ok(summary.results.length >= 8, `es fehlen Einträge: ${summary.results.length}`);
  for (const item of summary.results) {
    assert.equal(isPreviewTargetShape(item.target), true, `${item.id} zeigt auf ein unbekanntes Ziel`);
  }
});

test("Blocker stehen vor Hinweisen, sonst gilt die Regelreihenfolge", () => {
  const draft = readyDraft();
  draft.salon.instagram = "https://example.test/nicht-instagram"; // Hinweis, Regel 23
  draft.salon.name = ""; // Blocker, Regel 10
  draft.copy.heroSubtitle = ""; // Hinweis, Regel 32
  draft.staff = []; // Blocker, Regel 60
  const summary = evaluateReadiness(draft);
  assert.deepEqual(summary.results.map((item) => item.severity), ["error", "error", "warning", "warning"]);
  assert.deepEqual(summary.results.map((item) => item.id), [
    "identity:salon-name",
    "team:NO_ACTIVE_STAFF:0",
    "contact:instagram",
    "copy:hero-subtitle",
  ]);
  assert.equal(summary.ready, false);
});

test("ausgefüllt ist nicht brauchbar: die dreiwertige Presence entscheidet", () => {
  const draft = readyDraft();
  draft.salon.phone = "12";
  draft.salon.email = "das-ist-keine-mail";
  const summary = evaluateReadiness(draft);
  // Beides ist ausgefüllt und trotzdem unbrauchbar: ein Blocker plus zwei benannte Hinweise.
  assert.deepEqual(summary.results.map((item) => item.id), ["contact:none", "contact:phone", "contact:email"]);
  assert.deepEqual(summary.results[0].target, { kind: "field", field: "salon.phone" });
  assert.equal(draft.salon.email, "das-ist-keine-mail", "der Entwurf behält, was getippt wurde");
});

test("eine leere Kontaktangabe führt auf das Feld, an dem noch nichts steht", () => {
  const draft = readyDraft();
  draft.salon.phone = "";
  draft.salon.email = "";
  const [first] = evaluateReadiness(draft).results;
  assert.equal(first.id, "contact:none");
  assert.deepEqual(first.target, { kind: "field", field: "salon.phone" });
});

test("Leistungen: fehlender Name blockiert, fehlender Preis ist ein Hinweis", () => {
  const draft = readyDraft();
  draft.services[0].name = "";
  draft.services[1].price = 0;
  draft.services[1].priceType = "fixed";
  const summary = evaluateReadiness(draft);
  const byId = new Map(summary.results.map((item) => [item.id, item]));
  assert.equal(byId.get(`services:${draft.services[0].clientId}:name`).severity, "error");
  const price = byId.get(`services:${draft.services[1].clientId}:price`);
  assert.equal(price.severity, "warning");
  assert.deepEqual(price.target, { kind: "service", serviceClientId: draft.services[1].clientId, field: "name" });
});

test("„Auf Anfrage“ ist ein Preis und erzeugt deshalb keinen Hinweis", () => {
  const draft = readyDraft();
  draft.services[0].price = 0;
  draft.services[0].priceType = "on-request";
  assert.deepEqual(ids(draft), []);
});

test("doppelte Leistungsnamen melden beide Karten, nicht nur eine", () => {
  const draft = readyDraft();
  draft.services[1].name = " damenschnitt ";
  const duplicates = evaluateReadiness(draft).results.filter((item) => item.id.endsWith(":duplicate"));
  assert.deepEqual(duplicates.map((item) => item.target.serviceClientId).sort(), [draft.services[0].clientId, draft.services[1].clientId].sort());
});

test("Öffnungszeiten: ganz geschlossen und ungültig sind beides Blocker", () => {
  const closed = readyDraft();
  closed.businessHours = closed.businessHours.map((day) => ({ ...day, closed: true, ranges: [] }));
  assert.ok(ids(closed).includes("hours:all-closed"));

  const broken = readyDraft();
  broken.businessHours[2].ranges = [{ from: "18:00", to: "09:00" }];
  const invalid = evaluateReadiness(broken).results.filter((item) => item.id.startsWith("hours:invalid"));
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].severity, "error");
  assert.deepEqual(invalid[0].target, { kind: "panel", panel: "hours" });
});

test("jeder Team-Code des Aktivierungsvertrags erscheint unverändert als eigener Eintrag", () => {
  const draft = readyDraft();
  draft.staff = [staffMember({ name: "", serviceClientIds: [], workingHours: createDefaultSchedule().map((day) => ({ ...day, closed: true, ranges: [] })) })];
  const issues = getTeamReadinessIssues(draft);
  const results = evaluateReadiness(draft).results.filter((item) => item.id.startsWith("team:"));
  // Die Codes bleiben die Codes: die Liste übersetzt sie nur in Überschrift und Sprungziel.
  assert.deepEqual(results.map((item) => item.id.split(":")[1]), issues.map((issue) => issue.code));
  assert.deepEqual(results.map((item) => item.detail), issues.map((issue) => issue.message));
  results.forEach((item) => assert.equal(item.severity, "error"));
  assert.deepEqual(results[0].target, { kind: "staff", staffClientId: "staff-1", field: "name" });
});

test("ein Team-Befund ohne Person führt in den Team-Bereich statt ins Leere", () => {
  const draft = readyDraft();
  draft.staff = [staffMember({ serviceClientIds: ["service-damenschnitt"] })];
  const results = evaluateReadiness(draft).results.filter((item) => item.id.startsWith("team:SERVICE_WITHOUT_STAFF"));
  assert.equal(results.length, 2, "zwei buchbare Leistungen bleiben unbesetzt");
  results.forEach((item) => assert.deepEqual(item.target, { kind: "panel", panel: "team" }));
});
