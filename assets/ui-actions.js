import { MAX_TESTIMONIALS, PRESETS, createClientId, slugify, uniqueSlug, } from "./domain.js";
import { addRange, copyDayToDays, removeRange, setAtPath, setDayClosed, setRangeField } from "./domain.js";
import { replaceWithFreshDraft } from "./persistence.js";
import { buildWebsiteHtml } from "./website.js";
import { inputValue, safeMutate, showToast } from "./ui-shared.js";
import { bindStaticInputs, renderDynamicControls, renderHours, renderHoursErrors, renderPreview, renderServices, renderTestimonials, setViewport, showPanel, syncPresetInputs, updateReadiness, } from "./ui-render.js";
export function handleClick(context, event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const panelButton = target.closest("[data-panel-target]");
    if (panelButton) {
        showPanel(context, panelButton.dataset.panelTarget ?? "salon");
        return;
    }
    const viewportButton = target.closest("[data-viewport]");
    if (viewportButton) {
        setViewport(context, viewportButton.dataset.viewport ?? "desktop");
        return;
    }
    const presetButton = target.closest("[data-preset]");
    if (presetButton) {
        applyPreset(context, presetButton.dataset.preset);
        return;
    }
    const hourActionButton = target.closest("[data-hour-action]");
    if (hourActionButton) {
        handleHourAction(context, hourActionButton);
        return;
    }
    const actionButton = target.closest("[data-action]");
    if (!actionButton)
        return;
    const action = actionButton.dataset.action;
    if (action === "add-service")
        addService(context);
    if (action === "remove-service")
        removeService(context, actionButton.closest("[data-service-card]")?.dataset.serviceId ?? "");
    if (action === "add-testimonial")
        addTestimonial(context);
    if (action === "remove-testimonial")
        removeTestimonial(context, actionButton.closest("[data-testimonial-card]")?.dataset.testimonialId ?? "");
    if (action === "export")
        exportHtml(context);
    if (action === "copy-json")
        void copySalonData(context);
    if (action === "reset")
        void resetBuilder(context);
}
export function handleInput(context, event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement))
        return;
    const bind = target.dataset.bind;
    if (bind) {
        // The bound path is the declared scope; an unknown path or a write beyond it is rejected there.
        safeMutate(context.store, (draft) => setAtPath(draft, bind, inputValue(target)), { intent: { type: "set-field", field: bind }, history: { key: `field:${bind}`, label: bindLabel(bind) } });
        return;
    }
    const serviceField = target.dataset.serviceField;
    const serviceCard = target.closest("[data-service-card]");
    const serviceClientId = serviceCard?.dataset.serviceId;
    if (serviceField && serviceClientId) {
        safeMutate(context.store, (draft) => {
            const service = draft.services.find((item) => item.clientId === serviceClientId);
            if (!service)
                return;
            if (serviceField === "durationMinutes" || serviceField === "price")
                service[serviceField] = Number(target.value || 0);
            else if (serviceField === "bookable")
                service.bookable = target instanceof HTMLInputElement ? target.checked : true;
            else if (serviceField === "name") {
                service.name = target.value;
                service.slug = uniqueSlug(target.value, draft.services, service.clientId);
            }
            else if (serviceField !== "clientId")
                service[serviceField] = target.value;
        }, {
            intent: { type: "set-service-field", serviceClientId, field: serviceField },
            history: { key: `service:${serviceClientId}:${serviceField}`, label: "Leistung bearbeitet" },
        });
        if (serviceField === "name") {
            const number = serviceCard?.querySelector("[data-service-number]");
            if (number) {
                const index = context.store.snapshot.services.findIndex((service) => service.clientId === serviceClientId);
                number.textContent = `${index + 1}. ${target.value || "Leistung"}`;
            }
        }
        return;
    }
    const testimonialField = target.dataset.testimonialField;
    const testimonialClientId = target.closest("[data-testimonial-card]")?.dataset.testimonialId;
    if (testimonialField && testimonialClientId) {
        safeMutate(context.store, (draft) => {
            const item = draft.testimonials.items.find((voice) => voice.clientId === testimonialClientId);
            if (item)
                item[testimonialField] = target.value;
        }, {
            intent: { type: "set-testimonial-field", testimonialClientId, field: testimonialField },
            history: { key: `testimonial:${testimonialClientId}:${testimonialField}`, label: "Kundenstimme bearbeitet" },
        });
        return;
    }
    const hourField = target.dataset.hourField;
    const hourRow = target.closest("[data-day-of-week]");
    if (hourField && hourRow) {
        const dayOfWeek = Number(hourRow.dataset.dayOfWeek);
        if (hourField === "closed") {
            const closed = target instanceof HTMLInputElement ? target.checked : false;
            mutateBusinessHours(context, (draft) => { draft.businessHours = setDayClosed(draft.businessHours, dayOfWeek, closed); }, closed ? "Öffnungstag geschlossen" : "Öffnungstag geöffnet");
            renderHours(context);
        }
        else {
            const rangeIndex = Number(target.closest("[data-range-index]")?.dataset.rangeIndex ?? "0");
            const value = target.value;
            // No full re-render on time edits (keeps the focused input); readiness is refreshed by the
            // store subscription, and the inline error list is updated in place below.
            mutateBusinessHours(context, (draft) => { draft.businessHours = setRangeField(draft.businessHours, dayOfWeek, rangeIndex, hourField, value); }, "Öffnungszeiten angepasst", `business-hours:${dayOfWeek}:${rangeIndex}:${hourField}`);
            hourRow.classList.remove("is-closed");
            renderHoursErrors(context);
        }
    }
}
function bindLabel(path) {
    if (path.startsWith("copy."))
        return "Text angepasst";
    if (path.startsWith("theme."))
        return "Farbe angepasst";
    if (path === "testimonials.enabled")
        return "Kundenstimmen umgeschaltet";
    return "Salonangabe angepasst";
}
// Every opening-hours edit declares businessHours as its only scope, so a write that also touched a
// person's working hours would be rejected instead of silently merging the two schedules.
function mutateBusinessHours(context, mutator, label, key) {
    safeMutate(context.store, mutator, { intent: { type: "set-business-hours" }, history: key ? { key, label } : { label } });
}
function handleHourAction(context, button) {
    const dayRow = button.closest("[data-day-of-week]");
    if (!dayRow)
        return;
    const dayOfWeek = Number(dayRow.dataset.dayOfWeek);
    const action = button.dataset.hourAction;
    if (action === "add-range") {
        mutateBusinessHours(context, (draft) => { draft.businessHours = addRange(draft.businessHours, dayOfWeek); }, "Zeitspanne hinzugefügt");
    }
    else if (action === "remove-range") {
        const rangeIndex = Number(button.dataset.rangeIndex ?? "0");
        mutateBusinessHours(context, (draft) => { draft.businessHours = removeRange(draft.businessHours, dayOfWeek, rangeIndex); }, "Zeitspanne entfernt");
    }
    else if (action === "copy-day") {
        // Bulk copy is destructive to the other days; confirm before overwriting them.
        if (!window.confirm("Diese Zeiten auf alle anderen Wochentage übernehmen? Bestehende Zeiten der anderen Tage werden dabei überschrieben."))
            return;
        const targets = context.store.snapshot.businessHours.map((day) => day.dayOfWeek).filter((day) => day !== dayOfWeek);
        mutateBusinessHours(context, (draft) => { draft.businessHours = copyDayToDays(draft.businessHours, dayOfWeek, targets); }, "Zeiten auf andere Tage übernommen");
    }
    else {
        return;
    }
    renderHours(context);
}
function addService(context) {
    // The id is minted outside the mutator so the intent can name the item it is about to insert.
    const clientId = createClientId("service");
    safeMutate(context.store, (draft) => {
        draft.services.push({ clientId, slug: uniqueSlug("Neue Leistung", draft.services), category: "Schnitt", name: "Neue Leistung", description: "", durationMinutes: 30, price: 0, priceType: "fixed", bookable: true });
    }, { intent: { type: "insert-collection-item", collection: "services", clientId }, history: { label: "Leistung hinzugefügt" } });
    renderServices(context);
}
function removeService(context, clientId) {
    if (!clientId)
        return;
    safeMutate(context.store, (draft) => {
        draft.services = draft.services.filter((service) => service.clientId !== clientId);
        draft.staff.forEach((person) => { person.serviceClientIds = person.serviceClientIds.filter((id) => id !== clientId); });
    }, { intent: { type: "remove-collection-item", collection: "services", clientId }, history: { label: "Leistung entfernt" } });
    renderServices(context);
}
function addTestimonial(context) {
    if (context.store.snapshot.testimonials.items.length >= MAX_TESTIMONIALS) {
        showToast("In der Gratisversion sind maximal drei manuelle Kundenstimmen vorgesehen.");
        return;
    }
    const clientId = createClientId("voice");
    safeMutate(context.store, (draft) => {
        draft.testimonials.items.push({ clientId, quote: "", name: "", detail: "" });
        draft.testimonials.enabled = true;
    }, { intent: { type: "insert-collection-item", collection: "testimonials", clientId }, history: { label: "Kundenstimme hinzugefügt" } });
    const toggle = document.querySelector('[data-bind="testimonials.enabled"]');
    if (toggle)
        toggle.checked = true;
    renderTestimonials(context);
}
function removeTestimonial(context, clientId) {
    // Without an id there is nothing to remove — and the mutator would still flip the section toggle,
    // which is a removal the intent cannot back up.
    if (!clientId)
        return;
    safeMutate(context.store, (draft) => {
        draft.testimonials.items = draft.testimonials.items.filter((item) => item.clientId !== clientId);
        if (!draft.testimonials.items.length)
            draft.testimonials.enabled = false;
    }, { intent: { type: "remove-collection-item", collection: "testimonials", clientId }, history: { label: "Kundenstimme entfernt" } });
    const toggle = document.querySelector('[data-bind="testimonials.enabled"]');
    if (toggle)
        toggle.checked = context.store.snapshot.testimonials.enabled;
    renderTestimonials(context);
}
function applyPreset(context, name) {
    const preset = PRESETS[name];
    if (!preset)
        return;
    safeMutate(context.store, (draft) => { draft.theme.preset = name; draft.theme.primary = preset.primary; draft.theme.accent = preset.accent; }, { intent: { type: "set-theme" }, history: { label: "Farbwelt geändert" } });
    syncPresetInputs(context, name);
}
function exportHtml(context) {
    const html = buildWebsiteHtml(context.store.snapshot);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slugify(context.store.snapshot.salon.name || "salon")}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast("Die Website wurde als einzelne HTML-Datei exportiert. Die spätere SaaS-Buchung ist darin bewusst noch nicht aktiviert.");
}
async function copySalonData(context) {
    try {
        await navigator.clipboard.writeText(JSON.stringify(context.store.snapshot, null, 2));
        showToast("Der versionierte Builder-Entwurf wurde kopiert.");
    }
    catch {
        showToast("Kopieren wurde vom Browser blockiert.");
    }
}
async function resetBuilder(context) {
    if (!window.confirm("Alle lokalen Änderungen und bereits gespeicherten Bilddateien zurücksetzen?"))
        return;
    try {
        const fresh = await replaceWithFreshDraft(context.repository, context.store.snapshot);
        context.store.replace(fresh, false, "reset");
        bindStaticInputs(context);
        renderDynamicControls(context);
        renderPreview(context);
        updateReadiness(context);
        showPanel(context, "salon");
        showToast("Der lokale Entwurf wurde vollständig zurückgesetzt.");
    }
    catch (error) {
        console.error(error);
        showToast("Der Entwurf konnte nicht vollständig zurückgesetzt werden.");
    }
}
