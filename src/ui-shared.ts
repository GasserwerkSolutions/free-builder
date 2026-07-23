import { MAX_RANGES_PER_DAY, dayName, escapeAttr, escapeHtml, type BuilderDraftV2, type ScheduleDay, type WeeklySchedule } from "./domain.js";
import type { DraftMutation, DraftMutationDescriptor, HistoryDescriptor } from "./draft-mutations.js";
import type { DraftRepository } from "./persistence.js";
import type { PreviewTarget } from "./preview-contract.js";
import type { PreviewRuntime } from "./preview-runtime.js";
import type { BuilderStore } from "./store.js";

export type MobileMode = "edit" | "preview";

export type UiContext = {
  store: BuilderStore;
  repository: DraftRepository;
  workspace: HTMLElement;
  controlSurface: HTMLElement;
  surfaceStage: HTMLElement;
  surfaceCard: HTMLElement;
  sidebarToggle: HTMLButtonElement;
  undoButton: HTMLButtonElement;
  redoButton: HTMLButtonElement;
  previewFrame: HTMLIFrameElement;
  previewHint: HTMLElement;
  saveStatus: HTMLElement;
  serviceList: HTMLElement;
  testimonialList: HTMLElement;
  hoursList: HTMLElement;
  readinessSummary: HTMLElement;
  readinessList: HTMLElement;
  serviceTemplate: HTMLTemplateElement;
  testimonialTemplate: HTMLTemplateElement;
  /** Owns the preview document. Null only before init() has built it. */
  preview: PreviewRuntime | null;
  volatileStorage: boolean;
  /** Which of the two mobile modes is showing. Meaningless above the mobile breakpoint. */
  mobileMode: MobileMode;
  /** Where the editing surface was scrolled when the preview took over. */
  mobileEditorScroll: number;
};

function requiredElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`MISSING_ELEMENT:${id}`);
  return element as unknown as T;
}

export function createUiContext(store: BuilderStore, repository: DraftRepository): UiContext {
  return {
    store,
    repository,
    workspace: requiredElement("builder-main"),
    controlSurface: requiredElement("controlSurface"),
    surfaceStage: requiredElement("surfaceStage"),
    surfaceCard: requiredElement("surfaceCard"),
    sidebarToggle: requiredElement("sidebarToggle"),
    undoButton: requiredElement("undoButton"),
    redoButton: requiredElement("redoButton"),
    previewFrame: requiredElement("previewFrame"),
    previewHint: requiredElement("previewHint"),
    saveStatus: requiredElement("saveStatus"),
    serviceList: requiredElement("serviceList"),
    testimonialList: requiredElement("testimonialList"),
    hoursList: requiredElement("hoursList"),
    readinessSummary: requiredElement("readinessSummary"),
    readinessList: requiredElement("readinessList"),
    serviceTemplate: requiredElement("serviceTemplate"),
    testimonialTemplate: requiredElement("testimonialTemplate"),
    preview: null,
    volatileStorage: false,
    mobileMode: "edit",
    mobileEditorScroll: 0,
  };
}

// Remembered UI preferences (sidebar, first-run hint). localStorage can be unavailable or full, and
// a lost preference is never a reason to break the editor — so both directions swallow the failure.
export function readPreference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writePreference(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* a preference is not worth an error */ }
}

/**
 * Whose undo stack the caret in a text control belongs to.
 *
 * A jump — an undone step, an entry in the publish list, a tap in the preview — puts the focus into a
 * field the user has not typed a single character into. That control's browser text history is
 * therefore empty, and handing the next Ctrl/Cmd + Z to the browser would make it do nothing at all.
 * Until a real edit lands in that very element, the history stays where the focus came from: the
 * store. One element, remembered by identity — nothing is inferred about any other field.
 */
let navigatedField: HTMLElement | null = null;

/** Remember the field the editor itself just focused. Null forgets the last one. */
export function markNavigatedField(element: HTMLElement | null): void {
  navigatedField = element;
}

/** True while this element still holds a caret the editor placed and the user has not used yet. */
export function isNavigatedField(element: Element | null): boolean {
  if (navigatedField && !navigatedField.isConnected) navigatedField = null;
  return element !== null && navigatedField === element;
}

/** The first real edit in the field gives the browser its own text history back. */
export function releaseNavigatedField(element: EventTarget | null): void {
  if (element === navigatedField) navigatedField = null;
}

/**
 * Make a heading focusable for exactly one visit. A jump has to be able to land on it, but a
 * tabindex left behind would add a permanent stop to the tab order that nothing on the surface asked
 * for — so the attribute is given back as soon as the focus leaves again.
 */
export function makeTransientlyFocusable(element: HTMLElement): void {
  if (element.hasAttribute("tabindex")) return;
  element.tabIndex = -1;
  element.addEventListener("blur", () => element.removeAttribute("tabindex"), { once: true });
}

/** Escape a client id for use inside a CSS attribute selector, with a fallback for old engines. */
export function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/**
 * The polite channel for things the user should hear but not be interrupted by — the result of a
 * click in the preview and of a reorder. Created on demand so the static page owns no dead markup.
 */
export function announce(context: UiContext, message: string): void {
  void context;
  let region = document.getElementById("previewAnnouncer");
  if (!region) {
    region = document.createElement("div");
    region.id = "previewAnnouncer";
    region.className = "visually-hidden";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  region.textContent = message;
}

/**
 * Build a history descriptor. `key` and `target` are genuinely optional (exactOptionalPropertyTypes
 * refuses an explicit undefined), so they are spread in only when there is something to say.
 */
export function historyDescriptor(label: string, options: { key?: string; target?: PreviewTarget } = {}): HistoryDescriptor {
  return { label, ...(options.key ? { key: options.key } : {}), ...(options.target ? { target: options.target } : {}) };
}

export function inputValue(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | boolean {
  return input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
}

/** The one error channel of the editor: a short, plain message on the surface. */
export function showToast(message: string): void {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

/**
 * The single entry point every editor mutation goes through.
 *
 * A rejected mutation means the declared intent and the real change disagree — a bug in the editor,
 * not a user error. Letting it escape into a DOM event handler would skip the render that follows the
 * call and leave the surface showing something the draft never accepted. So the rejection is reported
 * through the existing toast channel and logged with its code, the draft keeps its last verified
 * state, and the caller carries on and re-renders from that state.
 */
export function safeMutate(store: BuilderStore, mutator: (draft: BuilderDraftV2) => void, descriptor: DraftMutationDescriptor): DraftMutation | null {
  try {
    return store.mutate(mutator, descriptor);
  } catch (error) {
    console.error("Draft mutation rejected.", descriptor.intent, error);
    showToast("Diese Änderung wurde nicht übernommen. Der Entwurf bleibt auf dem zuletzt geprüften Stand.");
    return null;
  }
}

// The two distinct data-attribute namespaces so the salon and staff editors never share a delegator.
export type HourNamespace = { field: string; action: string };
export const BUSINESS_HOURS_NS: HourNamespace = { field: "data-hour-field", action: "data-hour-action" };
export const STAFF_HOURS_NS: HourNamespace = { field: "data-staff-hour-field", action: "data-staff-hour-action" };

// Render one day of the schedule editor. Reused for salon opening hours and per-person working hours;
// the caller picks the namespace so a document-wide delegator can tell the two editors apart.
export function renderScheduleDayEditor(day: ScheduleDay, ns: HourNamespace): string {
  const name = dayName(day.dayOfWeek);
  const rangesHtml = day.ranges
    .map((range, index) => `<div class="hours-range" data-range-index="${index}">`
      + `<input type="time" class="hours-range__input" value="${escapeAttr(range.from)}" ${ns.field}="from" aria-label="${escapeAttr(name)} Spanne ${index + 1} öffnet">`
      + `<span class="hours-range__sep" aria-hidden="true">–</span>`
      + `<input type="time" class="hours-range__input" value="${escapeAttr(range.to)}" ${ns.field}="to" aria-label="${escapeAttr(name)} Spanne ${index + 1} schliesst">`
      + `<button type="button" class="icon-button icon-button--sm" ${ns.action}="remove-range" data-range-index="${index}" aria-label="${escapeAttr(name)} Spanne ${index + 1} entfernen">×</button>`
      + `</div>`)
    .join("");
  const addButton = day.ranges.length < MAX_RANGES_PER_DAY
    ? `<button type="button" class="text-button hours-range__add" ${ns.action}="add-range">+ Intervall / Pause</button>`
    : "";
  const body = day.closed
    ? `<p class="hours-day__note">Geschlossen</p>`
    : `<div class="hours-day__ranges">${rangesHtml}${addButton}</div>`;
  // The copy-day action is meaningless (and destructive) on a closed source day, so it is hidden there.
  const copyButton = day.closed
    ? ""
    : `<button type="button" class="text-button" ${ns.action}="copy-day">Auf andere Tage übernehmen</button>`;
  return `<div class="hours-day${day.closed ? " is-closed" : ""}" data-day-of-week="${day.dayOfWeek}">`
    + `<div class="hours-day__head">`
    + `<strong>${escapeHtml(name)}</strong>`
    + `<label class="hours-day__closed"><input type="checkbox" ${ns.field}="closed" ${day.closed ? "checked" : ""}> Geschlossen</label>`
    + copyButton
    + `</div>`
    + body
    + `</div>`;
}

export function renderScheduleEditor(schedule: WeeklySchedule, ns: HourNamespace): string {
  return schedule.map((day) => renderScheduleDayEditor(day, ns)).join("");
}
