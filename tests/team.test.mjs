import test from "node:test";
import assert from "node:assert/strict";
import {
  copyBusinessHoursToStaff,
  createDefaultDraft,
  createStaffDraft,
  getTeamReadinessIssues,
  normalizeDraftV2,
  removeStaffAndOwnedAssets,
  setAllBookableServicesForStaff,
} from "../assets/domain.js";
import { buildWebsiteHtml } from "../assets/website.js";

test("staff without explicit hours normalizes to closed days", () => {
  const draft = createDefaultDraft("2026-07-17T12:00:00.000Z");
  const normalized = normalizeDraftV2({
    ...draft,
    staff: [{
      clientId: "staff-1",
      name: "Anna",
      email: "",
      role: "Coiffeurin",
      bio: "",
      specialties: [],
      active: true,
      serviceClientIds: [draft.services[0].clientId],
      portraitAssetLocalId: null,
    }],
  });
  assert.equal(normalized.staff[0].workingHours.every((day) => day.closed), true);
});

test("doppelte Personen-IDs werden wie doppelte Leistungs-IDs eindeutig gemacht", () => {
  const draft = createDefaultDraft("2026-07-17T12:00:00.000Z");
  const normalized = normalizeDraftV2({
    ...draft,
    staff: [
      { clientId: "staff-doppelt", name: "Anna" },
      { clientId: "staff-doppelt", name: "Bea" },
      { clientId: "", name: "Cem" },
    ],
  });
  assert.equal(normalized.staff.length, 3);
  assert.equal(new Set(normalized.staff.map((person) => person.clientId)).size, 3);
  assert.ok(normalized.staff.every((person) => person.clientId));
});

test("team readiness requires explicit services, hours and coverage", () => {
  const draft = createDefaultDraft("2026-07-17T12:00:00.000Z");
  draft.staff.push(createStaffDraft());
  let issues = getTeamReadinessIssues(draft);
  assert.ok(issues.some((issue) => issue.code === "STAFF_WITHOUT_SERVICE"));
  assert.ok(issues.some((issue) => issue.code === "STAFF_WITHOUT_HOURS"));
  assert.ok(issues.some((issue) => issue.code === "SERVICE_WITHOUT_STAFF"));

  setAllBookableServicesForStaff(draft, draft.staff[0].clientId, true);
  copyBusinessHoursToStaff(draft, draft.staff[0].clientId);
  issues = getTeamReadinessIssues(draft);
  assert.equal(issues.length, 0);
});

test("removing staff cascades owned asset metadata", () => {
  const draft = createDefaultDraft("2026-07-17T12:00:00.000Z");
  const person = createStaffDraft();
  person.portraitAssetLocalId = "portrait-1";
  draft.staff.push(person);
  draft.assets.push({
    localId: "portrait-1",
    kind: "PORTRAIT",
    ownerClientId: person.clientId,
    fileName: "portrait.jpg",
    mimeType: "image/jpeg",
    bytes: 123,
    width: 512,
    height: 512,
    alt: "Anna",
    focalPoint: null,
    uploadedAssetId: null,
  });
  removeStaffAndOwnedAssets(draft, person.clientId);
  assert.equal(draft.staff.length, 0);
  assert.equal(draft.assets.length, 0);
});

test("website projects active team and JSON-LD employee data", () => {
  const draft = createDefaultDraft("2026-07-17T12:00:00.000Z");
  const person = createStaffDraft();
  person.name = "Anna Muster";
  person.role = "Coloristin";
  person.bio = "Spezialisiert auf Balayage.";
  draft.staff.push(person);
  setAllBookableServicesForStaff(draft, person.clientId, true);
  copyBusinessHoursToStaff(draft, person.clientId);
  const html = buildWebsiteHtml(draft);
  assert.match(html, /id="team"/);
  assert.match(html, /Anna Muster/);
  assert.match(html, /"employee"/);
  assert.match(html, /"knowsAbout"/);
});
