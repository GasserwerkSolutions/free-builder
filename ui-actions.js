function renderPresets() {
  document.querySelectorAll("[data-preset]").forEach((button) => {
    const active = button.dataset.preset === state.theme.preset;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  state.theme.preset = name;
  state.theme.primary = preset.primary;
  state.theme.accent = preset.accent;
  const primaryInput = document.querySelector('[data-bind="theme.primary"]');
  const accentInput = document.querySelector('[data-bind="theme.accent"]');
  if (primaryInput) primaryInput.value = state.theme.primary;
  if (accentInput) accentInput.value = state.theme.accent;
  renderPresets();
  scheduleStateUpdate();
}

function setViewport(viewport) {
  const labels = { desktop: "Desktop", tablet: "Tablet", mobile: "Mobile" };
  elements.previewFrame.dataset.viewport = viewport;
  elements.previewHint.textContent = labels[viewport] || "Desktop";
  document.querySelectorAll("[data-viewport]").forEach((button) => button.classList.toggle("is-active", button.dataset.viewport === viewport));
}

function renderPreview() {
  elements.previewFrame.srcdoc = buildWebsiteHtml(state, { preview: true });
}

function updateReadiness() {
  const checks = [
    { label: "Salonname eingetragen", ready: Boolean(state.salon.name.trim()) },
    { label: "Kontaktmöglichkeit vorhanden", ready: Boolean(state.salon.phone.trim() || state.salon.email.trim()) },
    { label: "Mindestens eine Leistung mit Preis", ready: state.services.some((service) => service.name.trim() && (service.price > 0 || service.priceType === "on-request")) },
    { label: "Buchungslink verbunden", ready: isSafeHttpUrl(state.salon.bookingUrl) },
    { label: "Öffnungszeiten geprüft", ready: state.hours.some((hour) => !hour.closed) },
  ];
  elements.readinessList.innerHTML = checks.map((check) => `<div class="readiness-item${check.ready ? " is-ready" : ""}">${escapeHtml(check.label)}</div>`).join("");
}


function exportHtml() {
  const html = buildWebsiteHtml(state);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(state.salon.name || "salon")}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast("Die Website wurde als einzelne HTML-Datei exportiert.");
}

async function copySalonData() {
  const payload = {
    salon: state.salon,
    services: state.services,
    hours: state.hours,
    testimonials: state.testimonials,
    theme: state.theme,
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    showToast("Salon-Daten wurden kopiert.");
  } catch (error) {
    showToast("Kopieren wurde vom Browser blockiert.");
  }
}

function resetBuilder() {
  if (!window.confirm("Alle lokalen Änderungen zurücksetzen?")) return;
  state = cloneDefaultState();
  localStorage.removeItem(STORAGE_KEY);
  bindStaticInputs();
  renderAllControls();
  renderPreview();
  updateReadiness();
  showPanel("salon");
  showToast("Der Builder wurde zurückgesetzt.");
}

function showToast(message) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}


init();
