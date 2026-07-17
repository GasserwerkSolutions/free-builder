export function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
export function asString(value, fallback = "") { return typeof value === "string" ? value : fallback; }
export function asBoolean(value, fallback = false) { return typeof value === "boolean" ? value : fallback; }
export function asNumber(value, fallback, min, max) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
export function safeIso(value, fallback) { const date = new Date(asString(value)); return Number.isNaN(date.valueOf()) ? fallback : date.toISOString(); }
export function safeColor(value, fallback) { const text = asString(value); return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback; }
export function safeFocalPoint(value) {
    const point = asRecord(value);
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y))
        return null;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
