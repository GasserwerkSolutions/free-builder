import type { BuilderDraftV2 } from "./domain-model.js";
import type { EditableFieldPath, ServiceEditableField, StaffEditableField, TestimonialEditableField } from "./draft-mutations.js";

// The contract between the editor and the preview document.
//
// The preview runs in a sandboxed srcdoc iframe, which means an opaque origin: it can never read the
// editor and the editor can never reach into it except through these messages. Everything crossing
// that line is described here — and every incoming message is re-validated against these shapes,
// because a message is untrusted input no matter who we believe sent it.

export const PREVIEW_CHANNEL = "gasserwerk-salon-preview" as const;
export const PREVIEW_PROTOCOL_VERSION = 1 as const;

export type EditorPanel = "salon" | "copy" | "services" | "team" | "hours" | "voices" | "design" | "publish";
export type ServicePreviewField = Extract<ServiceEditableField, "category" | "name" | "description">;
export type StaffPreviewField = Extract<StaffEditableField, "name" | "role" | "bio">;

/**
 * What a spot in the preview stands for. Purely runtime metadata: a target is derived from the draft,
 * never stored in it. Nothing here is persisted and no draft field carries a target.
 */
export type PreviewTarget =
  | { kind: "field"; field: EditableFieldPath }
  | { kind: "service"; serviceClientId: string; field: ServicePreviewField }
  | { kind: "testimonial"; testimonialClientId: string; field: TestimonialEditableField }
  | { kind: "staff"; staffClientId: string; field: StaffPreviewField }
  | { kind: "panel"; panel: EditorPanel };

/** The replaceable blocks of the rendered page. Each one exists exactly once when it is on the page. */
export type PreviewRegion = "header" | "hero" | "intro" | "services" | "team" | "voices" | "details" | "booking" | "footer";

export type PreviewScrollState = { section: string; offsetWithinSection: number; fallbackScrollY: number };

export type PreviewMessageEnvelope = {
  channel: typeof PREVIEW_CHANNEL;
  version: typeof PREVIEW_PROTOCOL_VERSION;
  instanceId: string;
  renderGeneration: number;
  revision: number;
};

export type PreviewRequestEnvelope = PreviewMessageEnvelope & { requestId: string; baseRevision: number };

export type PreviewOperation =
  | { type: "patch-text"; target: PreviewTarget; occurrence?: string; value: string }
  | { type: "replace-region"; region: PreviewRegion; html: string }
  | { type: "patch-theme"; primary: string; accent: string };

export type PreviewUpdateRequest = PreviewRequestEnvelope & { action: "apply-update"; operations: readonly PreviewOperation[] };

export type PreviewUpdateFailureReason =
  | "stale-revision"
  | "revision-gap"
  | "unknown-target"
  | "ambiguous-target"
  | "invalid-region"
  | "conflicting-operations"
  | "invalid-operation"
  | "internal-error";

export type PreviewUpdateResult = PreviewMessageEnvelope & { action: "update-result"; requestId: string; success: boolean; reason?: PreviewUpdateFailureReason };
export type PreviewReadyMessage = PreviewMessageEnvelope & { action: "ready" };
export type PreviewNavigateMessage = PreviewMessageEnvelope & { action: "navigate-to-editor"; target: PreviewTarget };
export type PreviewScrollMessage = PreviewMessageEnvelope & { action: "preview-scroll"; position: PreviewScrollState };

export type PreviewBridgeConfig = PreviewMessageEnvelope & { parentOrigin: string; restore: PreviewScrollState | null };

export const EDITOR_PANELS: readonly EditorPanel[] = ["salon", "copy", "services", "team", "hours", "voices", "design", "publish"];

/**
 * Every scalar field the editor binds to a single input. Kept as a literal list rather than derived,
 * so adding a draft field is a deliberate decision here too — and `satisfies` refuses a typo.
 */
export const EDITABLE_FIELDS = [
  "salon.name", "salon.tagline", "salon.phone", "salon.email", "salon.address", "salon.postalCode", "salon.city", "salon.instagram",
  "copy.heroLabel", "copy.heroTitle", "copy.heroSubtitle", "copy.servicesTitle", "copy.servicesSubtitle", "copy.bookingTitle", "copy.bookingSubtitle",
  "theme.primary", "theme.accent", "testimonials.enabled",
] as const satisfies readonly EditableFieldPath[];

export const PREVIEW_REGIONS: readonly PreviewRegion[] = ["header", "hero", "intro", "services", "team", "voices", "details", "booking", "footer"];

const PANELS = new Set<string>(EDITOR_PANELS);
const FIELDS = new Set<string>(EDITABLE_FIELDS);
const SERVICE_FIELDS = new Set<string>(["category", "name", "description"]);
const STAFF_FIELDS = new Set<string>(["name", "role", "bio"]);
const TESTIMONIAL_FIELDS = new Set<string>(["quote", "name", "detail"]);
const REGIONS = new Set<string>(PREVIEW_REGIONS);
const FAILURE_REASONS = new Set<string>(["stale-revision", "revision-gap", "unknown-target", "ambiguous-target", "invalid-region", "conflicting-operations", "invalid-operation", "internal-error"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function counter(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }

/** Shape check only: is this a target the editor could ever mean? */
export function isPreviewTargetShape(value: unknown): value is PreviewTarget {
  const target = record(value);
  if (!target || typeof target.kind !== "string") return false;
  if (target.kind === "field") return typeof target.field === "string" && FIELDS.has(target.field);
  if (target.kind === "panel") return typeof target.panel === "string" && PANELS.has(target.panel);
  if (target.kind === "service") return typeof target.serviceClientId === "string" && typeof target.field === "string" && SERVICE_FIELDS.has(target.field);
  if (target.kind === "testimonial") return typeof target.testimonialClientId === "string" && typeof target.field === "string" && TESTIMONIAL_FIELDS.has(target.field);
  if (target.kind === "staff") return typeof target.staffClientId === "string" && typeof target.field === "string" && STAFF_FIELDS.has(target.field);
  return false;
}

/** Shape check plus: does the thing it points at still exist in the draft? */
export function isPreviewTarget(value: unknown, draft: Readonly<BuilderDraftV2>): value is PreviewTarget {
  if (!isPreviewTargetShape(value)) return false;
  if (value.kind === "service") return draft.services.some((service) => service.clientId === value.serviceClientId);
  if (value.kind === "testimonial") return draft.testimonials.items.some((item) => item.clientId === value.testimonialClientId);
  if (value.kind === "staff") return draft.staff.some((person) => person.clientId === value.staffClientId);
  return true;
}

export function isPreviewRegion(value: unknown): value is PreviewRegion { return typeof value === "string" && REGIONS.has(value); }

export function isPreviewMessageEnvelope(value: unknown, instanceId?: string, renderGeneration?: number): value is PreviewMessageEnvelope {
  const message = record(value);
  if (!message || message.channel !== PREVIEW_CHANNEL || message.version !== PREVIEW_PROTOCOL_VERSION) return false;
  if (typeof message.instanceId !== "string" || !counter(message.renderGeneration) || !counter(message.revision)) return false;
  // The instance id is minted per full render and known only to this editor and that one document.
  // Matching it is what makes a message a message from *our* preview, not merely a well-formed one.
  if (instanceId !== undefined && message.instanceId !== instanceId) return false;
  if (renderGeneration !== undefined && message.renderGeneration !== renderGeneration) return false;
  return true;
}

export function parseReadyMessage(value: unknown, instanceId: string, renderGeneration: number): PreviewReadyMessage | null {
  if (!isPreviewMessageEnvelope(value, instanceId, renderGeneration)) return null;
  return (value as PreviewMessageEnvelope & { action?: unknown }).action === "ready" ? value as PreviewReadyMessage : null;
}

export function parseUpdateResult(value: unknown, instanceId: string, renderGeneration: number): PreviewUpdateResult | null {
  if (!isPreviewMessageEnvelope(value, instanceId, renderGeneration)) return null;
  const message = value as unknown as Record<string, unknown>;
  if (message.action !== "update-result" || typeof message.requestId !== "string" || typeof message.success !== "boolean") return null;
  if (message.reason !== undefined && !FAILURE_REASONS.has(String(message.reason))) return null;
  return value as PreviewUpdateResult;
}

export function parseNavigateMessage(value: unknown, instanceId: string, renderGeneration?: number): PreviewNavigateMessage | null {
  if (!isPreviewMessageEnvelope(value, instanceId, renderGeneration)) return null;
  const message = value as unknown as Record<string, unknown>;
  if (message.action !== "navigate-to-editor" || !isPreviewTargetShape(message.target)) return null;
  return value as PreviewNavigateMessage;
}

export function parseScrollMessage(value: unknown, instanceId: string, renderGeneration?: number): PreviewScrollMessage | null {
  if (!isPreviewMessageEnvelope(value, instanceId, renderGeneration)) return null;
  const message = value as unknown as Record<string, unknown>;
  const position = record(message.position);
  if (message.action !== "preview-scroll" || !position) return null;
  if (typeof position.section !== "string" || !Number.isFinite(position.offsetWithinSection) || !Number.isFinite(position.fallbackScrollY)) return null;
  return value as PreviewScrollMessage;
}

const FIELD_PANELS: Record<string, EditorPanel> = { salon: "salon", copy: "copy", theme: "design", testimonials: "voices" };

export function panelForTarget(target: PreviewTarget): EditorPanel {
  if (target.kind === "field") return FIELD_PANELS[target.field.split(".")[0] ?? ""] ?? "salon";
  if (target.kind === "service") return "services";
  if (target.kind === "testimonial") return "voices";
  if (target.kind === "staff") return "team";
  return target.panel;
}

/**
 * The one place that decides which origin the two windows are allowed to name each other by.
 *
 * The preview is a sandboxed srcdoc document, so its origin is opaque ("null") and the browser gives
 * the editor no way to address it more narrowly than "*". The editor side is addressable, though, so
 * the child always names it exactly — the wildcard is only used when the editor itself has no real
 * origin (a file:// page), which is not how this ships.
 */
export function resolveParentOrigin(origin: string | undefined): string {
  if (!origin || origin === "null") return "*";
  return /^https?:\/\//.test(origin) ? origin : "*";
}
