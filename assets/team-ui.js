import { addRange, copyBusinessHoursToStaff, copyDayToDays, createStaffDraft, escapeAttr, escapeHtml, removeRange, removeStaffAndOwnedAssets, setAllBookableServicesForStaff, setDayClosed, setRangeField, setStaffService, staffHasPersonalHours, validateWeeklySchedule, } from "./domain.js";
import { configureReorderControls } from "./ui-render.js";
import { STAFF_HOURS_NS, historyDescriptor, renderScheduleEditor, safeMutate, showToast } from "./ui-shared.js";
const installedStores = new WeakSet();
const TEAM_PANEL_TARGET = { kind: "panel", panel: "team" };
const STAFF_TARGET_FIELDS = ["name", "role", "bio"];
// Which editor field a team history step was about. Fields the preview does not render (e-mail,
// the active switch) point at the panel instead of inventing a target for something invisible.
function staffTarget(staffClientId, field) {
    return STAFF_TARGET_FIELDS.includes(field)
        ? { kind: "staff", staffClientId, field: field }
        : TEAM_PANEL_TARGET;
}
let lastShapeFingerprint = "";
function ensureTeamSurface() {
    let panel = document.querySelector('[data-panel="team"]');
    let list = document.getElementById("staffList");
    if (!panel) {
        panel = document.createElement("section");
        panel.className = "panel";
        panel.dataset.panel = "team";
        panel.hidden = true;
        panel.setAttribute("aria-labelledby", "panel-team-title");
        panel.innerHTML = `<div class="panel__header panel__header--action"><div><p class="eyebrow">Buchbarkeit</p><h2 id="panel-team-title">Team &amp; Leistungen</h2><p>Jede Person erhält bewusst ihre Leistungen. Es gibt keine stillen Standard-Zuordnungen.</p></div><button class="button button--primary" type="button" data-team-action="add-staff">Person hinzufügen</button></div><div id="staffList" class="item-list"></div>`;
        const servicesPanel = document.querySelector('[data-panel="services"]');
        servicesPanel?.insertAdjacentElement("afterend", panel);
        list = panel.querySelector("#staffList");
    }
    if (!document.querySelector('[data-panel-target="team"]')) {
        const button = document.createElement("button");
        button.className = "surface-nav__item";
        button.type = "button";
        button.dataset.panelTarget = "team";
        button.textContent = "Team";
        document.querySelector('[data-panel-target="services"]')?.insertAdjacentElement("afterend", button);
    }
    if (!list)
        throw new Error("MISSING_ELEMENT:staffList");
    return { list, panel };
}
function shapeFingerprint(store) {
    const draft = store.snapshot;
    return JSON.stringify({
        staff: draft.staff.map((person) => person.clientId),
        services: draft.services.map((service) => [service.clientId, service.name, service.bookable]),
    });
}
function staffHoursStatus(person) {
    const openDays = person.workingHours.filter((day) => !day.closed).length;
    const errors = validateWeeklySchedule(person.workingHours);
    if (!openDays)
        return { text: "Noch keine Arbeitszeiten bestätigt", ready: false };
    if (errors.length)
        return { text: "Arbeitszeiten enthalten Fehler", ready: false };
    return { text: `${openDays} Arbeitstage bestätigt`, ready: true };
}
function renderStaffHoursErrors(person) {
    const errors = validateWeeklySchedule(person.workingHours);
    if (!errors.length)
        return "";
    return `<div class="hours-errors" role="status">${errors.map((error) => `<span>${escapeHtml(error)}</span>`).join("")}</div>`;
}
// Refresh a single staff card's validation surfaces in place after a time edit: the person's status
// indicator and the inline error list. The card's inputs are not rebuilt, so the focused field stays.
function updateStaffHoursValidity(staffCard, person) {
    const status = staffHoursStatus(person);
    const statusEl = staffCard.querySelector(".staff-hours-row span");
    if (statusEl) {
        statusEl.textContent = status.text;
        statusEl.className = status.ready ? "is-ready" : "";
    }
    const errors = validateWeeklySchedule(person.workingHours);
    const existing = staffCard.querySelector(".hours-errors");
    if (!errors.length) {
        existing?.remove();
        return;
    }
    const inner = errors.map((error) => `<span>${escapeHtml(error)}</span>`).join("");
    if (existing) {
        existing.innerHTML = inner;
        return;
    }
    staffCard.querySelector(".staff-hours")?.insertAdjacentHTML("beforeend", `<div class="hours-errors" role="status">${inner}</div>`);
}
function renderStaffCard(store, person, index) {
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
export function renderTeam(store) {
    const { list } = ensureTeamSurface();
    const staff = store.snapshot.staff;
    lastShapeFingerprint = shapeFingerprint(store);
    list.innerHTML = staff.length
        ? staff.map((person, index) => renderStaffCard(store, person, index)).join("")
        : '<div class="empty-state">Noch keine Person erfasst. Für die spätere Online-Buchung braucht jede buchbare Leistung mindestens eine aktive Person.</div>';
    // The reorder controls come from the one builder in ui-render, so a person's card carries exactly
    // the same three buttons as a service or a voice.
    list.querySelectorAll("[data-staff-card]").forEach((card, index) => {
        configureReorderControls(card, `Person „${staff[index]?.name.trim() || "Ohne Namen"}“`, index, staff.length);
    });
}
function staffIdFrom(target) {
    return target.closest("[data-staff-card]")?.dataset.staffId ?? "";
}
// Mutate one person's working hours. Scoped by both the staff card and the day-of-week row so the
// staff namespace stays isolated from the salon opening-hours handler in ui-actions. The declared
// intent is that person's workingHours only — a write that also touched businessHours is rejected.
function mutateStaffHours(store, staffId, updater, label, key) {
    safeMutate(store, (draft) => {
        const person = draft.staff.find((item) => item.clientId === staffId);
        if (person)
            person.workingHours = updater(person.workingHours);
    }, { intent: { type: "set-staff-hours", staffClientId: staffId }, history: historyDescriptor(label, { ...(key ? { key } : {}), target: TEAM_PANEL_TARGET }) });
}
// serviceClientIds is the only truth about who may perform what, so an assignment edit declares
// exactly that list as its scope — it may not drag a service definition or a schedule along.
function mutateStaffServices(store, staffId, mutator, label) {
    safeMutate(store, mutator, { intent: { type: "set-staff-services", staffClientId: staffId }, history: historyDescriptor(label, { target: TEAM_PANEL_TARGET }) });
}
function handleStaffHourAction(store, button) {
    const staffId = staffIdFrom(button);
    const dayRow = button.closest("[data-day-of-week]");
    if (!staffId || !dayRow)
        return;
    const dayOfWeek = Number(dayRow.dataset.dayOfWeek);
    const action = button.dataset.staffHourAction;
    if (action === "add-range") {
        mutateStaffHours(store, staffId, (hours) => addRange(hours, dayOfWeek), "Arbeitszeit-Spanne hinzugefügt");
    }
    else if (action === "remove-range") {
        const rangeIndex = Number(button.dataset.rangeIndex ?? "0");
        mutateStaffHours(store, staffId, (hours) => removeRange(hours, dayOfWeek, rangeIndex), "Arbeitszeit-Spanne entfernt");
    }
    else if (action === "copy-day") {
        const person = store.snapshot.staff.find((item) => item.clientId === staffId);
        if (!person)
            return;
        // Bulk copy is destructive to the other days; confirm before overwriting them.
        if (!window.confirm("Diese Zeiten auf alle anderen Wochentage übernehmen? Bestehende Zeiten der anderen Tage werden dabei überschrieben."))
            return;
        const targets = person.workingHours.map((day) => day.dayOfWeek).filter((day) => day !== dayOfWeek);
        mutateStaffHours(store, staffId, (hours) => copyDayToDays(hours, dayOfWeek, targets), "Arbeitszeiten auf andere Tage übernommen");
    }
    else {
        return;
    }
    renderTeam(store);
}
export function installTeamUi(store, repository) {
    if (installedStores.has(store))
        return;
    installedStores.add(store);
    ensureTeamSurface();
    renderTeam(store);
    store.subscribe((_draft, mutation) => {
        // Undo and redo can change anything on a card without changing the shape of the team, so they
        // always rebuild it — and they do so before the caller navigates into the restored field.
        const rebuilt = mutation.source === "undo" || mutation.source === "redo";
        if (rebuilt || shapeFingerprint(store) !== lastShapeFingerprint)
            renderTeam(store);
    });
    document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element))
            return;
        const hourActionTarget = target.closest("[data-staff-hour-action]");
        if (hourActionTarget) {
            handleStaffHourAction(store, hourActionTarget);
            return;
        }
        const actionTarget = target.closest("[data-team-action]");
        if (!actionTarget)
            return;
        const action = actionTarget.dataset.teamAction;
        const staffId = staffIdFrom(actionTarget);
        if (action === "add-staff") {
            // Built outside the mutator so the intent can name the person it is about to insert.
            const person = createStaffDraft();
            safeMutate(store, (draft) => { draft.staff.push(person); }, { intent: { type: "insert-collection-item", collection: "staff", clientId: person.clientId }, history: historyDescriptor("Person hinzugefügt", { target: { kind: "staff", staffClientId: person.clientId, field: "name" } }) });
            renderTeam(store);
            return;
        }
        if (!staffId)
            return;
        if (action === "remove-staff") {
            const assetIds = store.snapshot.assets.filter((asset) => asset.ownerClientId === staffId).map((asset) => asset.localId);
            safeMutate(store, (draft) => removeStaffAndOwnedAssets(draft, staffId), { intent: { type: "remove-collection-item", collection: "staff", clientId: staffId }, history: historyDescriptor("Person entfernt", { target: TEAM_PANEL_TARGET }) });
            void repository.deleteAssetBlobs(assetIds).catch((error) => console.error("Staff asset cleanup failed.", error));
        }
        if (action === "all-services")
            mutateStaffServices(store, staffId, (draft) => setAllBookableServicesForStaff(draft, staffId, true), "Alle buchbaren Leistungen zugeordnet");
        if (action === "no-services")
            mutateStaffServices(store, staffId, (draft) => setAllBookableServicesForStaff(draft, staffId, false), "Leistungszuordnung geleert");
        if (action === "copy-business-hours") {
            const person = store.snapshot.staff.find((item) => item.clientId === staffId);
            if (!person)
                return;
            // Never silently destructive: confirm before replacing an existing personal schedule.
            if (staffHasPersonalHours(person) && !window.confirm("Diese Person hat bereits persönliche Arbeitszeiten. Mit den aktuellen Öffnungszeiten überschreiben?"))
                return;
            // Copying reads businessHours but may only write this person's workingHours; the two schedules
            // stay separate truths and the mutation verifier enforces that.
            safeMutate(store, (draft) => { copyBusinessHoursToStaff(draft, staffId, { overwrite: true }); }, { intent: { type: "set-staff-hours", staffClientId: staffId }, history: historyDescriptor("Öffnungszeiten als Arbeitszeiten übernommen", { target: TEAM_PANEL_TARGET }) });
            showToast("Die Öffnungszeiten wurden als persönliche Arbeitszeiten übernommen. Sie können später unabhängig verfeinert werden.");
        }
        renderTeam(store);
    });
    const handleField = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement))
            return;
        const staffCard = target.closest("[data-staff-card]");
        const staffId = staffCard?.dataset.staffId ?? "";
        if (!staffId)
            return;
        const field = target.dataset.staffField;
        if (field) {
            const checkbox = target instanceof HTMLInputElement && target.type === "checkbox";
            if ((checkbox && event.type !== "change") || (!checkbox && event.type !== "input"))
                return;
            safeMutate(store, (draft) => {
                const person = draft.staff.find((item) => item.clientId === staffId);
                if (!person)
                    return;
                if (field === "active")
                    person.active = checkbox ? target.checked : person.active;
                else
                    person[field] = target.value;
            }, { intent: { type: "set-staff-field", staffClientId: staffId, field }, history: historyDescriptor("Person bearbeitet", { key: `staff:${staffId}:${field}`, target: staffTarget(staffId, field) }) });
            if (field === "name") {
                const index = store.snapshot.staff.findIndex((person) => person.clientId === staffId);
                const title = staffCard?.querySelector("[data-staff-number]");
                if (title)
                    title.textContent = `${index + 1}. ${target.value || "Person"}`;
                // The reorder controls carry the person's name in their accessible labels, and they are only
                // built on a full render — so a rename has to reach them here or they keep the old name.
                if (staffCard && index >= 0)
                    configureReorderControls(staffCard, `Person „${target.value.trim() || "Ohne Namen"}“`, index, store.snapshot.staff.length);
            }
            return;
        }
        const staffHourField = target.dataset.staffHourField;
        if (staffHourField) {
            const dayRow = target.closest("[data-day-of-week]");
            if (!dayRow)
                return;
            const dayOfWeek = Number(dayRow.dataset.dayOfWeek);
            if (staffHourField === "closed") {
                if (event.type !== "change" || !(target instanceof HTMLInputElement))
                    return;
                const closed = target.checked;
                mutateStaffHours(store, staffId, (hours) => setDayClosed(hours, dayOfWeek, closed), closed ? "Arbeitstag geschlossen" : "Arbeitstag geöffnet");
                renderTeam(store);
            }
            else {
                if (event.type !== "input")
                    return;
                const rangeIndex = Number(target.closest("[data-range-index]")?.dataset.rangeIndex ?? "0");
                const value = target.value;
                // No card re-render on time edits (keeps the focused input); team readiness is refreshed by
                // the store subscription, and this card's status + error list are updated in place below.
                mutateStaffHours(store, staffId, (hours) => setRangeField(hours, dayOfWeek, rangeIndex, staffHourField, value), "Arbeitszeiten angepasst", `staff-hours:${staffId}:${dayOfWeek}:${rangeIndex}:${staffHourField}`);
                const person = store.snapshot.staff.find((item) => item.clientId === staffId);
                if (person && staffCard)
                    updateStaffHoursValidity(staffCard, person);
            }
            return;
        }
        const serviceId = target.dataset.staffService;
        if (serviceId && event.type === "change" && target instanceof HTMLInputElement) {
            const selected = target.checked;
            mutateStaffServices(store, staffId, (draft) => setStaffService(draft, staffId, serviceId, selected), selected ? "Leistung zugeordnet" : "Leistungszuordnung entfernt");
        }
    };
    document.addEventListener("input", handleField);
    document.addEventListener("change", handleField);
}
