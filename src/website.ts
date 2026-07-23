import {
  MAX_TESTIMONIALS,
  PRESETS,
  dayName,
  englishDay,
  escapeAttr,
  escapeHtml,
  formatDuration,
  formatPrice,
  isSafeHttpUrl,
  safeJson,
  type BuilderDraftV2,
} from "./domain.js";
import { buildPreviewBridgeScript } from "./preview-bridge.js";
import {
  PREVIEW_CHANNEL,
  PREVIEW_PROTOCOL_VERSION,
  type EditorPanel,
  type PreviewRegion,
  type PreviewScrollState,
  type PreviewTarget,
} from "./preview-contract.js";

/**
 * One renderer, two consumers.
 *
 * The preview and the exported file come out of this same function. That is the whole reason the two
 * can never drift apart — and it only holds as long as every single preview affordance sits behind
 * `options.preview`. Without that flag the output is the exported page, byte for byte, and a test
 * (tests/export-contract.test.mjs) holds that line against a recorded baseline.
 */
export type BuildOptions = {
  preview?: boolean;
  previewInstanceId?: string;
  parentOrigin?: string;
  previewScroll?: PreviewScrollState | null;
  previewRevision?: number;
  renderGeneration?: number;
};

function groupServices(draft: BuilderDraftV2): Map<string, BuilderDraftV2["services"]> {
  const groups = new Map<string, BuilderDraftV2["services"]>();
  draft.services.filter((service) => service.name.trim()).forEach((service) => {
    const category = service.category.trim() || "Leistungen";
    const values = groups.get(category) ?? [];
    values.push(service);
    groups.set(category, values);
  });
  return groups;
}

function scheduleText(draft: BuilderDraftV2, dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6): string {
  const day = draft.businessHours.find((item) => item.dayOfWeek === dayOfWeek);
  if (!day || day.closed) return "Geschlossen";
  return day.ranges.map((range) => `${range.from}–${range.to}`).join(" / ");
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase() || "–";
}

export function buildWebsiteHtml(draft: BuilderDraftV2, options: BuildOptions = {}): string {
  const preset = PRESETS[draft.theme.preset] ?? PRESETS.elegant;
  const theme = { ...preset, primary: draft.theme.primary, accent: draft.theme.accent };
  const address = [draft.salon.address, [draft.salon.postalCode, draft.salon.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const contactLinks = [
    draft.salon.phone ? `<a href="tel:${escapeAttr(draft.salon.phone.replace(/\s+/g, ""))}"${targetAttrs(options, { kind: "field", field: "salon.phone" }, "contact-phone", true)}>${escapeHtml(draft.salon.phone)}</a>` : "",
    draft.salon.email ? `<a href="mailto:${escapeAttr(draft.salon.email)}"${targetAttrs(options, { kind: "field", field: "salon.email" }, "contact-email", true)}>${escapeHtml(draft.salon.email)}</a>` : "",
    isSafeHttpUrl(draft.salon.instagram) ? `<a href="${escapeAttr(draft.salon.instagram)}" target="_blank" rel="noopener"${targetAttrs(options, { kind: "field", field: "salon.instagram" }, "contact-instagram", true)}>Instagram</a>` : "",
  ].filter(Boolean).join("");

  const servicesHtml = [...groupServices(draft).entries()].map(([category, services]) => `
    <section class="price-group">
      <h3>${services[0] ? editable(category, { kind: "service", serviceClientId: services[0].clientId, field: "category" }, `service-${services[0].clientId}-category`, options) : escapeHtml(category)}</h3>
      <div class="price-list">
        ${services.map((service) => `<article class="price-row">
          <div>
            <h4>${editable(service.name, { kind: "service", serviceClientId: service.clientId, field: "name" }, `service-${service.clientId}-name`, options)}</h4>
            ${service.description ? `<p>${editable(service.description, { kind: "service", serviceClientId: service.clientId, field: "description" }, `service-${service.clientId}-description`, options)}</p>` : ""}
            <span>${escapeHtml(formatDuration(service.durationMinutes))}</span>
          </div>
          <div class="price-row__action">
            <strong>${escapeHtml(formatPrice(service))}</strong>
            ${service.bookable ? '<span class="bookable-note">Online buchbar</span>' : ""}
          </div>
        </article>`).join("")}
      </div>
    </section>`).join("");

  const activeStaff = draft.staff.filter((person) => person.active && person.name.trim());
  const teamHtml = activeStaff.length ? `<section class="section team" id="team"${sectionAttrs(options, "team", "team")}${regionAttr(options, "team")}><div class="container"><p class="section-label">Persönlich für dich da</p><h2>Unser Team</h2><div class="team-grid">${activeStaff.map((person) => {
    const serviceNames = person.serviceClientIds.map((clientId) => draft.services.find((service) => service.clientId === clientId)).filter((service): service is BuilderDraftV2["services"][number] => Boolean(service?.name.trim())).map((service) => service.name);
    return `<article class="person-card"><div class="person-initial" aria-hidden="true">${escapeHtml(initials(person.name))}</div><div><h3>${editable(person.name, { kind: "staff", staffClientId: person.clientId, field: "name" }, `staff-${person.clientId}-name`, options)}</h3>${person.role ? `<p class="person-role">${editable(person.role, { kind: "staff", staffClientId: person.clientId, field: "role" }, `staff-${person.clientId}-role`, options)}</p>` : ""}${person.bio ? `<p>${editable(person.bio, { kind: "staff", staffClientId: person.clientId, field: "bio" }, `staff-${person.clientId}-bio`, options)}</p>` : ""}${serviceNames.length ? `<p class="person-services">${serviceNames.map(escapeHtml).join(" · ")}</p>` : ""}</div></article>`;
  }).join("")}</div></div></section>` : "";

  const testimonials = draft.testimonials.enabled
    ? draft.testimonials.items.filter((item) => item.quote.trim() && item.name.trim()).slice(0, MAX_TESTIMONIALS)
    : [];
  const testimonialsHtml = testimonials.length ? `<section class="section voices" id="stimmen"${sectionAttrs(options, "stimmen", "voices")}${regionAttr(options, "voices")}>
    <div class="container">
      <p class="section-label">Kundenstimmen</p>
      <h2>Persönlich weiterempfohlen</h2>
      <div class="voice-grid">${testimonials.map((item) => `<figure><blockquote>“${editable(item.quote, { kind: "testimonial", testimonialClientId: item.clientId, field: "quote" }, `voice-${item.clientId}-quote`, options)}”</blockquote><figcaption>${editable(item.name, { kind: "testimonial", testimonialClientId: item.clientId, field: "name" }, `voice-${item.clientId}-name`, options)}${item.detail ? `<span>${editable(item.detail, { kind: "testimonial", testimonialClientId: item.clientId, field: "detail" }, `voice-${item.clientId}-detail`, options)}</span>` : ""}</figcaption></figure>`).join("")}</div>
    </div>
  </section>` : "";

  const openingHours = draft.businessHours.map((day) => `<li><span>${escapeHtml(dayName(day.dayOfWeek))}</span><strong>${escapeHtml(scheduleText(draft, day.dayOfWeek))}</strong></li>`).join("");
  const openingHoursSpecification = draft.businessHours.flatMap((day) => day.closed ? [] : day.ranges.map((range) => ({
    "@type": "OpeningHoursSpecification",
    dayOfWeek: `https://schema.org/${englishDay(day.dayOfWeek)}`,
    opens: range.from,
    closes: range.to,
  })));
  const schema = {
    "@context": "https://schema.org",
    "@type": "HairSalon",
    name: draft.salon.name,
    description: draft.copy.heroSubtitle,
    telephone: draft.salon.phone || undefined,
    email: draft.salon.email || undefined,
    address: address ? { "@type": "PostalAddress", streetAddress: draft.salon.address || undefined, postalCode: draft.salon.postalCode || undefined, addressLocality: draft.salon.city || undefined, addressCountry: "CH" } : undefined,
    openingHoursSpecification,
    makesOffer: draft.services.filter((service) => service.name.trim()).map((service) => ({ "@type": "Offer", name: service.name, priceCurrency: "CHF", price: service.priceType === "on-request" ? undefined : service.price, description: service.description || undefined })),
    employee: activeStaff.map((person) => ({
      "@type": "Person",
      name: person.name,
      jobTitle: person.role || undefined,
      description: person.bio || undefined,
      knowsAbout: person.serviceClientIds.map((clientId) => draft.services.find((service) => service.clientId === clientId)?.name).filter(Boolean),
    })),
  };
  const legacyImageNotice = options.preview && draft.migration.legacyHeroImageUrl
    ? '<div class="migration-notice">Das frühere Titelbild wird aus Datenschutz- und Stabilitätsgründen nicht extern geladen. Im nächsten Bildschritt kannst du es neu hochladen.</div>'
    : "";

  // The head is rebuilt on every full render and on every export, but it is NOT patched: title, meta
  // description and the JSON-LD block sit outside every data-preview-region, so an incremental
  // preview update leaves them on the state of the last rebuild. Only `theme-color` is kept in sync,
  // because a theme patch touches it directly. Nothing in the preview shows the head, which is why
  // the drift is accepted rather than hidden — see the note in preview-update-planner.ts.
  return `<!doctype html>
<html lang="de-CH">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(draft.salon.name)}${draft.salon.city ? ` – Coiffeur in ${escapeHtml(draft.salon.city)}` : ""}</title>
  <meta name="description" content="${escapeAttr(draft.copy.heroSubtitle)}">
  <meta name="theme-color" content="${escapeAttr(theme.primary)}">
  <script type="application/ld+json">${safeJson(schema)}</script>
  <style>${websiteCss(theme)}${options.preview ? PREVIEW_CSS : ""}</style>
</head>
<body>
  <a class="skip-link" href="#main">Zum Inhalt springen</a>
  <header class="site-header"${panelAttr(options, "salon")}${regionAttr(options, "header")}>
    <a class="logo" href="#top">${editable(draft.salon.name, { kind: "field", field: "salon.name" }, "header-name", options)}</a>
    <nav aria-label="Hauptnavigation"><a href="#leistungen">Leistungen</a>${activeStaff.length ? '<a href="#team">Team</a>' : ""}<a href="#zeiten">Öffnungszeiten</a>${testimonials.length ? '<a href="#stimmen">Stimmen</a>' : ""}</nav>
    <a class="header-booking" href="#booking">Buchen</a>
  </header>
  <main id="main">
    <section id="top" class="hero"${sectionAttrs(options, "top", "copy")}${regionAttr(options, "hero")}>
      <div class="hero__veil"></div>
      <div class="container hero__inner">
        <p class="section-label">${editable(draft.copy.heroLabel, { kind: "field", field: "copy.heroLabel" }, "hero-label", options)}</p>
        <h1>${editable(draft.copy.heroTitle, { kind: "field", field: "copy.heroTitle" }, "hero-title", options)}</h1>
        <p class="hero__text">${editable(draft.copy.heroSubtitle, { kind: "field", field: "copy.heroSubtitle" }, "hero-subtitle", options)}</p>
        <div class="hero__actions"><a class="button primary" href="#leistungen">Leistungen ansehen</a>${draft.salon.phone ? `<a class="button secondary" href="tel:${escapeAttr(draft.salon.phone.replace(/\s+/g, ""))}"${targetAttrs(options, { kind: "field", field: "salon.phone" }, "hero-phone", true)}>Anrufen</a>` : ""}</div>
      </div>
      ${legacyImageNotice}
    </section>
    <section class="intro-strip"${panelAttr(options, "salon")}${regionAttr(options, "intro")}><div class="container intro-strip__inner"><strong>${draft.salon.tagline ? editable(draft.salon.tagline, { kind: "field", field: "salon.tagline" }, "intro-tagline", options) : editable(draft.salon.name, { kind: "field", field: "salon.name" }, "intro-name", options)}</strong><span>${editable(address, { kind: "field", field: "salon.address" }, "intro-address", options)}</span></div></section>
    <section class="section services" id="leistungen"${sectionAttrs(options, "leistungen", "services")}${regionAttr(options, "services")}><div class="container"><p class="section-label">Salonangebot</p><h2>${editable(draft.copy.servicesTitle, { kind: "field", field: "copy.servicesTitle" }, "services-title", options)}</h2><p class="section-intro">${editable(draft.copy.servicesSubtitle, { kind: "field", field: "copy.servicesSubtitle" }, "services-subtitle", options)}</p><div class="service-groups">${servicesHtml || '<p class="empty">Leistungen folgen in Kürze.</p>'}</div></div></section>
    ${teamHtml}
    ${testimonialsHtml}
    <section class="section details" id="zeiten"${sectionAttrs(options, "zeiten", "hours")}${regionAttr(options, "details")}><div class="container details__grid"><div><p class="section-label">Besuch planen</p><h2>Öffnungszeiten</h2><ul class="hours">${openingHours}</ul></div><div class="contact-card"${panelAttr(options, "salon")}><p class="section-label">Kontakt</p><h2>${editable(draft.salon.name, { kind: "field", field: "salon.name" }, "contact-name", options)}</h2>${address ? `<p>${editable(address, { kind: "field", field: "salon.address" }, "contact-address", options)}</p>` : ""}<div class="contact-links">${contactLinks}</div></div></div></section>
    <section class="booking" id="booking"${sectionAttrs(options, "booking", "copy")}${regionAttr(options, "booking")}><div class="container booking__inner"><div><p class="section-label">Online buchen</p><h2>${editable(draft.copy.bookingTitle, { kind: "field", field: "copy.bookingTitle" }, "booking-title", options)}</h2><p>${editable(draft.copy.bookingSubtitle, { kind: "field", field: "copy.bookingSubtitle" }, "booking-subtitle", options)}</p></div><a class="button primary" href="#leistungen">Leistungen wählen</a></div></section>
  </main>
  <footer${panelAttr(options, "salon")}${regionAttr(options, "footer")}><div class="container footer__inner"><div><strong>${editable(draft.salon.name, { kind: "field", field: "salon.name" }, "footer-name", options)}</strong><span>${editable(draft.salon.tagline, { kind: "field", field: "salon.tagline" }, "footer-tagline", options)}</span></div><p${options.preview ? " data-preview-no-action" : ""}>© ${new Date().getFullYear()} ${escapeHtml(draft.salon.name)}</p></div></footer>${options.preview ? previewBridge(options) : ""}
</body>
</html>`;
}

// ---------------------------------------------------------------------------------------------
// Preview instrumentation. Every function here returns the untouched export output when
// `options.preview` is absent — that is the whole contract, and the export gate proves it.
// ---------------------------------------------------------------------------------------------

const TARGET_LABELS: Record<PreviewTarget["kind"], string> = {
  field: "Angabe",
  service: "Leistung",
  testimonial: "Kundenstimme",
  staff: "Person",
  panel: "Bereich",
};

function targetAttrs(options: BuildOptions, target: PreviewTarget, occurrence: string, interactive = false): string {
  if (!options.preview) return "";
  // A non-interactive element becomes keyboard reachable so the preview is not a mouse-only surface.
  const focusable = interactive ? "" : ' tabindex="0" role="button"';
  return ` data-preview-target="${escapeAttr(JSON.stringify(target))}" data-preview-occurrence="${escapeAttr(occurrence)}" aria-label="${escapeAttr(`${TARGET_LABELS[target.kind]} bearbeiten`)}"${focusable}`;
}

function regionAttr(options: BuildOptions, region: PreviewRegion): string {
  return options.preview ? ` data-preview-region="${region}"` : "";
}

function panelAttr(options: BuildOptions, panel: EditorPanel): string {
  return options.preview ? ` data-preview-panel="${panel}"` : "";
}

function sectionAttrs(options: BuildOptions, section: string, panel: EditorPanel): string {
  return options.preview ? ` data-preview-section="${escapeAttr(section)}"${panelAttr(options, panel)}` : "";
}

/** A piece of draft text. In the export it is the escaped value and nothing else. */
function editable(value: string, target: PreviewTarget, occurrence: string, options: BuildOptions): string {
  if (!options.preview) return escapeHtml(value);
  return `<span class="preview-edit-trigger"${targetAttrs(options, target, occurrence)}>${escapeHtml(value)}</span>`;
}

function previewBridge(options: BuildOptions): string {
  return buildPreviewBridgeScript({
    channel: PREVIEW_CHANNEL,
    version: PREVIEW_PROTOCOL_VERSION,
    instanceId: options.previewInstanceId ?? "",
    renderGeneration: options.renderGeneration ?? 0,
    revision: options.previewRevision ?? 0,
    parentOrigin: options.parentOrigin ?? "*",
    restore: options.previewScroll ?? null,
  });
}

const PREVIEW_CSS = `.preview-edit-trigger{display:inline;box-decoration-break:clone;-webkit-box-decoration-break:clone;border-radius:.18em;cursor:pointer;color:inherit;font:inherit;letter-spacing:inherit;line-height:inherit;text-align:inherit}[data-preview-target]:hover,[data-preview-target]:focus-visible{outline:2px solid var(--accent);outline-offset:3px;background:color-mix(in srgb,var(--accent) 16%,transparent)}[data-preview-panel]{cursor:default}`;

function websiteCss(theme: typeof PRESETS["elegant"]): string {
  return `
:root{--primary:${theme.primary};--accent:${theme.accent};--bg:${theme.bg};--surface:${theme.surface};--text:${theme.text};--display:${theme.display};--body:${theme.body};--radius:${theme.radius};--max:1120px}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--body);line-height:1.55}a{color:inherit}.container{width:min(var(--max),calc(100% - 40px));margin:0 auto}.skip-link{position:fixed;left:16px;top:-80px;z-index:1000;padding:10px 14px;background:#111;color:#fff;border-radius:8px}.skip-link:focus{top:16px}
.site-header{position:sticky;top:0;z-index:20;min-height:70px;display:flex;align-items:center;gap:28px;padding:12px max(20px,calc((100vw - var(--max))/2));border-bottom:1px solid color-mix(in srgb,var(--text) 14%,transparent);background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(18px)}.logo{margin-right:auto;font-family:var(--display);font-size:20px;font-weight:800;text-decoration:none}.site-header nav{display:flex;gap:20px}.site-header nav a{text-decoration:none;font-size:14px;font-weight:700}.header-booking,.button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:10px 18px;border-radius:var(--radius);font-weight:800;text-decoration:none}.header-booking,.button.primary{background:var(--primary);color:white}.button.secondary{border:1px solid currentColor}
.hero{position:relative;min-height:680px;display:grid;align-items:center;overflow:hidden;background:linear-gradient(135deg,var(--surface),var(--bg))}.hero__veil{position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 15% 20%,color-mix(in srgb,var(--accent) 22%,transparent),transparent 38%)}.hero__inner{position:relative;padding:100px 0;max-width:760px;margin-left:max(20px,calc((100vw - var(--max))/2));width:min(760px,calc(100% - 40px))}.section-label{margin:0 0 14px;color:var(--primary);font-size:12px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}.hero h1,.section h2,.booking h2{font-family:var(--display);font-size:clamp(42px,7vw,86px);line-height:1.02;letter-spacing:-.05em;margin:0}.hero__text{max-width:680px;margin:24px 0 0;font-size:clamp(18px,2.2vw,24px)}.hero__actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:32px}.migration-notice{position:absolute;right:24px;bottom:24px;max-width:360px;padding:14px 16px;border-radius:12px;background:color-mix(in srgb,var(--bg) 92%,transparent);box-shadow:0 12px 32px rgba(0,0,0,.12);font-size:13px}
.intro-strip{border-top:1px solid color-mix(in srgb,var(--text) 12%,transparent);border-bottom:1px solid color-mix(in srgb,var(--text) 12%,transparent)}.intro-strip__inner{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:20px}.intro-strip span{color:color-mix(in srgb,var(--text) 65%,transparent)}.section{padding:110px 0}.section h2,.booking h2{font-size:clamp(36px,5vw,64px)}.section-intro{max-width:680px;margin:18px 0 50px;font-size:18px;color:color-mix(in srgb,var(--text) 72%,transparent)}
.service-groups{display:grid;gap:42px}.price-group h3{margin:0 0 12px;font-family:var(--display);font-size:24px}.price-list{border-top:1px solid color-mix(in srgb,var(--text) 18%,transparent)}.price-row{display:grid;grid-template-columns:1fr auto;gap:24px;padding:22px 0;border-bottom:1px solid color-mix(in srgb,var(--text) 14%,transparent)}.price-row h4{margin:0;font-size:19px}.price-row p{margin:6px 0 0;color:color-mix(in srgb,var(--text) 70%,transparent)}.price-row span{display:inline-block;margin-top:8px;font-size:13px;color:color-mix(in srgb,var(--text) 58%,transparent)}.price-row__action{display:flex;align-items:flex-end;flex-direction:column;gap:3px;white-space:nowrap}.price-row__action strong{font-size:17px}.bookable-note{color:var(--primary)!important;font-weight:800}
.team{background:var(--surface)}.team-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:42px}.person-card{display:grid;grid-template-columns:72px 1fr;gap:20px;align-items:start;padding:28px;border-radius:var(--radius);background:var(--bg)}.person-initial{width:72px;height:72px;display:grid;place-items:center;border-radius:50%;background:var(--primary);color:#fff;font-family:var(--display);font-size:24px;font-weight:900}.person-card h3{margin:0;font-family:var(--display);font-size:25px}.person-card p{margin:8px 0 0}.person-role{color:var(--primary);font-weight:800}.person-services{font-size:13px;color:color-mix(in srgb,var(--text) 65%,transparent)}
.voices{background:var(--surface)}.voice-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:42px}.voice-grid figure{margin:0;padding:28px;border-radius:var(--radius);background:var(--bg)}.voice-grid blockquote{margin:0;font-family:var(--display);font-size:21px;line-height:1.45}.voice-grid figcaption{margin-top:24px;font-weight:800}.voice-grid figcaption span{display:block;margin-top:3px;color:color-mix(in srgb,var(--text) 60%,transparent);font-size:13px;font-weight:500}
.details{background:var(--surface)}.details__grid{display:grid;grid-template-columns:1.2fr .8fr;gap:70px}.hours{list-style:none;margin:36px 0 0;padding:0}.hours li{display:flex;justify-content:space-between;gap:16px;padding:13px 0;border-bottom:1px solid color-mix(in srgb,var(--text) 13%,transparent)}.contact-card{align-self:start;padding:34px;border-radius:var(--radius);background:var(--bg)}.contact-card h2{font-size:34px}.contact-links{display:grid;gap:8px;margin-top:24px}.contact-links a{font-weight:800}.booking{padding:80px 0;background:var(--primary);color:#fff}.booking__inner{display:flex;align-items:center;justify-content:space-between;gap:40px}.booking .section-label{color:color-mix(in srgb,#fff 70%,transparent)}.booking .button.primary{background:#fff;color:var(--primary)}footer{padding:34px 0;border-top:1px solid color-mix(in srgb,var(--text) 12%,transparent)}.footer__inner{display:flex;align-items:center;justify-content:space-between;gap:20px}.footer__inner div{display:grid}.footer__inner span,.footer__inner p{font-size:13px;color:color-mix(in srgb,var(--text) 60%,transparent)}
@media(max-width:760px){.site-header nav{display:none}.header-booking{padding:9px 13px}.hero{min-height:590px}.hero__inner{padding:80px 0}.section{padding:76px 0}.details__grid,.voice-grid,.team-grid{grid-template-columns:1fr}.details__grid{gap:40px}.booking__inner,.intro-strip__inner,.footer__inner{align-items:flex-start;flex-direction:column}.price-row{grid-template-columns:1fr}.price-row__action{align-items:flex-start}.migration-notice{position:relative;right:auto;bottom:auto;margin:0 20px 20px}.site-header{gap:12px}.person-card{grid-template-columns:56px 1fr}.person-initial{width:56px;height:56px;font-size:19px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{animation:none!important;transition:none!important}}
`;
}
