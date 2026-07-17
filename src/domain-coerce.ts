export function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function asString(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
export function asBoolean(value: unknown, fallback = false): boolean { return typeof value === "boolean" ? value : fallback; }
export function asNumber(value: unknown, fallback: number, min: number, max: number): number { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
export function safeIso(value: unknown, fallback: string): string { const date = new Date(asString(value)); return Number.isNaN(date.valueOf()) ? fallback : date.toISOString(); }
export function safeColor(value: unknown, fallback: string): string { const text = asString(value); return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback; }
export function safeFocalPoint(value: unknown): { x: number; y: number } | null {
  const point = asRecord(value);
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
