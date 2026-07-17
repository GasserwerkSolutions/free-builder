"use strict";

const STORAGE_KEY = "gasserwerk-free-salon-builder-v1";
const MAX_TESTIMONIALS = 3;

const PRESETS = {
  elegant: { primary: "#6f4f43", accent: "#caa485", bg: "#fffaf7", surface: "#f5ece6", text: "#241f1c", display: "Georgia, 'Times New Roman', serif", body: "Inter, system-ui, sans-serif", radius: "20px" },
  modern:  { primary: "#151515", accent: "#d15f35", bg: "#ffffff", surface: "#f3f3f1", text: "#151515", display: "Inter, system-ui, sans-serif", body: "Inter, system-ui, sans-serif", radius: "10px" },
  natural: { primary: "#46614f", accent: "#bb8c5a", bg: "#fbfaf4", surface: "#edf1e9", text: "#243028", display: "Georgia, 'Times New Roman', serif", body: "Inter, system-ui, sans-serif", radius: "24px" },
  bold:    { primary: "#311b4d", accent: "#f0a32f", bg: "#fff8ec", surface: "#f2e5ff", text: "#25192f", display: "Arial Black, Inter, system-ui, sans-serif", body: "Inter, system-ui, sans-serif", radius: "4px" },
};

const DEFAULT_STATE = {
  version: 1,
  salon: {
    name: "Studio Miro",
    tagline: "Coiffeur in Zürich",
    phone: "+41 44 000 00 00",
    email: "hallo@studio-miro.ch",
    address: "Musterstrasse 8",
    postalCode: "8000",
    city: "Zürich",
    instagram: "",
    bookingUrl: "",
    heroImage: "",
  },
  copy: {
    heroLabel: "Schönes Haar beginnt mit guter Beratung",
    heroTitle: "Schnitt, Farbe und Pflege, die zu dir passen.",
    heroSubtitle: "Persönliche Beratung, ehrliches Handwerk und ein Termin, der sich einfach online buchen lässt.",
    servicesTitle: "Leistungen und Preise",
    servicesSubtitle: "Wähle die passende Behandlung. Dauer und Preis sind transparent angegeben.",
    bookingTitle: "Bereit für deinen nächsten Termin?",
    bookingSubtitle: "Buche online, wann es für dich passt.",
  },
  services: [
    { id: "damenschnitt", category: "Schnitt", name: "Damenschnitt", description: "Beratung, Waschen, Schneiden und Föhnen", durationMinutes: 60, price: 85, priceType: "from", bookable: true },
    { id: "herrenschnitt", category: "Schnitt", name: "Herrenschnitt", description: "Waschen, Schneiden und Styling", durationMinutes: 30, price: 55, priceType: "fixed", bookable: true },
    { id: "balayage", category: "Farbe", name: "Balayage", description: "Individuelle Freihandtechnik inklusive Glossing", durationMinutes: 180, price: 220, priceType: "from", bookable: true },
  ],
  hours: [
    { day: "Montag", open: "09:00", close: "18:00", closed: true },
    { day: "Dienstag", open: "09:00", close: "18:00", closed: false },
    { day: "Mittwoch", open: "09:00", close: "18:00", closed: false },
    { day: "Donnerstag", open: "09:00", close: "20:00", closed: false },
    { day: "Freitag", open: "09:00", close: "18:00", closed: false },
    { day: "Samstag", open: "08:00", close: "15:00", closed: false },
    { day: "Sonntag", open: "09:00", close: "18:00", closed: true },
  ],
  testimonials: {
    enabled: false,
    items: [],
  },
  theme: {
    preset: "elegant",
    primary: PRESETS.elegant.primary,
    accent: PRESETS.elegant.accent,
  },
};


function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaultState();
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    console.warn("Saved builder state could not be loaded.", error);
    return cloneDefaultState();
  }
}

function normalizeState(input) {
  const fallback = cloneDefaultState();
  const source = input && typeof input === "object" ? input : {};
  return {
    version: 1,
    salon: { ...fallback.salon, ...(source.salon || {}) },
    copy: { ...fallback.copy, ...(source.copy || {}) },
    services: Array.isArray(source.services) && source.services.length
      ? source.services.map((service, index) => normalizeService(service, index))
      : fallback.services,
    hours: Array.isArray(source.hours) && source.hours.length === 7
      ? source.hours.map((item, index) => ({ ...fallback.hours[index], ...item }))
      : fallback.hours,
    testimonials: {
      enabled: Boolean(source.testimonials?.enabled),
      items: Array.isArray(source.testimonials?.items)
        ? source.testimonials.items.slice(0, MAX_TESTIMONIALS).map((item, index) => ({ id: item.id || `voice-${index + 1}`, quote: String(item.quote || ""), name: String(item.name || ""), detail: String(item.detail || "") }))
        : [],
    },
    theme: { ...fallback.theme, ...(source.theme || {}) },
  };
}

function normalizeService(service, index) {
  return {
    id: service.id || slugify(service.name || `service-${index + 1}`),
    category: String(service.category || "Leistungen"),
    name: String(service.name || "Neue Leistung"),
    description: String(service.description || ""),
    durationMinutes: clampNumber(service.durationMinutes, 5, 600, 30),
    price: clampNumber(service.price, 0, 10000, 0),
    priceType: ["fixed", "from", "on-request"].includes(service.priceType) ? service.priceType : "fixed",
    bookable: service.bookable !== false,
  };
}


function getPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((current, key) => current[key], object);
  target[last] = value;
}

function groupBy(items, getKey) {
  return items.reduce((groups, item) => {
    const key = getKey(item);
    (groups[key] ||= []).push(item);
    return groups;
  }, {});
}

function uniqueServiceId(name, currentId = "") {
  const base = slugify(name || "service");
  const used = new Set(state?.services?.filter((service) => service.id !== currentId).map((service) => service.id) || []);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "salon";
}

function formatDuration(minutes) {
  const value = Number(minutes || 0);
  if (value < 60) return `${value} Min.`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} Std. ${rest} Min.` : `${hours} Std.`;
}

function formatPrice(service) {
  if (service.priceType === "on-request") return "Auf Anfrage";
  const amount = new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(service.price || 0));
  return service.priceType === "from" ? `ab ${amount}` : amount;
}

function withQuery(url, key, value) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    return url;
  }
}

function normalizeExternalUrl(url) {
  return isSafeHttpUrl(url) ? String(url).trim() : "";
}

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function safeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function escapeCssUrl(value) {
  return String(value || "").replace(/[\\'"\n\r()]/g, "");
}

function safeJson(value) {
  return JSON.stringify(value, (_key, item) => item === undefined ? undefined : item).replace(/</g, "\\u003c");
}

function englishDay(day) {
  return ({ Montag: "Monday", Dienstag: "Tuesday", Mittwoch: "Wednesday", Donnerstag: "Thursday", Freitag: "Friday", Samstag: "Saturday", Sonntag: "Sunday" })[day] || "Monday";
}

let state = loadState();
let saveTimer = null;
let previewTimer = null;
