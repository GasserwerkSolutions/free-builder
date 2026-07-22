import { MAX_RANGES_PER_DAY, dayName, escapeAttr, escapeHtml, type ScheduleDay, type WeeklySchedule } from "./domain.js";
import type { DraftRepository } from "./persistence.js";
import type { BuilderStore } from "./store.js";

export type UiContext = {
  store: BuilderStore;
  repository: DraftRepository;
  surfaceCard: HTMLElement;
  previewFrame: HTMLIFrameElement;
  previewHint: HTMLElement;
  saveStatus: HTMLElement;
  serviceList: HTMLElement;
  testimonialList: HTMLElement;
  hoursList: HTMLElement;
  readinessList: HTMLElement;
  serviceTemplate: HTMLTemplateElement;
  testimonialTemplate: HTMLTemplateElement;
  previewTimer: ReturnType<typeof setTimeout> | null;
  volatileStorage: boolean;
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
    surfaceCard: requiredElement("surfaceCard"),
    previewFrame: requiredElement("previewFrame"),
    previewHint: requiredElement("previewHint"),
    saveStatus: requiredElement("saveStatus"),
    serviceList: requiredElement("serviceList"),
    testimonialList: requiredElement("testimonialList"),
    hoursList: requiredElement("hoursList"),
    readinessList: requiredElement("readinessList"),
    serviceTemplate: requiredElement("serviceTemplate"),
    testimonialTemplate: requiredElement("testimonialTemplate"),
    previewTimer: null,
    volatileStorage: false,
  };
}

export function inputValue(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | boolean {
  return input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
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
