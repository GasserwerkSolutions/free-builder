import type { BuilderDraftV2, BuilderService } from "./domain-model.js";

export function slugify(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "salon";
}

export function uniqueSlug(name: string, services: BuilderService[], currentClientId = ""): string {
  const base = slugify(name || "service");
  const used = new Set(services.filter((service) => service.clientId !== currentClientId).map((service) => service.slug));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function normalizeHttpUrl(value: unknown): string | null {
  try {
    const url = new URL(typeof value === "string" ? value.trim() : "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// Pure judgements about user input: they never rewrite the draft, they only answer whether a value
// could be used as an address, a phone number or an Instagram profile. The draft keeps what the user
// typed; the mutation layer uses these to report a filled-in but unusable field as "invalid".
export function normalizeEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function normalizePhone(value: unknown): string | null {
  const phone = typeof value === "string" ? value.trim() : "";
  if (!phone) return null;
  const normalized = phone.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return /^\+?\d{6,15}$/.test(normalized) ? normalized : null;
}

export function normalizeInstagramUrl(value: unknown): string | null {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return null;
  const host = new URL(normalized).hostname.toLowerCase();
  return host === "instagram.com" || host.endsWith(".instagram.com") ? normalized : null;
}

export function formatDuration(minutes: number): string {
  const value = Number(minutes || 0);
  if (value < 60) return `${value} Min.`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} Std. ${rest} Min.` : `${hours} Std.`;
}

export function formatPrice(service: Pick<BuilderService, "price" | "priceType">): string {
  if (service.priceType === "on-request") return "Auf Anfrage";
  const amount = new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(service.price || 0));
  return service.priceType === "from" ? `ab ${amount}` : amount;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
export function escapeAttr(value: unknown): string { return escapeHtml(value).replace(/`/g, "&#096;"); }
export function safeJson(value: unknown): string { return JSON.stringify(value, (_key, item) => item === undefined ? undefined : item).replace(/</g, "\\u003c"); }
export function isSafeHttpUrl(value: unknown): boolean { return normalizeHttpUrl(value) !== null; }
export function cloneDraft(draft: Readonly<BuilderDraftV2>): BuilderDraftV2 { return structuredClone(draft) as BuilderDraftV2; }

// Dot-path access into the draft. Shared by the input bindings and by the mutation verifier, so both
// address a draft field the exact same way.
export function getAtPath(object: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
  object);
}

export function setAtPath(object: object, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop();
  if (!last) return;
  let target = object as Record<string, unknown>;
  for (const key of keys) {
    const next = target[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error(`INVALID_BIND_PATH:${path}`);
    target = next as Record<string, unknown>;
  }
  if (!(last in target)) throw new Error(`UNKNOWN_BIND_PATH:${path}`);
  target[last] = value;
}
