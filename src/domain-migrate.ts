import {
  MAX_TESTIMONIALS, PRESETS, createClientId, createDefaultDraft,
  type BuilderDraftV2, type BuilderService, type DayOfWeek, type LegacyDraftV1,
  type PriceType, type ScheduleDay, type ThemePresetName,
} from "./domain-model.js";
import { normalizeHttpUrl, slugify } from "./domain-helpers.js";
import { asBoolean, asNumber, asRecord, asString, safeColor } from "./domain-coerce.js";
import { normalizeDraftV2, normalizeTime } from "./domain-normalize.js";

export function migrateV1ToV2(input: LegacyDraftV1, now = new Date().toISOString()): BuilderDraftV2 {
  if (input.version != null && input.version !== 1) throw new Error(`UNSUPPORTED_LEGACY_SCHEMA:${String(input.version)}`);
  const fallback = createDefaultDraft(now);
  const salon = asRecord(input.salon);
  const copy = asRecord(input.copy);
  const theme = asRecord(input.theme);
  const testimonials = asRecord(input.testimonials);
  const rawServices = Array.isArray(input.services) ? input.services : [];
  const services: BuilderService[] = [];
  const usedClientIds = new Set<string>();
  const usedSlugs = new Set<string>();
  rawServices.forEach((value, index) => {
    const row = asRecord(value);
    let clientId = asString(row.id, `service-${index + 1}`) || `service-${index + 1}`;
    while (usedClientIds.has(clientId)) clientId = `${clientId}-${index + 1}`;
    usedClientIds.add(clientId);
    let slug = slugify(asString(row.id, asString(row.name, `service-${index + 1}`))); let suffix = 2; const base = slug; while (usedSlugs.has(slug)) slug = `${base}-${suffix++}`; usedSlugs.add(slug);
    services.push({ clientId, slug, category: asString(row.category, "Leistungen"), name: asString(row.name, "Neue Leistung"), description: asString(row.description), durationMinutes: asNumber(row.durationMinutes, 30, 5, 600), price: asNumber(row.price, 0, 0, 10000), priceType: (["fixed", "from", "on-request"] as const).includes(row.priceType as PriceType) ? row.priceType as PriceType : "fixed", bookable: asBoolean(row.bookable, true) });
  });
  const rawHours = Array.isArray(input.hours) ? input.hours : [];
  const dayByName: Record<string, DayOfWeek> = { Sonntag: 0, Montag: 1, Dienstag: 2, Mittwoch: 3, Donnerstag: 4, Freitag: 5, Samstag: 6 };
  const migratedHours = ([0, 1, 2, 3, 4, 5, 6] as DayOfWeek[]).map((dayOfWeek): ScheduleDay => {
    const value = rawHours.find((item) => dayByName[asString(asRecord(item).day)] === dayOfWeek);
    if (!value) return structuredClone(fallback.businessHours.find((item) => item.dayOfWeek === dayOfWeek)!);
    const row = asRecord(value); const closed = asBoolean(row.closed);
    return { dayOfWeek, closed, ranges: closed ? [] : [{ from: normalizeTime(row.open, "09:00"), to: normalizeTime(row.close, "18:00") }] };
  });
  const preset = (["elegant", "modern", "natural", "bold"] as const).includes(theme.preset as ThemePresetName) ? theme.preset as ThemePresetName : fallback.theme.preset;
  return normalizeDraftV2({ ...fallback, draftId: createClientId("draft"), createdAt: now, updatedAt: now,
    salon: { name: asString(salon.name, fallback.salon.name), tagline: asString(salon.tagline, fallback.salon.tagline), phone: asString(salon.phone, fallback.salon.phone), email: asString(salon.email, fallback.salon.email), address: asString(salon.address, fallback.salon.address), postalCode: asString(salon.postalCode, fallback.salon.postalCode), city: asString(salon.city, fallback.salon.city), instagram: asString(salon.instagram) },
    copy: { ...fallback.copy, ...Object.fromEntries(Object.keys(fallback.copy).map((key) => [key, asString(copy[key], fallback.copy[key as keyof typeof fallback.copy])])) },
    services: services.length ? services : fallback.services, businessHours: migratedHours, staff: [], assets: [],
    testimonials: { enabled: asBoolean(testimonials.enabled), items: Array.isArray(testimonials.items) ? testimonials.items.slice(0, MAX_TESTIMONIALS).map((value, index) => { const row = asRecord(value); return { clientId: asString(row.id, `voice-${index + 1}`), quote: asString(row.quote), name: asString(row.name), detail: asString(row.detail) }; }) : [] },
    theme: { preset, primary: safeColor(theme.primary, PRESETS[preset].primary), accent: safeColor(theme.accent, PRESETS[preset].accent) },
    publication: { intentId: null, state: "LOCAL", lastErrorCode: null },
    migration: { sourceVersion: 1, legacyHeroImageUrl: normalizeHttpUrl(salon.heroImage), migratedAt: now },
  });
}
