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
        previewTimer: null,
        volatileStorage: false,
    };
}
export function getAtPath(object, path) {
    return path.split(".").reduce((value, key) => value && typeof value === "object" ? value[key] : undefined, object);
}
export function setAtPath(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    if (!last)
        return;
    let target = object;
    for (const key of keys) {
        const next = target[key];
        if (!next || typeof next !== "object" || Array.isArray(next))
            throw new Error(`INVALID_BIND_PATH:${path}`);
        target = next;
    }
    if (!(last in target))
        throw new Error(`UNKNOWN_BIND_PATH:${path}`);
    target[last] = value;
}
export function inputValue(input) {
    return input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
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
