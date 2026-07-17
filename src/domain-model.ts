export const SCHEMA_VERSION = 2 as const;
export const MAX_TESTIMONIALS = 3;
export const LEGACY_STORAGE_KEY = "gasserwerk-free-salon-builder-v1";
export const ACTIVE_DRAFT_POINTER_KEY = "gasserwerk-free-salon-builder-active-draft";

export type ThemePresetName = "elegant" | "modern" | "natural" | "bold";
export type PriceType = "fixed" | "from" | "on-request";
export type PublicationState = "LOCAL" | "EMAIL_SENT" | "VERIFIED" | "ACTIVATING" | "PUBLISHED" | "FAILED";
export type AssetKind = "HERO" | "PORTRAIT" | "GALLERY" | "LOGO";
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type TimeRange = { from: string; to: string };
export type ScheduleDay = { dayOfWeek: DayOfWeek; closed: boolean; ranges: TimeRange[] };
export type WeeklySchedule = ScheduleDay[];

export type BuilderService = {
  clientId: string;
  slug: string;
  category: string;
  name: string;
  description: string;
  durationMinutes: number;
  price: number;
  priceType: PriceType;
  bookable: boolean;
};

export type BuilderStaff = {
  clientId: string;
  name: string;
  email: string;
  role: string;
  bio: string;
  specialties: string[];
  active: boolean;
  serviceClientIds: string[];
  workingHours: WeeklySchedule;
  portraitAssetLocalId: string | null;
};

export type BuilderAssetRef = {
  localId: string;
  kind: AssetKind;
  ownerClientId: string | null;
  fileName: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alt: string;
  focalPoint: { x: number; y: number } | null;
  uploadedAssetId: string | null;
};

export type ManualTestimonial = { clientId: string; quote: string; name: string; detail: string };

export type BuilderDraftV2 = {
  schemaVersion: 2;
  draftId: string;
  createdAt: string;
  updatedAt: string;
  salon: {
    name: string;
    tagline: string;
    phone: string;
    email: string;
    address: string;
    postalCode: string;
    city: string;
    instagram: string;
  };
  copy: {
    heroLabel: string;
    heroTitle: string;
    heroSubtitle: string;
    servicesTitle: string;
    servicesSubtitle: string;
    bookingTitle: string;
    bookingSubtitle: string;
  };
  services: BuilderService[];
  staff: BuilderStaff[];
  businessHours: WeeklySchedule;
  assets: BuilderAssetRef[];
  testimonials: { enabled: boolean; items: ManualTestimonial[] };
  theme: { preset: ThemePresetName; primary: string; accent: string };
  publication: {
    intentId: string | null;
    state: PublicationState;
    lastErrorCode: string | null;
  };
  migration: {
    sourceVersion: 1 | null;
    legacyHeroImageUrl: string | null;
    migratedAt: string | null;
  };
};

export type LegacyDraftV1 = {
  version?: number;
  salon?: Record<string, unknown>;
  copy?: Record<string, unknown>;
  services?: unknown[];
  hours?: unknown[];
  testimonials?: unknown;
  theme?: unknown;
};

export const PRESETS = {
  elegant: { primary: "#6f4f43", accent: "#caa485", bg: "#fffaf7", surface: "#f5ece6", text: "#241f1c", display: "Georgia, 'Times New Roman', serif", body: "Inter, system-ui, sans-serif", radius: "20px" },
  modern: { primary: "#151515", accent: "#d15f35", bg: "#ffffff", surface: "#f3f3f1", text: "#151515", display: "Inter, system-ui, sans-serif", body: "Inter, system-ui, sans-serif", radius: "10px" },
  natural: { primary: "#46614f", accent: "#bb8c5a", bg: "#fbfaf4", surface: "#edf1e9", text: "#243028", display: "Georgia, 'Times New Roman', serif", body: "Inter, system-ui, sans-serif", radius: "24px" },
  bold: { primary: "#311b4d", accent: "#f0a32f", bg: "#fff8ec", surface: "#f2e5ff", text: "#25192f", display: "Arial Black, Inter, system-ui, sans-serif", body: "Inter, system-ui, sans-serif", radius: "4px" },
} satisfies Record<ThemePresetName, { primary: string; accent: string; bg: string; surface: string; text: string; display: string; body: string; radius: string }>;

const DAY_NAMES: Record<DayOfWeek, string> = { 0: "Sonntag", 1: "Montag", 2: "Dienstag", 3: "Mittwoch", 4: "Donnerstag", 5: "Freitag", 6: "Samstag" };
const ENGLISH_DAY_NAMES: Record<DayOfWeek, string> = { 0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday" };

export function dayName(dayOfWeek: DayOfWeek): string { return DAY_NAMES[dayOfWeek]; }
export function englishDay(dayOfWeek: DayOfWeek): string { return ENGLISH_DAY_NAMES[dayOfWeek]; }

export function createClientId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.();
  if (id) return `${prefix}-${id}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createClosedSchedule(): WeeklySchedule {
  return ([0, 1, 2, 3, 4, 5, 6] as DayOfWeek[]).map((dayOfWeek) => ({ dayOfWeek, closed: true, ranges: [] }));
}

export function createDefaultSchedule(): WeeklySchedule {
  const defaults: Record<DayOfWeek, { closed: boolean; ranges: TimeRange[] }> = {
    0: { closed: true, ranges: [] },
    1: { closed: true, ranges: [] },
    2: { closed: false, ranges: [{ from: "09:00", to: "18:00" }] },
    3: { closed: false, ranges: [{ from: "09:00", to: "18:00" }] },
    4: { closed: false, ranges: [{ from: "09:00", to: "20:00" }] },
    5: { closed: false, ranges: [{ from: "09:00", to: "18:00" }] },
    6: { closed: false, ranges: [{ from: "08:00", to: "15:00" }] },
  };
  return ([0, 1, 2, 3, 4, 5, 6] as DayOfWeek[]).map((dayOfWeek) => ({ dayOfWeek, ...structuredClone(defaults[dayOfWeek]) }));
}

export function createDefaultDraft(now = new Date().toISOString()): BuilderDraftV2 {
  const services: BuilderService[] = [
    { clientId: "service-damenschnitt", slug: "damenschnitt", category: "Schnitt", name: "Damenschnitt", description: "Beratung, Waschen, Schneiden und Föhnen", durationMinutes: 60, price: 85, priceType: "from", bookable: true },
    { clientId: "service-herrenschnitt", slug: "herrenschnitt", category: "Schnitt", name: "Herrenschnitt", description: "Waschen, Schneiden und Styling", durationMinutes: 30, price: 55, priceType: "fixed", bookable: true },
    { clientId: "service-balayage", slug: "balayage", category: "Farbe", name: "Balayage", description: "Individuelle Freihandtechnik inklusive Glossing", durationMinutes: 180, price: 220, priceType: "from", bookable: true },
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    draftId: createClientId("draft"),
    createdAt: now,
    updatedAt: now,
    salon: { name: "Studio Miro", tagline: "Coiffeur in Zürich", phone: "+41 44 000 00 00", email: "hallo@studio-miro.ch", address: "Musterstrasse 8", postalCode: "8000", city: "Zürich", instagram: "" },
    copy: { heroLabel: "Schönes Haar beginnt mit guter Beratung", heroTitle: "Schnitt, Farbe und Pflege, die zu dir passen.", heroSubtitle: "Persönliche Beratung, ehrliches Handwerk und ein Termin, der sich einfach online buchen lässt.", servicesTitle: "Leistungen und Preise", servicesSubtitle: "Wähle die passende Behandlung. Dauer und Preis sind transparent angegeben.", bookingTitle: "Bereit für deinen nächsten Termin?", bookingSubtitle: "Die Online-Buchung wird beim Veröffentlichen automatisch eingerichtet." },
    services,
    staff: [],
    businessHours: createDefaultSchedule(),
    assets: [],
    testimonials: { enabled: false, items: [] },
    theme: { preset: "elegant", primary: PRESETS.elegant.primary, accent: PRESETS.elegant.accent },
    publication: { intentId: null, state: "LOCAL", lastErrorCode: null },
    migration: { sourceVersion: null, legacyHeroImageUrl: null, migratedAt: null },
  };
}
