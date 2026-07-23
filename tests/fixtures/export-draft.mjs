// The frozen draft behind the export byte-equality gate.
//
// It is deliberately rich: every branch the exported page can take has to be represented here,
// otherwise the gate would pass while an unrepresented branch drifts. The draft is built by hand
// instead of via createDefaultDraft() so a later change to the default content cannot silently
// rewrite the baseline.
import { createClosedSchedule } from "../../assets/domain.js";

export const FIXED_NOW = "2026-07-23T09:00:00.000Z";
const FIXED_NOW_MS = Date.parse(FIXED_NOW);

/**
 * buildWebsiteHtml stamps the current year into the footer. The baseline would rot every new year,
 * so the year is frozen for the comparison — on both the recorded and the freshly rendered side.
 */
export function withFixedClock(run) {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED_NOW_MS);
      else super(...args);
    }
    static now() { return FIXED_NOW_MS; }
  }
  globalThis.Date = FixedDate;
  try { return run(); } finally { globalThis.Date = RealDate; }
}

function schedule() {
  const days = createClosedSchedule();
  days[1] = { dayOfWeek: 1, closed: true, ranges: [] };
  days[2] = { dayOfWeek: 2, closed: false, ranges: [{ from: "09:00", to: "12:00" }, { from: "13:30", to: "18:30" }] };
  days[3] = { dayOfWeek: 3, closed: false, ranges: [{ from: "09:00", to: "18:00" }] };
  days[4] = { dayOfWeek: 4, closed: false, ranges: [{ from: "09:00", to: "20:00" }] };
  days[5] = { dayOfWeek: 5, closed: false, ranges: [{ from: "09:00", to: "18:00" }] };
  days[6] = { dayOfWeek: 6, closed: false, ranges: [{ from: "08:00", to: "15:00" }] };
  return days;
}

export function exportFixtureDraft() {
  return {
    schemaVersion: 2,
    draftId: "draft-export-baseline",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    salon: {
      name: "Studio Miro & Söhne",
      tagline: "Coiffeur mit \"Handschrift\"",
      phone: "+41 44 000 00 00",
      email: "hallo@studio-miro.ch",
      address: "Musterstrasse 8",
      postalCode: "8000",
      city: "Zürich",
      instagram: "https://instagram.com/studio-miro",
    },
    copy: {
      heroLabel: "Schönes Haar beginnt mit guter Beratung",
      heroTitle: "Schnitt, Farbe & Pflege, die zu dir passen.",
      heroSubtitle: "Persönliche Beratung, ehrliches Handwerk und ein Termin, der sich einfach online buchen lässt.",
      servicesTitle: "Leistungen und Preise",
      servicesSubtitle: "Wähle die passende Behandlung. Dauer und Preis sind transparent angegeben.",
      bookingTitle: "Bereit für deinen nächsten Termin?",
      bookingSubtitle: "Die Online-Buchung wird beim Veröffentlichen automatisch eingerichtet.",
    },
    services: [
      { clientId: "service-damenschnitt", slug: "damenschnitt", category: "Schnitt", name: "Damenschnitt", description: "Beratung, Waschen, Schneiden und Föhnen", durationMinutes: 60, price: 85, priceType: "from", bookable: true },
      { clientId: "service-herrenschnitt", slug: "herrenschnitt", category: "Schnitt", name: "Herrenschnitt", description: "", durationMinutes: 30, price: 55, priceType: "fixed", bookable: false },
      { clientId: "service-balayage", slug: "balayage", category: "Farbe", name: "Balayage", description: "Individuelle Freihandtechnik <inklusive> Glossing", durationMinutes: 180, price: 0, priceType: "on-request", bookable: true },
      { clientId: "service-leer", slug: "leer", category: "Farbe", name: "   ", description: "Wird nicht gerendert", durationMinutes: 30, price: 10, priceType: "fixed", bookable: true },
    ],
    staff: [
      { clientId: "staff-anna", name: "Anna Muster", email: "anna@studio-miro.ch", role: "Inhaberin", bio: "Spezialisiert auf Farbe.", specialties: [], active: true, serviceClientIds: ["service-damenschnitt", "service-balayage"], workingHours: schedule(), portraitAssetLocalId: null },
      { clientId: "staff-bruno", name: "Bruno Beispiel", email: "", role: "", bio: "", specialties: [], active: true, serviceClientIds: [], workingHours: createClosedSchedule(), portraitAssetLocalId: null },
      { clientId: "staff-inaktiv", name: "Nicht Sichtbar", email: "", role: "Aushilfe", bio: "", specialties: [], active: false, serviceClientIds: [], workingHours: createClosedSchedule(), portraitAssetLocalId: null },
    ],
    businessHours: schedule(),
    assets: [],
    testimonials: {
      enabled: true,
      items: [
        { clientId: "voice-1", quote: "Endlich ein Salon, der zuhört.", name: "Laura M.", detail: "Stammkundin" },
        { clientId: "voice-2", quote: "Beste Beratung & Farbe.", name: "Tim R.", detail: "" },
        { clientId: "voice-3", quote: "", name: "Ohne Zitat", detail: "wird ausgelassen" },
      ],
    },
    theme: { preset: "natural", primary: "#46614f", accent: "#bb8c5a" },
    publication: { intentId: null, state: "LOCAL", lastErrorCode: null },
    migration: { sourceVersion: 1, legacyHeroImageUrl: "https://example.test/alt.jpg", migratedAt: FIXED_NOW },
  };
}
