import { MAX_RANGES_PER_DAY, dayName, escapeAttr, escapeHtml } from "./domain.js";
function requiredElement(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`MISSING_ELEMENT:${id}`);
    return element;
}
export function createUiContext(store, repository) {
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
        preview: null,
        volatileStorage: false,
    };
}
/**
 * The polite channel for things the user should hear but not be interrupted by — currently only the
 * result of a click in the preview. Created on demand so the static page owns no dead markup.
 */
export function announce(context, message) {
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
export function historyDescriptor(label, options = {}) {
    return { label, ...(options.key ? { key: options.key } : {}), ...(options.target ? { target: options.target } : {}) };
}
export function inputValue(input) {
    return input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
}
/** The one error channel of the editor: a short, plain message on the surface. */
export function showToast(message) {
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
export function safeMutate(store, mutator, descriptor) {
    try {
        return store.mutate(mutator, descriptor);
    }
    catch (error) {
        console.error("Draft mutation rejected.", descriptor.intent, error);
        showToast("Diese Änderung wurde nicht übernommen. Der Entwurf bleibt auf dem zuletzt geprüften Stand.");
        return null;
    }
}
export const BUSINESS_HOURS_NS = { field: "data-hour-field", action: "data-hour-action" };
export const STAFF_HOURS_NS = { field: "data-staff-hour-field", action: "data-staff-hour-action" };
// Render one day of the schedule editor. Reused for salon opening hours and per-person working hours;
// the caller picks the namespace so a document-wide delegator can tell the two editors apart.
export function renderScheduleDayEditor(day, ns) {
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
export function renderScheduleEditor(schedule, ns) {
    return schedule.map((day) => renderScheduleDayEditor(day, ns)).join("");
}
