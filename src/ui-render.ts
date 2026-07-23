import {
  PRESETS,
  escapeAttr,
  escapeHtml,
  getAtPath,
  validateWeeklySchedule,
  type BuilderService,
  type ThemePresetName,
} from "./domain.js";
import { evaluateReadiness, type ReadinessSeverity } from "./readiness.js";
import type { SaveState } from "./store.js";
import { BUSINESS_HOURS_NS, renderScheduleEditor, type UiContext } from "./ui-shared.js";

const SEVERITY_LABELS: Record<ReadinessSeverity, string> = { error: "Blocker", warning: "Hinweis" };

export function bindStaticInputs(context: UiContext): void {
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-bind]").forEach((input) => {
    const value = getAtPath(context.store.snapshot, input.dataset.bind ?? "");
    if (value === undefined) return;
    if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value ?? "");
  });
}

export function renderDynamicControls(context: UiContext): void {
  renderServices(context);
  renderHours(context);
  renderTestimonials(context);
  renderPresets(context);
}

export function renderServices(context: UiContext): void {
  context.serviceList.innerHTML = "";
  const services = context.store.snapshot.services;
  if (!services.length) {
    context.serviceList.innerHTML = '<div class="empty-state">Noch keine Leistungen. Füge die erste Leistung hinzu.</div>';
    return;
  }
  services.forEach((service, index) => {
    const fragment = context.serviceTemplate.content.cloneNode(true) as DocumentFragment;
    const card = fragment.querySelector<HTMLElement>("[data-service-card]");
    if (!card) return;
    card.dataset.serviceId = service.clientId;
    const number = fragment.querySelector<HTMLElement>("[data-service-number]");
    if (number) number.textContent = `${index + 1}. ${service.name || "Leistung"}`;
    fragment.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-service-field]").forEach((input) => {
      const field = input.dataset.serviceField as keyof BuilderService;
      if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = Boolean(service[field]);
      else input.value = String(service[field] ?? "");
    });
    configureReorderControls(card, `Leistung „${service.name.trim() || "Ohne Namen"}“`, index, services.length);
    context.serviceList.appendChild(fragment);
  });
}

/**
 * The reorder controls of one card — built here and nowhere else.
 *
 * The markup exists exactly once for all three reorderable lists (services, people, voices); the two
 * static templates and the team surface would otherwise carry three copies of the same three buttons.
 */
export function configureReorderControls(card: HTMLElement, label: string, index: number, count: number): void {
  const topline = card.querySelector<HTMLElement>(".item-card__topline");
  if (!topline) return;
  let group = topline.querySelector<HTMLElement>(".reorder-actions");
  if (!group) {
    const removeButton = topline.querySelector<HTMLElement>(".icon-button");
    group = document.createElement("div");
    group.className = "reorder-actions";
    group.setAttribute("role", "group");
    group.innerHTML = '<button class="icon-button icon-button--move" type="button" data-reorder-direction="up">↑</button>'
      + '<button class="reorder-handle" type="button" data-reorder-handle><span aria-hidden="true">⠿</span></button>'
      + '<button class="icon-button icon-button--move" type="button" data-reorder-direction="down">↓</button>';
    if (removeButton) topline.insertBefore(group, removeButton);
    else topline.appendChild(group);
  }
  group.setAttribute("aria-label", `Reihenfolge von ${label} ändern`);
  card.setAttribute("aria-label", `${label}, Position ${index + 1} von ${count}`);
  group.querySelectorAll<HTMLButtonElement>("[data-reorder-direction]").forEach((button) => {
    const upward = button.dataset.reorderDirection === "up";
    button.disabled = count < 2 || (upward ? index === 0 : index === count - 1);
    const description = `${label} nach ${upward ? "oben" : "unten"}`;
    button.setAttribute("aria-label", description);
    button.title = description;
  });
  const handle = group.querySelector<HTMLButtonElement>("[data-reorder-handle]");
  if (!handle) return;
  handle.disabled = count < 2;
  handle.setAttribute("aria-label", `${label} ziehen. Alternativ mit Alt und Pfeil hoch oder runter verschieben.`);
  handle.title = "Ziehen oder Alt + Pfeil hoch/runter";
}

export function renderHours(context: UiContext): void {
  context.hoursList.innerHTML = renderScheduleEditor(context.store.snapshot.businessHours, BUSINESS_HOURS_NS);
  renderHoursErrors(context);
}

// Refresh only the opening-hours validation list in place. Used after a time edit so the focused
// time input is never rebuilt (no full renderHours), keeping the caret where it is.
export function renderHoursErrors(context: UiContext): void {
  const errors = validateWeeklySchedule(context.store.snapshot.businessHours);
  const existing = context.hoursList.querySelector<HTMLElement>(".hours-errors");
  if (!errors.length) { existing?.remove(); return; }
  const inner = errors.map((error) => `<span>${escapeHtml(error)}</span>`).join("");
  if (existing) existing.innerHTML = inner;
  else context.hoursList.insertAdjacentHTML("beforeend", `<div class="hours-errors" role="status">${inner}</div>`);
}

export function renderTestimonials(context: UiContext): void {
  context.testimonialList.innerHTML = "";
  const items = context.store.snapshot.testimonials.items;
  if (!items.length) {
    context.testimonialList.innerHTML = '<div class="empty-state">Keine Kundenstimmen eingetragen. Dieser Bereich bleibt auf der Website verborgen.</div>';
    return;
  }
  items.forEach((item, index) => {
    const fragment = context.testimonialTemplate.content.cloneNode(true) as DocumentFragment;
    const card = fragment.querySelector<HTMLElement>("[data-testimonial-card]");
    if (!card) return;
    card.dataset.testimonialId = item.clientId;
    const number = fragment.querySelector<HTMLElement>("[data-testimonial-number]");
    if (number) number.textContent = `${index + 1}. Kundenstimme`;
    fragment.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-testimonial-field]").forEach((input) => {
      input.value = item[input.dataset.testimonialField as "quote" | "name" | "detail"] ?? "";
    });
    configureReorderControls(card, `Kundenstimme „${item.name.trim() || "Ohne Namen"}“`, index, items.length);
    context.testimonialList.appendChild(fragment);
  });
}

export function renderPresets(context: UiContext): void {
  document.querySelectorAll<HTMLElement>("[data-preset]").forEach((button) => {
    const active = button.dataset.preset === context.store.snapshot.theme.preset;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
}

export function syncPresetInputs(context: UiContext, name: ThemePresetName): void {
  const preset = PRESETS[name];
  const primary = document.querySelector<HTMLInputElement>('[data-bind="theme.primary"]');
  const accent = document.querySelector<HTMLInputElement>('[data-bind="theme.accent"]');
  if (primary) primary.value = preset.primary;
  if (accent) accent.value = preset.accent;
  renderPresets(context);
}

/**
 * Rebuild the preview document from scratch. Only for authoritative changes (reset, import): every
 * ordinary edit goes through the preview protocol, which patches instead of reloading.
 */
export function renderPreview(context: UiContext): void {
  context.preview?.renderFull();
}

/**
 * The publish list: what is still open, worst first, and every line a jump into the field that owns
 * the problem. Nothing here decides what "open" means — that is readiness.ts.
 *
 * The summary only ever describes; it does not gate. It used to phrase readiness as a condition for
 * exporting ("Die Website kann exportiert werden") while both export buttons stayed enabled with
 * blockers on the list. Locking publication down belongs to the later publish step, so what is said
 * here is exactly what is enforced here: nothing.
 */
export function updateReadiness(context: UiContext): void {
  const summary = evaluateReadiness(context.store.snapshot);
  const title = summary.ready ? summary.clean ? "Bereit, ohne offene Hinweise" : "Bereit, mit Hinweisen" : `${summary.errorCount} offene ${summary.errorCount === 1 ? "Blockierung" : "Blockierungen"}`;
  const detail = summary.ready
    ? summary.clean
      ? "Alles Geprüfte ist beisammen. Nichts hält die spätere Veröffentlichung auf."
      : `${summary.warningCount} ${summary.warningCount === 1 ? "Hinweis hält" : "Hinweise halten"} dich nicht auf — du kannst sie bewusst stehen lassen.`
    : "Tippe einen Punkt an, um direkt im zuständigen Feld zu landen. Exportieren kannst du trotzdem — offen bleiben die Punkte dann aber.";
  context.readinessSummary.className = `readiness-summary ${summary.ready ? "is-ready" : "is-blocked"}${summary.clean ? " is-clean" : ""}`;
  context.readinessSummary.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`
    + `<div class="readiness-counts"><span>${summary.errorCount} Blocker</span><span>${summary.warningCount} Hinweise</span></div>`;
  context.readinessList.innerHTML = summary.results.length
    ? summary.results.map((item) => `<button class="readiness-result is-${item.severity}" type="button" data-editor-target="${escapeAttr(JSON.stringify(item.target))}">`
      + `<span class="readiness-result__severity">${escapeHtml(SEVERITY_LABELS[item.severity])}</span>`
      + `<span class="readiness-result__copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></span>`
      + `<span class="readiness-result__arrow" aria-hidden="true">→</span><span class="visually-hidden">bearbeiten</span>`
      + `</button>`).join("")
    : '<div class="readiness-empty"><strong>Keine offenen Punkte</strong><span>Jede geprüfte Angabe ist vorhanden und brauchbar.</span></div>';
}

export function updateMigrationNotice(context: UiContext): void {
  const note = document.getElementById("migrationNotice");
  if (!note) return;
  if (context.store.snapshot.migration.legacyHeroImageUrl) {
    note.hidden = false;
    note.textContent = "Ein früheres externes Titelbild wurde aus Sicherheitsgründen nicht übernommen. Im Bildschritt kannst du es neu hochladen.";
  } else note.hidden = true;
}

export function renderSaveState(context: UiContext, state: SaveState, error?: unknown): void {
  if (context.volatileStorage) {
    context.saveStatus.textContent = "Nur für diese Sitzung";
    context.saveStatus.className = "status-pill is-error";
    context.saveStatus.title = "Der Browser stellt keinen dauerhaften lokalen Speicher bereit.";
    return;
  }
  const labels: Record<SaveState, string> = { idle: "Lokal gespeichert", saving: "Speichert …", saved: "Lokal gespeichert", error: "Speichern fehlgeschlagen" };
  context.saveStatus.textContent = labels[state];
  context.saveStatus.className = `status-pill ${state === "saving" ? "is-saving" : state === "saved" ? "is-saved" : state === "error" ? "is-error" : ""}`.trim();
  if (state === "error") context.saveStatus.title = error instanceof Error ? error.message : "IndexedDB konnte den Entwurf nicht speichern.";
}

export function showPanel(context: UiContext, panelName: string): void {
  document.querySelectorAll<HTMLElement>("[data-panel-target]").forEach((button) => button.classList.toggle("is-active", button.dataset.panelTarget === panelName));
  document.querySelectorAll<HTMLElement>("[data-panel]").forEach((panel) => {
    const active = panel.dataset.panel === panelName;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  context.surfaceCard.classList.remove("is-turning");
  void context.surfaceCard.offsetWidth;
  context.surfaceCard.classList.add("is-turning");
  if (panelName === "publish") updateReadiness(context);
}

export function setViewport(context: UiContext, viewport: string): void {
  const labels: Record<string, string> = { desktop: "Desktop", tablet: "Tablet", mobile: "Mobile" };
  context.previewFrame.dataset.viewport = viewport;
  context.previewHint.textContent = labels[viewport] ?? "Desktop";
  document.querySelectorAll<HTMLElement>("[data-viewport]").forEach((button) => button.classList.toggle("is-active", button.dataset.viewport === viewport));
}
