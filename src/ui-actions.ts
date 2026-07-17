import {
  MAX_TESTIMONIALS,
  PRESETS,
  createClientId,
  slugify,
  uniqueSlug,
  type BuilderDraftV2,
  type BuilderService,
  type DayOfWeek,
  type ThemePresetName,
} from "./domain.js";
import { replaceWithFreshDraft } from "./persistence.js";
import { buildWebsiteHtml } from "./website.js";
import { inputValue, setAtPath, type UiContext } from "./ui-shared.js";
import {
  bindStaticInputs,
  renderDynamicControls,
  renderHours,
  renderPresets,
  renderPreview,
  renderServices,
  renderTestimonials,
  setViewport,
  showPanel,
  showToast,
  syncPresetInputs,
  updateReadiness,
} from "./ui-render.js";

export function handleClick(context: UiContext, event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const panelButton = target.closest<HTMLElement>("[data-panel-target]");
  if (panelButton) { showPanel(context, panelButton.dataset.panelTarget ?? "salon"); return; }
  const viewportButton = target.closest<HTMLElement>("[data-viewport]");
  if (viewportButton) { setViewport(context, viewportButton.dataset.viewport ?? "desktop"); return; }
  const presetButton = target.closest<HTMLElement>("[data-preset]");
  if (presetButton) { applyPreset(context, presetButton.dataset.preset as ThemePresetName); return; }
  const actionButton = target.closest<HTMLElement>("[data-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === "add-service") addService(context);
  if (action === "remove-service") removeService(context, actionButton.closest<HTMLElement>("[data-service-card]")?.dataset.serviceId ?? "");
  if (action === "add-testimonial") addTestimonial(context);
  if (action === "remove-testimonial") removeTestimonial(context, actionButton.closest<HTMLElement>("[data-testimonial-card]")?.dataset.testimonialId ?? "");
  if (action === "export") exportHtml(context);
  if (action === "copy-json") void copySalonData(context);
  if (action === "reset") void resetBuilder(context);
}

export function handleInput(context: UiContext, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
  const bind = target.dataset.bind;
  if (bind) {
    try { context.store.mutate((draft) => setAtPath(draft, bind, inputValue(target))); }
    catch (error) { console.error(error); }
    return;
  }
  const serviceField = target.dataset.serviceField as keyof BuilderService | undefined;
  const serviceCard = target.closest<HTMLElement>("[data-service-card]");
  if (serviceField && serviceCard?.dataset.serviceId) {
    context.store.mutate((draft) => {
      const service = draft.services.find((item) => item.clientId === serviceCard.dataset.serviceId);
      if (!service) return;
      if (serviceField === "durationMinutes" || serviceField === "price") service[serviceField] = Number(target.value || 0);
      else if (serviceField === "bookable") service.bookable = target instanceof HTMLInputElement ? target.checked : true;
      else if (serviceField === "name") { service.name = target.value; service.slug = uniqueSlug(target.value, draft.services, service.clientId); }
      else if (serviceField !== "clientId") (service[serviceField] as string) = target.value;
    });
    if (serviceField === "name") {
      const number = serviceCard.querySelector<HTMLElement>("[data-service-number]");
      if (number) {
        const index = context.store.snapshot.services.findIndex((service) => service.clientId === serviceCard.dataset.serviceId);
        number.textContent = `${index + 1}. ${target.value || "Leistung"}`;
      }
    }
    return;
  }
  const testimonialField = target.dataset.testimonialField as "quote" | "name" | "detail" | undefined;
  const testimonialCard = target.closest<HTMLElement>("[data-testimonial-card]");
  if (testimonialField && testimonialCard?.dataset.testimonialId) {
    context.store.mutate((draft) => {
      const item = draft.testimonials.items.find((voice) => voice.clientId === testimonialCard.dataset.testimonialId);
      if (item) item[testimonialField] = target.value;
    });
    return;
  }
  const hourField = target.dataset.hourField as "from" | "to" | "closed" | undefined;
  const hourRow = target.closest<HTMLElement>("[data-day-of-week]");
  if (hourField && hourRow) {
    const dayOfWeek = Number(hourRow.dataset.dayOfWeek) as DayOfWeek;
    context.store.mutate((draft) => {
      const day = draft.businessHours.find((item) => item.dayOfWeek === dayOfWeek);
      if (!day) return;
      if (hourField === "closed") {
        day.closed = target instanceof HTMLInputElement ? target.checked : false;
        day.ranges = day.closed ? [] : day.ranges.length ? day.ranges : [{ from: "09:00", to: "18:00" }];
      } else {
        const range = day.ranges[0] ?? { from: "09:00", to: "18:00" };
        range[hourField] = target.value;
        day.ranges = [range, ...day.ranges.slice(1)];
        day.closed = false;
      }
    });
    if (hourField === "closed") renderHours(context);
    else hourRow.classList.remove("is-closed");
  }
}

function addService(context: UiContext): void {
  context.store.mutate((draft) => {
    const clientId = createClientId("service");
    draft.services.push({ clientId, slug: uniqueSlug("Neue Leistung", draft.services), category: "Schnitt", name: "Neue Leistung", description: "", durationMinutes: 30, price: 0, priceType: "fixed", bookable: true });
  });
  renderServices(context);
}

function removeService(context: UiContext, clientId: string): void {
  if (!clientId) return;
  context.store.mutate((draft) => {
    draft.services = draft.services.filter((service) => service.clientId !== clientId);
    draft.staff.forEach((person) => { person.serviceClientIds = person.serviceClientIds.filter((id) => id !== clientId); });
  });
  renderServices(context);
}

function addTestimonial(context: UiContext): void {
  if (context.store.snapshot.testimonials.items.length >= MAX_TESTIMONIALS) {
    showToast("In der Gratisversion sind maximal drei manuelle Kundenstimmen vorgesehen.");
    return;
  }
  context.store.mutate((draft) => {
    draft.testimonials.items.push({ clientId: createClientId("voice"), quote: "", name: "", detail: "" });
    draft.testimonials.enabled = true;
  });
  const toggle = document.querySelector<HTMLInputElement>('[data-bind="testimonials.enabled"]');
  if (toggle) toggle.checked = true;
  renderTestimonials(context);
}

function removeTestimonial(context: UiContext, clientId: string): void {
  context.store.mutate((draft) => {
    draft.testimonials.items = draft.testimonials.items.filter((item) => item.clientId !== clientId);
    if (!draft.testimonials.items.length) draft.testimonials.enabled = false;
  });
  const toggle = document.querySelector<HTMLInputElement>('[data-bind="testimonials.enabled"]');
  if (toggle) toggle.checked = context.store.snapshot.testimonials.enabled;
  renderTestimonials(context);
}

function applyPreset(context: UiContext, name: ThemePresetName): void {
  const preset = PRESETS[name];
  if (!preset) return;
  context.store.mutate((draft) => { draft.theme.preset = name; draft.theme.primary = preset.primary; draft.theme.accent = preset.accent; });
  syncPresetInputs(context, name);
}

function exportHtml(context: UiContext): void {
  const html = buildWebsiteHtml(context.store.snapshot as BuilderDraftV2);
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

async function copySalonData(context: UiContext): Promise<void> {
  try { await navigator.clipboard.writeText(JSON.stringify(context.store.snapshot, null, 2)); showToast("Der versionierte Builder-Entwurf wurde kopiert."); }
  catch { showToast("Kopieren wurde vom Browser blockiert."); }
}

async function resetBuilder(context: UiContext): Promise<void> {
  if (!window.confirm("Alle lokalen Änderungen und bereits gespeicherten Bilddateien zurücksetzen?")) return;
  try {
    const fresh = await replaceWithFreshDraft(context.repository, context.store.snapshot as BuilderDraftV2);
    context.store.replace(fresh, false);
    bindStaticInputs(context);
    renderDynamicControls(context);
    renderPreview(context);
    updateReadiness(context);
    showPanel(context, "salon");
    showToast("Der lokale Entwurf wurde vollständig zurückgesetzt.");
  } catch (error) {
    console.error(error);
    showToast("Der Entwurf konnte nicht vollständig zurückgesetzt werden.");
  }
}
