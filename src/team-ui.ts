import {
  addRange,
  copyBusinessHoursToStaff,
  copyDayToDays,
  createStaffDraft,
  escapeAttr,
  escapeHtml,
  getTeamReadinessChecks,
  getTeamReadinessIssues,
  removeRange,
  removeStaffAndOwnedAssets,
  setAllBookableServicesForStaff,
  setDayClosed,
  setRangeField,
  setStaffService,
  staffHasPersonalHours,
  validateWeeklySchedule,
  type BuilderStaff,
  type DayOfWeek,
} from "./domain.js";
import type { DraftRepository } from "./persistence.js";
import type { BuilderStore } from "./store.js";
import { STAFF_HOURS_NS, renderScheduleEditor } from "./ui-shared.js";

const installedStores = new WeakSet<BuilderStore>();
let lastShapeFingerprint = "";

function ensureTeamSurface(): { list: HTMLElement; panel: HTMLElement } {
  let panel = document.querySelector<HTMLElement>('[data-panel="team"]');
  let list = document.getElementById("staffList");
  if (!panel) {
    panel = document.createElement("section");
    panel.className = "panel";
    panel.dataset.panel = "team";
    panel.hidden = true;
    panel.setAttribute("aria-labelledby", "panel-team-title");
    panel.innerHTML = `<div class="panel__header panel__header--action"><div><p class="eyebrow">Buchbarkeit</p><h2 id="panel-team-title">Team &amp; Leistungen</h2><p>Jede Person erhält bewusst ihre Leistungen. Es gibt keine stillen Standard-Zuordnungen.</p></div><button class="button button--primary" type="button" data-team-action="add-staff">Person hinzufügen</button></div><div id="staffList" class="item-list"></div>`;
    const servicesPanel = document.querySelector<HTMLElement>('[data-panel="services"]');
    servicesPanel?.insertAdjacentElement("afterend", panel);
    list = panel.querySelector<HTMLElement>("#staffList");
  }
  if (!document.querySelector('[data-panel-target="team"]')) {
    const button = document.createElement("button");
    button.className = "surface-nav__item";
    button.type = "button";
    button.dataset.panelTarget = "team";
    button.textContent = "Team";
    document.querySelector('[data-panel-target="services"]')?.insertAdjacentElement("afterend", button);
  }
  if (!list) throw new Error("MISSING_ELEMENT:staffList");
  return { list, panel };
}

function shapeFingerprint(store: BuilderStore): string {
  const draft = store.snapshot;
  return JSON.stringify({
    staff: draft.staff.map((person) => person.clientId),
    services: draft.services.map((service) => [service.clientId, service.name, service.bookable]),
  });
}

function staffHoursStatus(person: BuilderStaff): { text: string; ready: boolean } {
  const openDays = person.workingHours.filter((day) => !day.closed).length;
  const errors = validateWeeklySchedule(person.workingHours);
  if (!openDays) return { text: "Noch keine Arbeitszeiten bestätigt", ready: false };
  if (errors.length) return { text: "Arbeitszeiten enthalten Fehler", ready: false };
  return { text: `${openDays} Arbeitstage bestätigt`, ready: true };
}

function renderStaffHoursErrors(person: BuilderStaff): string {
  const errors = validateWeeklySchedule(person.workingHours);
  if (!errors.length) return "";
  return `<div class="hours-errors" role="status">${errors.map((error) => `<span>${escapeHtml(error)}</span>`).join("")}</div>`;
}

function renderStaffCard(store: BuilderStore, person: BuilderStaff, index: number): string {
  const services = store.snapshot.services;
  const status = staffHoursStatus(person);
  const serviceChoices = services.length
    ? services.map((service) => {
        const checked = person.serviceClientIds.includes(service.clientId);
        const disabled = !service.bookable;
        return `<label class="service-choice${disabled ? " is-disabled" : ""}"><input type="checkbox" data-staff-service="${escapeAttr(service.clientId)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}><span><strong>${escapeHtml(service.name || "Unbenannte Leistung")}</strong><small>${disabled ? "Nicht online buchbar" : escapeHtml(service.category || "Leistung")}</small></span></label>`;
      }).join("")
    : '<div class="empty-state">Erfasse zuerst mindestens eine Leistung.</div>';
  return `<article class="item-card staff-card" data-staff-card data-staff-id="${escapeAttr(person.clientId)}">
    <div class="item-card__topline"><strong data-staff-number>${index + 1}. ${escapeHtml(person.name || "Person")}</strong><button class="icon-button" type="button" data-team-action="remove-staff" aria-label="Person entfernen">×</button></div>
    <div class="field-grid"><label class="field"><span>Name</span><input type="text" data-staff-field="name" value="${escapeAttr(person.name)}" placeholder="Anna Muster"></label><label class="field"><span>Rolle</span><input type="text" data-staff-field="role" value="${escapeAttr(person.role)}" placeholder="Coiffeur/in"></label></div>
    <label class="field"><span>E-Mail (optional)</span><input type="email" data-staff-field="email" value="${escapeAttr(person.email)}" autocomplete="email"></label>
    <label class="field"><span>Kurzprofil</span><textarea rows="3" data-staff-field="bio" placeholder="Spezialisierung und Arbeitsweise">${escapeHtml(person.bio)}</textarea></label>
    <label class="switch-row switch-row--compact"><input type="checkbox" data-staff-field="active" ${person.active ? "checked" : ""}><span>Aktiv und für Buchungen vorgesehen</span></label>
    <div class="staff-section"><div class="staff-section__header"><div><strong>Zugeordnete Leistungen</strong><span>Nur diese Leistungen können später bei dieser Person gebucht werden.</span></div><div class="mini-actions"><button type="button" class="text-button" data-team-action="all-services">Alle buchbaren</button><button type="button" class="text-button" data-team-action="no-services">Keine</button></div></div><div class="service-choice-grid">${serviceChoices}</div></div>
    <div class="staff-section staff-hours">
      <div class="staff-hours-row"><div><strong>Arbeitszeiten</strong><span class="${status.ready ? "is-ready" : ""}">${escapeHtml(status.text)}</span></div><button type="button" class="button button--quiet" data-team-action="copy-business-hours">Öffnungszeiten übernehmen</button></div>
      <div class="hours-list hours-list--staff">${renderScheduleEditor(person.workingHours, STAFF_HOURS_NS)}</div>
      ${renderStaffHoursErrors(person)}
    </div>
  </article>`;
}

export function renderTeam(store: BuilderStore): void {
  const { list } = ensureTeamSurface();
  lastShapeFingerprint = shapeFingerprint(store);
  list.innerHTML = store.snapshot.staff.length
    ? store.snapshot.staff.map((person, index) => renderStaffCard(store, person, index)).join("")
    : '<div class="empty-state">Noch keine Person erfasst. Für die spätere Online-Buchung braucht jede buchbare Leistung mindestens eine aktive Person.</div>';
}

function appendTeamReadiness(store: BuilderStore): void {
  const readiness = document.getElementById("readinessList");
  if (!readiness) return;
  readiness.querySelectorAll("[data-team-readiness]").forEach((element) => element.remove());
  const checks = getTeamReadinessChecks(store.snapshot);
  checks.forEach((check) => {
    readiness.insertAdjacentHTML("beforeend", `<div data-team-readiness class="readiness-item${check.ready ? " is-ready" : ""}">${escapeHtml(check.label)}</div>`);
  });
  const issues = getTeamReadinessIssues(store.snapshot);
  if (issues.length) {
    readiness.insertAdjacentHTML("beforeend", `<div data-team-readiness class="readiness-detail">${issues.map((issue) => escapeHtml(issue.message)).join("<br>")}</div>`);
  }
}

function staffIdFrom(target: Element): string {
  return target.closest<HTMLElement>("[data-staff-card]")?.dataset.staffId ?? "";
}

function showTeamToast(message: string): void {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

// Mutate one person's working hours. Scoped by both the staff card and the day-of-week row so the
// staff namespace stays isolated from the salon opening-hours handler in ui-actions.
function mutateStaffHours(store: BuilderStore, staffId: string, dow: DayOfWeek, updater: (hours: BuilderStaff["workingHours"]) => BuilderStaff["workingHours"]): void {
  store.mutate((draft) => {
    const person = draft.staff.find((item) => item.clientId === staffId);
    if (person) person.workingHours = updater(person.workingHours);
  });
}

function handleStaffHourAction(store: BuilderStore, button: HTMLElement): void {
  const staffId = staffIdFrom(button);
  const dayRow = button.closest<HTMLElement>("[data-day-of-week]");
  if (!staffId || !dayRow) return;
  const dayOfWeek = Number(dayRow.dataset.dayOfWeek) as DayOfWeek;
  const action = button.dataset.staffHourAction;
  if (action === "add-range") {
    mutateStaffHours(store, staffId, dayOfWeek, (hours) => addRange(hours, dayOfWeek));
  } else if (action === "remove-range") {
    const rangeIndex = Number(button.dataset.rangeIndex ?? "0");
    mutateStaffHours(store, staffId, dayOfWeek, (hours) => removeRange(hours, dayOfWeek, rangeIndex));
  } else if (action === "copy-day") {
    const person = store.snapshot.staff.find((item) => item.clientId === staffId);
    if (!person) return;
    // Bulk copy is destructive to the other days; confirm before overwriting them.
    if (!window.confirm("Diese Zeiten auf alle anderen Wochentage übernehmen? Bestehende Zeiten der anderen Tage werden dabei überschrieben.")) return;
    const targets = person.workingHours.map((day) => day.dayOfWeek).filter((day) => day !== dayOfWeek);
    mutateStaffHours(store, staffId, dayOfWeek, (hours) => copyDayToDays(hours, dayOfWeek, targets));
  } else {
    return;
  }
  renderTeam(store);
}

export function installTeamUi(store: BuilderStore, repository: DraftRepository): void {
  if (installedStores.has(store)) return;
  installedStores.add(store);
  ensureTeamSurface();
  renderTeam(store);
  appendTeamReadiness(store);

  store.subscribe(() => {
    const nextFingerprint = shapeFingerprint(store);
    if (nextFingerprint !== lastShapeFingerprint) renderTeam(store);
    appendTeamReadiness(store);
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-panel-target="publish"]')) appendTeamReadiness(store);
    const hourActionTarget = target.closest<HTMLElement>("[data-staff-hour-action]");
    if (hourActionTarget) { handleStaffHourAction(store, hourActionTarget); return; }
    const actionTarget = target.closest<HTMLElement>("[data-team-action]");
    if (!actionTarget) return;
    const action = actionTarget.dataset.teamAction;
    const staffId = staffIdFrom(actionTarget);
    if (action === "add-staff") {
      store.mutate((draft) => { draft.staff.push(createStaffDraft()); });
      renderTeam(store);
      return;
    }
    if (!staffId) return;
    if (action === "remove-staff") {
      const assetIds = store.snapshot.assets.filter((asset) => asset.ownerClientId === staffId).map((asset) => asset.localId);
      store.mutate((draft) => removeStaffAndOwnedAssets(draft, staffId));
      void repository.deleteAssetBlobs(assetIds).catch((error) => console.error("Staff asset cleanup failed.", error));
    }
    if (action === "all-services") store.mutate((draft) => setAllBookableServicesForStaff(draft, staffId, true));
    if (action === "no-services") store.mutate((draft) => setAllBookableServicesForStaff(draft, staffId, false));
    if (action === "copy-business-hours") {
      const person = store.snapshot.staff.find((item) => item.clientId === staffId);
      if (!person) return;
      // Never silently destructive: confirm before replacing an existing personal schedule.
      if (staffHasPersonalHours(person) && !window.confirm("Diese Person hat bereits persönliche Arbeitszeiten. Mit den aktuellen Öffnungszeiten überschreiben?")) return;
      store.mutate((draft) => { copyBusinessHoursToStaff(draft, staffId, { overwrite: true }); });
      showTeamToast("Die Öffnungszeiten wurden als persönliche Arbeitszeiten übernommen. Sie können später unabhängig verfeinert werden.");
    }
    renderTeam(store);
  });

  const handleField = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    const staffCard = target.closest<HTMLElement>("[data-staff-card]");
    const staffId = staffCard?.dataset.staffId ?? "";
    if (!staffId) return;
    const field = target.dataset.staffField as "name" | "role" | "email" | "bio" | "active" | undefined;
    if (field) {
      const checkbox = target instanceof HTMLInputElement && target.type === "checkbox";
      if ((checkbox && event.type !== "change") || (!checkbox && event.type !== "input")) return;
      store.mutate((draft) => {
        const person = draft.staff.find((item) => item.clientId === staffId);
        if (!person) return;
        if (field === "active") person.active = checkbox ? target.checked : person.active;
        else person[field] = target.value;
      });
      if (field === "name") {
        const index = store.snapshot.staff.findIndex((person) => person.clientId === staffId);
        const title = staffCard?.querySelector<HTMLElement>("[data-staff-number]");
        if (title) title.textContent = `${index + 1}. ${target.value || "Person"}`;
      }
      return;
    }
    const staffHourField = target.dataset.staffHourField as "from" | "to" | "closed" | undefined;
    if (staffHourField) {
      const dayRow = target.closest<HTMLElement>("[data-day-of-week]");
      if (!dayRow) return;
      const dayOfWeek = Number(dayRow.dataset.dayOfWeek) as DayOfWeek;
      if (staffHourField === "closed") {
        if (event.type !== "change" || !(target instanceof HTMLInputElement)) return;
        const closed = target.checked;
        mutateStaffHours(store, staffId, dayOfWeek, (hours) => setDayClosed(hours, dayOfWeek, closed));
        renderTeam(store);
      } else {
        if (event.type !== "input") return;
        const rangeIndex = Number(target.closest<HTMLElement>("[data-range-index]")?.dataset.rangeIndex ?? "0");
        const value = target.value;
        // No re-render on time edits: the input keeps focus while the model updates.
        mutateStaffHours(store, staffId, dayOfWeek, (hours) => setRangeField(hours, dayOfWeek, rangeIndex, staffHourField, value));
      }
      return;
    }
    const serviceId = target.dataset.staffService;
    if (serviceId && event.type === "change" && target instanceof HTMLInputElement) {
      store.mutate((draft) => setStaffService(draft, staffId, serviceId, target.checked));
    }
  };
  document.addEventListener("input", handleField);
  document.addEventListener("change", handleField);
}
