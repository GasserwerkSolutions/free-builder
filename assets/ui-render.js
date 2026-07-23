import { PRESETS, escapeHtml, getAtPath, validateWeeklySchedule, } from "./domain.js";
import { buildWebsiteHtml } from "./website.js";
import { BUSINESS_HOURS_NS, renderScheduleEditor } from "./ui-shared.js";
export function bindStaticInputs(context) {
    document.querySelectorAll("[data-bind]").forEach((input) => {
        const value = getAtPath(context.store.snapshot, input.dataset.bind ?? "");
        if (value === undefined)
            return;
        if (input instanceof HTMLInputElement && input.type === "checkbox")
            input.checked = Boolean(value);
        else
            input.value = String(value ?? "");
    });
}
export function renderDynamicControls(context) {
    renderServices(context);
    renderHours(context);
    renderTestimonials(context);
    renderPresets(context);
}
export function renderServices(context) {
    context.serviceList.innerHTML = "";
    if (!context.store.snapshot.services.length) {
        context.serviceList.innerHTML = '<div class="empty-state">Noch keine Leistungen. Füge die erste Leistung hinzu.</div>';
        return;
    }
    context.store.snapshot.services.forEach((service, index) => {
        const fragment = context.serviceTemplate.content.cloneNode(true);
        const card = fragment.querySelector("[data-service-card]");
        if (!card)
            return;
        card.dataset.serviceId = service.clientId;
        const number = fragment.querySelector("[data-service-number]");
        if (number)
            number.textContent = `${index + 1}. ${service.name || "Leistung"}`;
        fragment.querySelectorAll("[data-service-field]").forEach((input) => {
            const field = input.dataset.serviceField;
            if (input instanceof HTMLInputElement && input.type === "checkbox")
                input.checked = Boolean(service[field]);
            else
                input.value = String(service[field] ?? "");
        });
        context.serviceList.appendChild(fragment);
    });
}
export function renderHours(context) {
    context.hoursList.innerHTML = renderScheduleEditor(context.store.snapshot.businessHours, BUSINESS_HOURS_NS);
    renderHoursErrors(context);
}
// Refresh only the opening-hours validation list in place. Used after a time edit so the focused
// time input is never rebuilt (no full renderHours), keeping the caret where it is.
export function renderHoursErrors(context) {
    const errors = validateWeeklySchedule(context.store.snapshot.businessHours);
    const existing = context.hoursList.querySelector(".hours-errors");
    if (!errors.length) {
        existing?.remove();
        return;
    }
    const inner = errors.map((error) => `<span>${escapeHtml(error)}</span>`).join("");
    if (existing)
        existing.innerHTML = inner;
    else
        context.hoursList.insertAdjacentHTML("beforeend", `<div class="hours-errors" role="status">${inner}</div>`);
}
export function renderTestimonials(context) {
    context.testimonialList.innerHTML = "";
    if (!context.store.snapshot.testimonials.items.length) {
        context.testimonialList.innerHTML = '<div class="empty-state">Keine Kundenstimmen eingetragen. Dieser Bereich bleibt auf der Website verborgen.</div>';
        return;
    }
    context.store.snapshot.testimonials.items.forEach((item, index) => {
        const fragment = context.testimonialTemplate.content.cloneNode(true);
        const card = fragment.querySelector("[data-testimonial-card]");
        if (!card)
            return;
        card.dataset.testimonialId = item.clientId;
        const number = fragment.querySelector("[data-testimonial-number]");
        if (number)
            number.textContent = `${index + 1}. Kundenstimme`;
        fragment.querySelectorAll("[data-testimonial-field]").forEach((input) => {
            input.value = item[input.dataset.testimonialField] ?? "";
        });
        context.testimonialList.appendChild(fragment);
    });
}
export function renderPresets(context) {
    document.querySelectorAll("[data-preset]").forEach((button) => {
        const active = button.dataset.preset === context.store.snapshot.theme.preset;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-checked", String(active));
    });
}
export function syncPresetInputs(context, name) {
    const preset = PRESETS[name];
    const primary = document.querySelector('[data-bind="theme.primary"]');
    const accent = document.querySelector('[data-bind="theme.accent"]');
    if (primary)
        primary.value = preset.primary;
    if (accent)
        accent.value = preset.accent;
    renderPresets(context);
}
export function renderPreview(context) {
    context.previewFrame.srcdoc = buildWebsiteHtml(context.store.snapshot, { preview: true });
}
export function schedulePreview(context) {
    if (context.previewTimer)
        clearTimeout(context.previewTimer);
    context.previewTimer = setTimeout(() => renderPreview(context), 80);
}
export function updateReadiness(context) {
    const draft = context.store.snapshot;
    const scheduleErrors = validateWeeklySchedule(draft.businessHours);
    const checks = [
        { label: "Salonname eingetragen", ready: Boolean(draft.salon.name.trim()) },
        { label: "Kontaktmöglichkeit vorhanden", ready: Boolean(draft.salon.phone.trim() || draft.salon.email.trim()) },
        { label: "Mindestens eine Leistung mit Preis", ready: draft.services.some((service) => service.name.trim() && (service.price > 0 || service.priceType === "on-request")) },
        { label: "Öffnungszeiten gültig", ready: scheduleErrors.length === 0 && draft.businessHours.some((day) => !day.closed) },
        { label: "Entwurf im neuen lokalen Speicher", ready: draft.schemaVersion === 2 },
    ];
    context.readinessList.innerHTML = checks.map((check) => `<div class="readiness-item${check.ready ? " is-ready" : ""}">${escapeHtml(check.label)}</div>`).join("");
    if (scheduleErrors.length)
        context.readinessList.insertAdjacentHTML("beforeend", `<div class="readiness-detail">${scheduleErrors.map(escapeHtml).join("<br>")}</div>`);
}
export function updateMigrationNotice(context) {
    const note = document.getElementById("migrationNotice");
    if (!note)
        return;
    if (context.store.snapshot.migration.legacyHeroImageUrl) {
        note.hidden = false;
        note.textContent = "Ein früheres externes Titelbild wurde aus Sicherheitsgründen nicht übernommen. Im Bildschritt kannst du es neu hochladen.";
    }
    else
        note.hidden = true;
}
export function renderSaveState(context, state, error) {
    if (context.volatileStorage) {
        context.saveStatus.textContent = "Nur für diese Sitzung";
        context.saveStatus.className = "status-pill is-error";
        context.saveStatus.title = "Der Browser stellt keinen dauerhaften lokalen Speicher bereit.";
        return;
    }
    const labels = { idle: "Lokal gespeichert", saving: "Speichert …", saved: "Lokal gespeichert", error: "Speichern fehlgeschlagen" };
    context.saveStatus.textContent = labels[state];
    context.saveStatus.className = `status-pill ${state === "saving" ? "is-saving" : state === "saved" ? "is-saved" : state === "error" ? "is-error" : ""}`.trim();
    if (state === "error")
        context.saveStatus.title = error instanceof Error ? error.message : "IndexedDB konnte den Entwurf nicht speichern.";
}
export function showPanel(context, panelName) {
    document.querySelectorAll("[data-panel-target]").forEach((button) => button.classList.toggle("is-active", button.dataset.panelTarget === panelName));
    document.querySelectorAll("[data-panel]").forEach((panel) => {
        const active = panel.dataset.panel === panelName;
        panel.hidden = !active;
        panel.classList.toggle("is-active", active);
    });
    context.surfaceCard.classList.remove("is-turning");
    void context.surfaceCard.offsetWidth;
    context.surfaceCard.classList.add("is-turning");
    if (panelName === "publish")
        updateReadiness(context);
}
export function setViewport(context, viewport) {
    const labels = { desktop: "Desktop", tablet: "Tablet", mobile: "Mobile" };
    context.previewFrame.dataset.viewport = viewport;
    context.previewHint.textContent = labels[viewport] ?? "Desktop";
    document.querySelectorAll("[data-viewport]").forEach((button) => button.classList.toggle("is-active", button.dataset.viewport === viewport));
}
