import test from "node:test";
import assert from "node:assert/strict";
import { migrateV1ToV2, normalizeDraftV2, validateWeeklySchedule } from "../assets/domain.js";

test("migrates all V1 business data without carrying booking/image URLs as live fields", () => {
  const migrated = migrateV1ToV2({
    version: 1,
    salon: { name: "Salon Test", email: "a@example.ch", bookingUrl: "https://booking.invalid/salon", heroImage: "https://images.example.ch/hero.jpg", city: "Bern" },
    copy: { heroTitle: "Hallo" },
    services: [
      { id: "cut", name: "Cut", category: "Schnitt", durationMinutes: 45, price: 70, priceType: "fixed", bookable: true },
      { id: "cut", name: "Cut Plus", durationMinutes: 60, price: 90, priceType: "from", bookable: false }
    ],
    hours: [{ day: "Montag", open: "10:00", close: "17:00", closed: false }],
    testimonials: { enabled: true, items: [{ id: "v1", quote: "Super", name: "L." }] },
    theme: { preset: "modern", primary: "#112233", accent: "#445566" }
  }, "2026-07-17T12:00:00.000Z");

  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.salon.name, "Salon Test");
  assert.equal(migrated.copy.heroTitle, "Hallo");
  assert.equal(migrated.services.length, 2);
  assert.notEqual(migrated.services[0].clientId, migrated.services[1].clientId);
  assert.equal(migrated.businessHours.find((day) => day.dayOfWeek === 1).ranges[0].from, "10:00");
  assert.equal(migrated.migration.legacyHeroImageUrl, "https://images.example.ch/hero.jpg");
  assert.equal("bookingUrl" in migrated.salon, false);
  assert.equal("heroImage" in migrated.salon, false);
  assert.equal(migrated.staff.length, 0);
  assert.equal(migrated.testimonials.items[0].quote, "Super");
});

test("rejects unknown future draft schemas instead of overwriting them", () => {
  assert.throws(() => normalizeDraftV2({ schemaVersion: 99 }), /UNSUPPORTED_DRAFT_SCHEMA/);
});

test("validates overlapping and reversed ranges", () => {
  const errors = validateWeeklySchedule([
    { dayOfWeek: 0, closed: true, ranges: [] },
    { dayOfWeek: 1, closed: false, ranges: [{ from: "12:00", to: "11:00" }] },
    { dayOfWeek: 2, closed: false, ranges: [{ from: "09:00", to: "12:00" }, { from: "11:00", to: "14:00" }] },
    { dayOfWeek: 3, closed: true, ranges: [] }, { dayOfWeek: 4, closed: true, ranges: [] }, { dayOfWeek: 5, closed: true, ranges: [] }, { dayOfWeek: 6, closed: true, ranges: [] }
  ]);
  assert.ok(errors.some((error) => error.includes("Beginn")));
  assert.ok(errors.some((error) => error.includes("überlappende")));
});

test("preserves and clamps valid asset focal points", () => {
  const draft = normalizeDraftV2({
    ...migrateV1ToV2({ version: 1 }),
    assets: [{
      localId: "hero-1",
      kind: "HERO",
      ownerClientId: null,
      fileName: "hero.jpg",
      mimeType: "image/jpeg",
      bytes: 123,
      width: 1200,
      height: 800,
      alt: "Salon",
      focalPoint: { x: 1.4, y: -0.2 },
      uploadedAssetId: null,
    }],
  });
  assert.deepEqual(draft.assets[0].focalPoint, { x: 1, y: 0 });
});
