function renderServices() {
  elements.serviceList.innerHTML = "";
  if (!state.services.length) {
    elements.serviceList.innerHTML = '<div class="empty-state">Noch keine Leistungen. Füge die erste Leistung hinzu.</div>';
    return;
  }

  state.services.forEach((service, index) => {
    const fragment = elements.serviceTemplate.content.cloneNode(true);
    const card = fragment.querySelector("[data-service-card]");
    card.dataset.serviceId = service.id;
    fragment.querySelector("[data-service-number]").textContent = `${index + 1}. ${service.name || "Leistung"}`;
    fragment.querySelectorAll("[data-service-field]").forEach((input) => {
      const field = input.dataset.serviceField;
      if (input.type === "checkbox") input.checked = Boolean(service[field]);
      else input.value = service[field] ?? "";
    });
    elements.serviceList.appendChild(fragment);
  });
}

function addService() {
  const service = normalizeService({ name: "Neue Leistung", category: "Schnitt", durationMinutes: 30, price: 0, priceType: "fixed", bookable: true }, state.services.length);
  state.services.push(service);
  renderServices();
  scheduleStateUpdate();
}

function removeService(id) {
  if (!id) return;
  state.services = state.services.filter((service) => service.id !== id);
  renderServices();
  scheduleStateUpdate();
}

function renderHours() {
  elements.hoursList.innerHTML = "";
  state.hours.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `hours-row${item.closed ? " is-closed" : ""}`;
    row.dataset.hourIndex = String(index);
    row.innerHTML = `
      <strong>${escapeHtml(item.day)}</strong>
      <input type="time" value="${escapeAttr(item.open)}" data-hour-field="open" aria-label="${escapeAttr(item.day)} öffnet">
      <input type="time" value="${escapeAttr(item.close)}" data-hour-field="close" aria-label="${escapeAttr(item.day)} schliesst">
      <label><input type="checkbox" data-hour-field="closed" ${item.closed ? "checked" : ""}> Geschlossen</label>
    `;
    elements.hoursList.appendChild(row);
  });
}

function renderTestimonials() {
  elements.testimonialList.innerHTML = "";
  if (!state.testimonials.items.length) {
    elements.testimonialList.innerHTML = '<div class="empty-state">Keine Kundenstimmen eingetragen. Dieser Bereich bleibt auf der Website verborgen.</div>';
    return;
  }

  state.testimonials.items.forEach((item, index) => {
    const fragment = elements.testimonialTemplate.content.cloneNode(true);
    const card = fragment.querySelector("[data-testimonial-card]");
    card.dataset.testimonialId = item.id;
    fragment.querySelector("[data-testimonial-number]").textContent = `${index + 1}. Kundenstimme`;
    fragment.querySelectorAll("[data-testimonial-field]").forEach((input) => {
      input.value = item[input.dataset.testimonialField] || "";
    });
    elements.testimonialList.appendChild(fragment);
  });
}

function addTestimonial() {
  if (state.testimonials.items.length >= MAX_TESTIMONIALS) {
    showToast("In der Gratisversion sind maximal drei manuelle Kundenstimmen vorgesehen.");
    return;
  }
  state.testimonials.items.push({ id: `voice-${Date.now()}`, quote: "", name: "", detail: "" });
  state.testimonials.enabled = true;
  const toggle = document.querySelector('[data-bind="testimonials.enabled"]');
  if (toggle) toggle.checked = true;
  renderTestimonials();
  scheduleStateUpdate();
}

function removeTestimonial(id) {
  state.testimonials.items = state.testimonials.items.filter((item) => item.id !== id);
  if (!state.testimonials.items.length) state.testimonials.enabled = false;
  const toggle = document.querySelector('[data-bind="testimonials.enabled"]');
  if (toggle) toggle.checked = state.testimonials.enabled;
  renderTestimonials();
  scheduleStateUpdate();
}

