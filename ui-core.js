"use strict";

const elements = {
  surfaceCard: document.getElementById("surfaceCard"),
  previewFrame: document.getElementById("previewFrame"),
  previewHint: document.getElementById("previewHint"),
  saveStatus: document.getElementById("saveStatus"),
  serviceList: document.getElementById("serviceList"),
  testimonialList: document.getElementById("testimonialList"),
  hoursList: document.getElementById("hoursList"),
  readinessList: document.getElementById("readinessList"),
  serviceTemplate: document.getElementById("serviceTemplate"),
  testimonialTemplate: document.getElementById("testimonialTemplate"),
};


function init() {
  bindStaticInputs();
  renderAllControls();
  renderPreview();
  updateReadiness();

  document.addEventListener("click", handleClick);
  document.addEventListener("input", handleInput);
  document.addEventListener("change", handleInput);
}


function bindStaticInputs() {
  document.querySelectorAll("[data-bind]").forEach((input) => {
    const value = getPath(state, input.dataset.bind);
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value ?? "";
  });
}

function renderAllControls() {
  renderServices();
  renderHours();
  renderTestimonials();
  renderPresets();
}

function handleClick(event) {
  const panelButton = event.target.closest("[data-panel-target]");
  if (panelButton) {
    showPanel(panelButton.dataset.panelTarget);
    return;
  }

  const viewportButton = event.target.closest("[data-viewport]");
  if (viewportButton) {
    setViewport(viewportButton.dataset.viewport);
    return;
  }

  const presetButton = event.target.closest("[data-preset]");
  if (presetButton) {
    applyPreset(presetButton.dataset.preset);
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.action;

  if (action === "add-service") addService();
  if (action === "remove-service") removeService(actionButton.closest("[data-service-card]")?.dataset.serviceId);
  if (action === "add-testimonial") addTestimonial();
  if (action === "remove-testimonial") removeTestimonial(actionButton.closest("[data-testimonial-card]")?.dataset.testimonialId);
  if (action === "export") exportHtml();
  if (action === "copy-json") copySalonData();
  if (action === "reset") resetBuilder();
}

function handleInput(event) {
  const bind = event.target.dataset.bind;
  if (bind) {
    setPath(state, bind, event.target.type === "checkbox" ? event.target.checked : event.target.value);
    scheduleStateUpdate();
    return;
  }

  const serviceField = event.target.dataset.serviceField;
  const serviceCard = event.target.closest("[data-service-card]");
  if (serviceField && serviceCard) {
    const service = state.services.find((item) => item.id === serviceCard.dataset.serviceId);
    if (!service) return;
    service[serviceField] = coerceFieldValue(event.target, serviceField);
    scheduleStateUpdate();
    return;
  }

  const testimonialField = event.target.dataset.testimonialField;
  const testimonialCard = event.target.closest("[data-testimonial-card]");
  if (testimonialField && testimonialCard) {
    const item = state.testimonials.items.find((voice) => voice.id === testimonialCard.dataset.testimonialId);
    if (!item) return;
    item[testimonialField] = event.target.value;
    scheduleStateUpdate();
    return;
  }

  const hourField = event.target.dataset.hourField;
  const hourRow = event.target.closest("[data-hour-index]");
  if (hourField && hourRow) {
    const index = Number(hourRow.dataset.hourIndex);
    if (!state.hours[index]) return;
    state.hours[index][hourField] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    hourRow.classList.toggle("is-closed", state.hours[index].closed);
    scheduleStateUpdate();
  }
}

function coerceFieldValue(input, field) {
  if (input.type === "checkbox") return input.checked;
  if (["durationMinutes", "price"].includes(field)) return Number(input.value || 0);
  return input.value;
}

function scheduleStateUpdate() {
  elements.saveStatus.textContent = "Speichert …";
  elements.saveStatus.className = "status-pill is-saving";
  clearTimeout(saveTimer);
  clearTimeout(previewTimer);
  saveTimer = setTimeout(saveState, 250);
  previewTimer = setTimeout(() => {
    renderPreview();
    updateReadiness();
  }, 100);
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    elements.saveStatus.textContent = "Lokal gespeichert";
    elements.saveStatus.className = "status-pill is-saved";
  } catch (error) {
    elements.saveStatus.textContent = "Speichern fehlgeschlagen";
    elements.saveStatus.className = "status-pill";
    console.error(error);
  }
}

function showPanel(panelName) {
  document.querySelectorAll("[data-panel-target]").forEach((button) => button.classList.toggle("is-active", button.dataset.panelTarget === panelName));
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    const active = panel.dataset.panel === panelName;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  elements.surfaceCard.classList.remove("is-turning");
  void elements.surfaceCard.offsetWidth;
  elements.surfaceCard.classList.add("is-turning");
  if (panelName === "publish") updateReadiness();
}

