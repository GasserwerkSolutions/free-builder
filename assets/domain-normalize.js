import { MAX_TESTIMONIALS, PRESETS, SCHEMA_VERSION, createDefaultDraft, createDefaultSchedule, dayName, } from "./domain-model.js";
import { normalizeHttpUrl, slugify } from "./domain-helpers.js";
import { asBoolean, asNumber, asRecord, asString, safeColor, safeFocalPoint, safeIso } from "./domain-coerce.js";
export function normalizeSchedule(value, fallback = createDefaultSchedule()) {
    if (!Array.isArray(value))
        return structuredClone(fallback);
    const byDay = new Map();
    value.forEach((item) => { const row = asRecord(item); const day = Number(row.dayOfWeek); if (Number.isInteger(day) && day >= 0 && day <= 6)
        byDay.set(day, row); });
    return [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => {
        const row = byDay.get(dayOfWeek);
        if (!row)
            return structuredClone(fallback.find((item) => item.dayOfWeek === dayOfWeek) ?? { dayOfWeek, closed: true, ranges: [] });
        const ranges = Array.isArray(row.ranges) ? row.ranges.slice(0, 4).map((range) => asRecord(range)).map((range) => ({ from: normalizeTime(range.from, "09:00"), to: normalizeTime(range.to, "18:00") })) : [];
        const closed = asBoolean(row.closed, ranges.length === 0);
        return { dayOfWeek, closed, ranges: closed ? [] : ranges.length ? ranges : [{ from: "09:00", to: "18:00" }] };
    });
}
export function normalizeTime(value, fallback) { const text = asString(value); return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback; }
export function validateWeeklySchedule(schedule) {
    const errors = [];
    for (const day of schedule) {
        if (day.closed)
            continue;
        if (!day.ranges.length)
            errors.push(`${dayName(day.dayOfWeek)} hat keine Zeitspanne.`);
        const sorted = [...day.ranges].sort((a, b) => a.from.localeCompare(b.from));
        sorted.forEach((range, index) => {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(range.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(range.to))
                errors.push(`${dayName(day.dayOfWeek)} enthält eine ungültige Uhrzeit.`);
            else if (range.from >= range.to)
                errors.push(`${dayName(day.dayOfWeek)}: Beginn muss vor Ende liegen.`);
            const previous = index > 0 ? sorted[index - 1] : undefined;
            if (previous && previous.to > range.from)
                errors.push(`${dayName(day.dayOfWeek)} enthält überlappende Zeitspannen.`);
        });
    }
    return [...new Set(errors)];
}
export function normalizeDraftV2(input) {
    const source = asRecord(input);
    if (source.schemaVersion !== SCHEMA_VERSION)
        throw new Error(`UNSUPPORTED_DRAFT_SCHEMA:${String(source.schemaVersion)}`);
    const fallback = createDefaultDraft();
    const salon = asRecord(source.salon);
    const copy = asRecord(source.copy);
    const theme = asRecord(source.theme);
    const testimonials = asRecord(source.testimonials);
    const publication = asRecord(source.publication);
    const migration = asRecord(source.migration);
    const preset = ["elegant", "modern", "natural", "bold"].includes(theme.preset) ? theme.preset : fallback.theme.preset;
    const rawServices = Array.isArray(source.services) ? source.services : [];
    const services = [];
    const usedClientIds = new Set();
    const usedSlugs = new Set();
    rawServices.forEach((value, index) => {
        const row = asRecord(value);
        let clientId = asString(row.clientId, `service-${index + 1}`) || `service-${index + 1}`;
        while (usedClientIds.has(clientId))
            clientId = `${clientId}-${index + 1}`;
        usedClientIds.add(clientId);
        let slug = slugify(asString(row.slug, asString(row.name, `service-${index + 1}`)));
        let suffix = 2;
        const baseSlug = slug;
        while (usedSlugs.has(slug))
            slug = `${baseSlug}-${suffix++}`;
        usedSlugs.add(slug);
        services.push({ clientId, slug, category: asString(row.category, "Leistungen"), name: asString(row.name, "Neue Leistung"), description: asString(row.description), durationMinutes: asNumber(row.durationMinutes, 30, 5, 600), price: asNumber(row.price, 0, 0, 10000), priceType: ["fixed", "from", "on-request"].includes(row.priceType) ? row.priceType : "fixed", bookable: asBoolean(row.bookable, true) });
    });
    const serviceIds = new Set(services.map((service) => service.clientId));
    const staff = Array.isArray(source.staff) ? source.staff.map((value, index) => {
        const row = asRecord(value);
        return { clientId: asString(row.clientId, `staff-${index + 1}`), name: asString(row.name, "Neue Person"), email: asString(row.email), role: asString(row.role, "Coiffeur/in"), bio: asString(row.bio), specialties: Array.isArray(row.specialties) ? row.specialties.map((item) => asString(item)).filter(Boolean).slice(0, 20) : [], active: asBoolean(row.active, true), serviceClientIds: Array.isArray(row.serviceClientIds) ? [...new Set(row.serviceClientIds.map((item) => asString(item)).filter((id) => serviceIds.has(id)))] : [], workingHours: normalizeSchedule(row.workingHours), portraitAssetLocalId: asString(row.portraitAssetLocalId) || null };
    }) : [];
    const assets = Array.isArray(source.assets) ? source.assets.map((value) => { const row = asRecord(value); const kind = row.kind; if (!["HERO", "PORTRAIT", "GALLERY", "LOGO"].includes(kind))
        return null; return { localId: asString(row.localId), kind, ownerClientId: asString(row.ownerClientId) || null, fileName: asString(row.fileName), mimeType: asString(row.mimeType), bytes: asNumber(row.bytes, 0, 0, Number.MAX_SAFE_INTEGER), width: row.width == null ? null : asNumber(row.width, 0, 0, 100000), height: row.height == null ? null : asNumber(row.height, 0, 0, 100000), alt: asString(row.alt), focalPoint: safeFocalPoint(row.focalPoint), uploadedAssetId: asString(row.uploadedAssetId) || null }; }).filter((item) => Boolean(item?.localId)) : [];
    const now = new Date().toISOString();
    return {
        schemaVersion: SCHEMA_VERSION,
        draftId: asString(source.draftId, fallback.draftId), createdAt: safeIso(source.createdAt, now), updatedAt: safeIso(source.updatedAt, now),
        salon: { name: asString(salon.name, fallback.salon.name), tagline: asString(salon.tagline, fallback.salon.tagline), phone: asString(salon.phone, fallback.salon.phone), email: asString(salon.email, fallback.salon.email), address: asString(salon.address, fallback.salon.address), postalCode: asString(salon.postalCode, fallback.salon.postalCode), city: asString(salon.city, fallback.salon.city), instagram: normalizeHttpUrl(salon.instagram) ?? "" },
        copy: { heroLabel: asString(copy.heroLabel, fallback.copy.heroLabel), heroTitle: asString(copy.heroTitle, fallback.copy.heroTitle), heroSubtitle: asString(copy.heroSubtitle, fallback.copy.heroSubtitle), servicesTitle: asString(copy.servicesTitle, fallback.copy.servicesTitle), servicesSubtitle: asString(copy.servicesSubtitle, fallback.copy.servicesSubtitle), bookingTitle: asString(copy.bookingTitle, fallback.copy.bookingTitle), bookingSubtitle: asString(copy.bookingSubtitle, fallback.copy.bookingSubtitle) },
        services, staff, businessHours: normalizeSchedule(source.businessHours), assets,
        testimonials: { enabled: asBoolean(testimonials.enabled), items: Array.isArray(testimonials.items) ? testimonials.items.slice(0, MAX_TESTIMONIALS).map((value, index) => { const row = asRecord(value); return { clientId: asString(row.clientId, asString(row.id, `voice-${index + 1}`)), quote: asString(row.quote), name: asString(row.name), detail: asString(row.detail) }; }) : [] },
        theme: { preset, primary: safeColor(theme.primary, PRESETS[preset].primary), accent: safeColor(theme.accent, PRESETS[preset].accent) },
        publication: { intentId: asString(publication.intentId) || null, state: ["LOCAL", "EMAIL_SENT", "VERIFIED", "ACTIVATING", "PUBLISHED", "FAILED"].includes(publication.state) ? publication.state : "LOCAL", lastErrorCode: asString(publication.lastErrorCode) || null },
        migration: { sourceVersion: migration.sourceVersion === 1 ? 1 : null, legacyHeroImageUrl: normalizeHttpUrl(migration.legacyHeroImageUrl), migratedAt: migration.migratedAt ? safeIso(migration.migratedAt, now) : null },
    };
}
