"use strict";

function buildWebsiteHtml(data, options = {}) {
  const preset = PRESETS[data.theme.preset] || PRESETS.elegant;
  const theme = { ...preset, primary: safeColor(data.theme.primary, preset.primary), accent: safeColor(data.theme.accent, preset.accent) };
  const groupedServices = groupBy(data.services.filter((service) => service.name.trim()), (service) => service.category.trim() || "Leistungen");
  const bookingUrl = normalizeExternalUrl(data.salon.bookingUrl);
  const address = [data.salon.address, [data.salon.postalCode, data.salon.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const contactLinks = [
    data.salon.phone ? `<a href="tel:${escapeAttr(data.salon.phone.replace(/\s+/g, ""))}">${escapeHtml(data.salon.phone)}</a>` : "",
    data.salon.email ? `<a href="mailto:${escapeAttr(data.salon.email)}">${escapeHtml(data.salon.email)}</a>` : "",
    isSafeHttpUrl(data.salon.instagram) ? `<a href="${escapeAttr(data.salon.instagram)}" target="_blank" rel="noopener">Instagram</a>` : "",
  ].filter(Boolean).join("");

  const serviceHtml = Object.entries(groupedServices).map(([category, services]) => `
    <section class="price-group">
      <h3>${escapeHtml(category)}</h3>
      <div class="price-list">
        ${services.map((service) => {
          const serviceBookingUrl = service.bookable && bookingUrl ? withQuery(bookingUrl, "service", service.id) : "";
          return `<article class="price-row">
            <div>
              <h4>${escapeHtml(service.name)}</h4>
              ${service.description ? `<p>${escapeHtml(service.description)}</p>` : ""}
              <span>${escapeHtml(formatDuration(service.durationMinutes))}</span>
            </div>
            <div class="price-row__action">
              <strong>${escapeHtml(formatPrice(service))}</strong>
              ${serviceBookingUrl ? `<a class="text-link" href="${escapeAttr(serviceBookingUrl)}" target="_blank" rel="noopener">Buchen</a>` : ""}
            </div>
          </article>`;
        }).join("")}
      </div>
    </section>`).join("");

  const hoursHtml = data.hours.map((hour) => `<li><span>${escapeHtml(hour.day)}</span><strong>${hour.closed ? "Geschlossen" : `${escapeHtml(hour.open)}–${escapeHtml(hour.close)}`}</strong></li>`).join("");

  const validVoices = data.testimonials.enabled
    ? data.testimonials.items.filter((item) => item.quote.trim() && item.name.trim()).slice(0, MAX_TESTIMONIALS)
    : [];
  const testimonialsHtml = validVoices.length ? `<section class="section voices" id="stimmen">
    <div class="container">
      <p class="section-label">Kundenstimmen</p>
      <h2>Persönlich weiterempfohlen</h2>
      <div class="voice-grid">
        ${validVoices.map((item) => `<figure><blockquote>“${escapeHtml(item.quote)}”</blockquote><figcaption>${escapeHtml(item.name)}${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ""}</figcaption></figure>`).join("")}
      </div>
    </div>
  </section>` : "";

  const heroStyle = isSafeHttpUrl(data.salon.heroImage)
    ? `style="--hero-image:url('${escapeCssUrl(data.salon.heroImage)}')"`
    : "";
  const primaryBookingButton = bookingUrl
    ? `<a class="button primary" href="${escapeAttr(bookingUrl)}" target="_blank" rel="noopener">Termin buchen</a>`
    : `<a class="button primary" href="#leistungen">Leistungen ansehen</a>`;

  const schema = {
    "@context": "https://schema.org",
    "@type": "HairSalon",
    name: data.salon.name,
    description: data.copy.heroSubtitle,
    telephone: data.salon.phone || undefined,
    email: data.salon.email || undefined,
    url: options.preview ? undefined : undefined,
    address: address ? { "@type": "PostalAddress", streetAddress: data.salon.address || undefined, postalCode: data.salon.postalCode || undefined, addressLocality: data.salon.city || undefined, addressCountry: "CH" } : undefined,
    openingHoursSpecification: data.hours.filter((hour) => !hour.closed).map((hour) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: `https://schema.org/${englishDay(hour.day)}`, opens: hour.open, closes: hour.close })),
    makesOffer: data.services.filter((service) => service.name.trim()).map((service) => ({ "@type": "Offer", name: service.name, priceCurrency: "CHF", price: service.priceType === "on-request" ? undefined : service.price, description: service.description || undefined, url: service.bookable && bookingUrl ? withQuery(bookingUrl, "service", service.id) : undefined })),
  };

  return `<!doctype html>
<html lang="de-CH">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(data.salon.name)}${data.salon.city ? ` – Coiffeur in ${escapeHtml(data.salon.city)}` : ""}</title>
  <meta name="description" content="${escapeAttr(data.copy.heroSubtitle)}">
  <meta name="theme-color" content="${escapeAttr(theme.primary)}">
  <script type="application/ld+json">${safeJson(schema)}</script>
  <style>${websiteCss(theme)}</style>
</head>
<body>
  <a class="skip-link" href="#main">Zum Inhalt springen</a>
  <header class="site-header">
    <a class="logo" href="#top">${escapeHtml(data.salon.name)}</a>
    <nav aria-label="Hauptnavigation">
      <a href="#leistungen">Leistungen</a>
      <a href="#zeiten">Öffnungszeiten</a>
      ${validVoices.length ? '<a href="#stimmen">Stimmen</a>' : ""}
    </nav>
    ${bookingUrl ? `<a class="header-booking" href="${escapeAttr(bookingUrl)}" target="_blank" rel="noopener">Buchen</a>` : ""}
  </header>

  <main id="main">
    <section id="top" class="hero${isSafeHttpUrl(data.salon.heroImage) ? " has-image" : ""}" ${heroStyle}>
      <div class="hero__veil"></div>
      <div class="container hero__inner">
        <p class="section-label">${escapeHtml(data.copy.heroLabel)}</p>
        <h1>${escapeHtml(data.copy.heroTitle)}</h1>
        <p class="hero__text">${escapeHtml(data.copy.heroSubtitle)}</p>
        <div class="hero__actions">
          ${primaryBookingButton}
          ${data.salon.phone ? `<a class="button secondary" href="tel:${escapeAttr(data.salon.phone.replace(/\s+/g, ""))}">Anrufen</a>` : ""}
        </div>
      </div>
    </section>

    <section class="intro-strip">
      <div class="container intro-strip__inner">
        <strong>${escapeHtml(data.salon.tagline || data.salon.name)}</strong>
        <span>${escapeHtml(address)}</span>
      </div>
    </section>

    <section class="section services" id="leistungen">
      <div class="container">
        <p class="section-label">Salonangebot</p>
        <h2>${escapeHtml(data.copy.servicesTitle)}</h2>
        <p class="section-intro">${escapeHtml(data.copy.servicesSubtitle)}</p>
        <div class="service-groups">${serviceHtml || '<p class="empty">Leistungen folgen in Kürze.</p>'}</div>
      </div>
    </section>

    ${testimonialsHtml}

    <section class="section details" id="zeiten">
      <div class="container details__grid">
        <div>
          <p class="section-label">Besuch planen</p>
          <h2>Öffnungszeiten</h2>
          <ul class="hours">${hoursHtml}</ul>
        </div>
        <div class="contact-card">
          <p class="section-label">Kontakt</p>
          <h2>${escapeHtml(data.salon.name)}</h2>
          ${address ? `<p>${escapeHtml(address)}</p>` : ""}
          <div class="contact-links">${contactLinks}</div>
        </div>
      </div>
    </section>

    <section class="booking">
      <div class="container booking__inner">
        <div>
          <p class="section-label">Online buchen</p>
          <h2>${escapeHtml(data.copy.bookingTitle)}</h2>
          <p>${escapeHtml(data.copy.bookingSubtitle)}</p>
        </div>
        ${primaryBookingButton}
      </div>
    </section>
  </main>

  <footer>
    <div class="container footer__inner">
      <div><strong>${escapeHtml(data.salon.name)}</strong><span>${escapeHtml(data.salon.tagline)}</span></div>
      <p>© ${new Date().getFullYear()} ${escapeHtml(data.salon.name)}</p>
    </div>
  </footer>
</body>
</html>`;
}

function websiteCss(theme) {
  return `
:root{--primary:${theme.primary};--accent:${theme.accent};--bg:${theme.bg};--surface:${theme.surface};--text:${theme.text};--display:${theme.display};--body:${theme.body};--radius:${theme.radius};--max:1120px}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--body);line-height:1.55}a{color:inherit}img{max-width:100%;display:block}.container{width:min(var(--max),calc(100% - 40px));margin:0 auto}.skip-link{position:fixed;left:16px;top:-80px;z-index:1000;padding:10px 14px;background:#111;color:#fff;border-radius:8px}.skip-link:focus{top:16px}.site-header{position:sticky;top:0;z-index:20;min-height:70px;display:flex;align-items:center;gap:28px;padding:12px max(20px,calc((100vw - var(--max))/2));border-bottom:1px solid color-mix(in srgb,var(--text) 14%,transparent);background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(18px)}.logo{margin-right:auto;font-family:var(--display);font-size:20px;font-weight:800;text-decoration:none}.site-header nav{display:flex;gap:20px}.site-header nav a{text-decoration:none;font-size:14px;font-weight:700}.header-booking,.button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:10px 18px;border-radius:var(--radius);font-weight:800;text-decoration:none}.header-booking,.button.primary{background:var(--primary);color:white}.button.secondary{border:1px solid currentColor}.hero{position:relative;min-height:680px;display:grid;align-items:center;overflow:hidden;background:linear-gradient(135deg,var(--surface),var(--bg))}.hero.has-image{background-image:linear-gradient(90deg,color-mix(in srgb,var(--bg) 96%,transparent) 0%,color-mix(in srgb,var(--bg) 78%,transparent) 52%,color-mix(in srgb,var(--bg) 12%,transparent) 100%),var(--hero-image);background-size:cover;background-position:center}.hero__veil{position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 15% 20%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 38%)}.hero__inner{position:relative;padding:100px 0;max-width:760px;margin-left:max(20px,calc((100vw - var(--max))/2));width:min(760px,calc(100% - 40px))}.section-label{margin:0 0 14px;color:var(--primary);font-size:12px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}.hero h1,.section h2,.booking h2{font-family:var(--display);font-size:clamp(42px,7vw,86px);line-height:1.02;letter-spacing:-.05em;margin:0}.hero__text{max-width:680px;margin:24px 0 0;font-size:clamp(18px,2.2vw,24px)}.hero__actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:32px}.intro-strip{border-top:1px solid color-mix(in srgb,var(--text) 12%,transparent);border-bottom:1px solid color-mix(in srgb,var(--text) 12%,transparent)}.intro-strip__inner{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:20px}.intro-strip span{color:color-mix(in srgb,var(--text) 65%,transparent)}.section{padding:110px 0}.section h2,.booking h2{font-size:clamp(36px,5vw,64px)}.section-intro{max-width:680px;margin:18px 0 50px;font-size:18px;color:color-mix(in srgb,var(--text) 72%,transparent)}.service-groups{display:grid;gap:42px}.price-group h3{margin:0 0 12px;font-family:var(--display);font-size:24px}.price-list{border-top:1px solid color-mix(in srgb,var(--text) 18%,transparent)}.price-row{display:grid;grid-template-columns:1fr auto;gap:24px;padding:22px 0;border-bottom:1px solid color-mix(in srgb,var(--text) 14%,transparent)}.price-row h4{margin:0;font-size:19px}.price-row p{margin:6px 0 0;color:color-mix(in srgb,var(--text) 70%,transparent)}.price-row span{display:inline-block;margin-top:8px;font-size:13px;color:color-mix(in srgb,var(--text) 58%,transparent)}.price-row__action{display:flex;align-items:center;gap:16px;white-space:nowrap}.price-row__action strong{font-size:17px}.text-link{color:var(--primary);font-weight:800}.voices{background:var(--surface)}.voice-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:42px}.voice-grid figure{margin:0;padding:28px;border-radius:var(--radius);background:var(--bg)}.voice-grid blockquote{margin:0;font-family:var(--display);font-size:21px;line-height:1.45}.voice-grid figcaption{margin-top:24px;font-weight:800}.voice-grid figcaption span{display:block;margin-top:3px;color:color-mix(in srgb,var(--text) 60%,transparent);font-size:13px;font-weight:500}.details{background:var(--surface)}.details__grid{display:grid;grid-template-columns:1.2fr .8fr;gap:70px}.hours{list-style:none;margin:36px 0 0;padding:0}.hours li{display:flex;justify-content:space-between;gap:16px;padding:13px 0;border-bottom:1px solid color-mix(in srgb,var(--text) 13%,transparent)}.contact-card{align-self:start;padding:34px;border-radius:var(--radius);background:var(--bg)}.contact-card p{white-space:pre-line}.contact-links{display:grid;gap:8px;margin-top:24px}.contact-links a{font-weight:800}.booking{padding:90px 0;background:var(--primary);color:#fff}.booking__inner{display:flex;align-items:center;justify-content:space-between;gap:40px}.booking .section-label{color:color-mix(in srgb,#fff 72%,var(--accent))}.booking p{max-width:620px;margin:18px 0 0;font-size:18px}.booking .button.primary{background:#fff;color:var(--primary);white-space:nowrap}footer{padding:36px 0;background:color-mix(in srgb,var(--text) 92%,#000);color:#fff}.footer__inner{display:flex;align-items:center;justify-content:space-between;gap:24px}.footer__inner strong,.footer__inner span{display:block}.footer__inner span,.footer__inner p{font-size:13px;color:rgba(255,255,255,.68)}.empty{color:color-mix(in srgb,var(--text) 60%,transparent)}
@media(max-width:760px){.site-header nav{display:none}.header-booking{display:none}.hero{min-height:590px}.hero.has-image{background-image:linear-gradient(180deg,color-mix(in srgb,var(--bg) 82%,transparent),color-mix(in srgb,var(--bg) 95%,transparent)),var(--hero-image)}.hero__inner{padding:80px 0;margin:0 auto}.intro-strip__inner,.booking__inner,.footer__inner{align-items:flex-start;flex-direction:column}.section{padding:76px 0}.price-row{grid-template-columns:1fr}.price-row__action{justify-content:space-between}.voice-grid{grid-template-columns:1fr}.details__grid{grid-template-columns:1fr;gap:46px}.booking .button.primary{width:100%}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;
}

