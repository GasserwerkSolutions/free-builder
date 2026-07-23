import { announce, makeTransientlyFocusable, readPreference, showToast, writePreference, type MobileMode, type UiContext } from "./ui-shared.js";

// The phone is a different device, not a narrow desktop.
//
// Below the breakpoint the editor and the preview no longer stand next to each other; they take turns
// and a bar at the bottom switches between them. Three details make that usable on Android Chrome,
// which is the device this was measured on:
//
//   * The soft keyboard shrinks the visual viewport. The mode bar would sit on top of the keyboard,
//     so it steps aside while a field is being typed into.
//   * The inactive half is not merely invisible: it is inert and aria-hidden, so neither a tap nor a
//     screen reader reaches a surface the user cannot see.
//   * Chrome zooms into any focused control whose font is smaller than 16px, and never zooms back
//     out. The zoom guard is therefore a CSS rule (16px inputs below 700px), enforced by a test.

export const MOBILE_MODE_MEDIA = "(max-width: 700px)";

const MOBILE_HINT_KEY = "gasserwerk-salon-mobile-hint-v1";
/** Below this share of the window height, the missing space is taken to be the soft keyboard. */
const KEYBOARD_VIEWPORT_RATIO = 0.85;
const KEYBOARD_CHECK_FALLBACK_MS = 350;

let baselineInnerHeight = 0;

export function initMobileModes(context: UiContext): () => void {
  const media = matchMobileMedia();
  const onMediaChange = (): void => { applyMobileMode(context); if (!isMobileModeActive()) closeSectionSheet(context); };
  const onResize = (): void => {
    // Only a resize without a focused field is a real device resize; the rest is the keyboard.
    if (!isEditableControl(document.activeElement)) baselineInnerHeight = window.innerHeight;
    if (isMobileModeActive()) { measureMobileChrome(); refreshModeBarForKeyboard(); }
  };
  const onFocusIn = (event: Event): void => { if (isEditableControl(event.target)) scheduleKeyboardCheck(); };
  const onFocusOut = (): void => scheduleKeyboardCheck();
  const onViewportResize = (): void => refreshModeBarForKeyboard();

  baselineInnerHeight = window.innerHeight;
  media?.addEventListener("change", onMediaChange);
  window.addEventListener("resize", onResize);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  window.visualViewport?.addEventListener("resize", onViewportResize);
  applyMobileMode(context);
  maybeShowMobileHint();

  return () => {
    media?.removeEventListener("change", onMediaChange);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    window.visualViewport?.removeEventListener("resize", onViewportResize);
    resetMobileMode(context);
  };
}

/**
 * Give back everything the mobile modes put on the document. A destroyed editor that leaves an inert,
 * aria-hidden surface behind would make the page unusable for whatever takes its place — and nothing
 * would still be listening to undo it.
 */
function resetMobileMode(context: UiContext): void {
  context.workspace.classList.remove("is-mode-edit", "is-mode-preview");
  [
    context.workspace,
    context.controlSurface,
    document.querySelector<HTMLElement>(".preview-area"),
    document.querySelector<HTMLElement>(".topbar"),
    document.querySelector<HTMLElement>(".mode-switch"),
  ].forEach((element) => setInactive(element, false));
  document.querySelector<HTMLElement>(".mode-switch")?.classList.remove("is-keyboard-hidden");
  setPreviewReturnVisible(false);
}

export function isMobileModeActive(): boolean {
  return matchMobileMedia()?.matches === true;
}

export function setMobileMode(context: UiContext, mode: MobileMode, spoken = true): void {
  if (context.mobileMode === mode) { applyMobileMode(context); return; }
  if (context.mobileMode === "edit") context.mobileEditorScroll = window.scrollY;
  context.mobileMode = mode;
  if (mode === "preview") setPreviewReturnVisible(false);
  applyMobileMode(context);
  if (isMobileModeActive()) window.scrollTo(0, mode === "edit" ? context.mobileEditorScroll : 0);
  if (spoken) announce(context, mode === "edit" ? "Der Bearbeitungsmodus ist aktiv." : "Die Vorschau ist aktiv. Tippe auf einen Inhalt, um ihn zu bearbeiten.");
}

/** A jump into a field is worthless while the preview covers it. */
export function ensureMobileEditMode(context: UiContext): void {
  if (isMobileModeActive() && context.mobileMode !== "edit") setMobileMode(context, "edit", false);
}

/** After a tap in the mobile preview sent the user into a field, offer the way back. */
export function markPreviewReturnAvailable(): void { setPreviewReturnVisible(true); }

export function applyMobileMode(context: UiContext): void {
  const mobile = isMobileModeActive();
  const mode = context.mobileMode;
  const previewArea = document.querySelector<HTMLElement>(".preview-area");
  context.workspace.classList.toggle("is-mode-edit", mobile && mode === "edit");
  context.workspace.classList.toggle("is-mode-preview", mobile && mode === "preview");
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  setInactive(context.controlSurface, mobile && mode === "preview");
  setInactive(previewArea, mobile && mode === "edit");
  if (!mobile) setPreviewReturnVisible(false);
  if (mobile) measureMobileChrome();
}

export function isSectionSheetOpen(): boolean {
  const sheet = document.getElementById("sectionSheet");
  return Boolean(sheet && !sheet.hidden);
}

export function openSectionSheet(context: UiContext): void {
  const sheet = document.getElementById("sectionSheet");
  if (!sheet || !sheet.hidden) return;
  renderSectionSheet();
  sheet.hidden = false;
  setSheetBackgroundInert(context, true);
  document.querySelector<HTMLElement>("[data-sheet-open]")?.setAttribute("aria-expanded", "true");
  const preferred = sheet.querySelector<HTMLElement>(".section-sheet__entry.is-active") ?? sheet.querySelector<HTMLElement>(".section-sheet__entry");
  preferred?.focus();
}

export function closeSectionSheet(context: UiContext, focusPanel = false): void {
  const sheet = document.getElementById("sectionSheet");
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  setSheetBackgroundInert(context, false);
  const trigger = document.querySelector<HTMLElement>("[data-sheet-open]");
  trigger?.setAttribute("aria-expanded", "false");
  if (focusPanel) {
    const heading = document.querySelector<HTMLElement>(".panel.is-active h1, .panel.is-active h2");
    if (heading) { makeTransientlyFocusable(heading); heading.focus(); return; }
  }
  trigger?.focus();
}

/** The mode bar gets out of the way while the soft keyboard is up. */
export function refreshModeBarForKeyboard(): void {
  document.querySelector<HTMLElement>(".mode-switch")?.classList.toggle("is-keyboard-hidden", isMobileModeActive() && keyboardLikelyOpen());
}

// The bottom sheet mirrors the section navigation instead of repeating it, so a panel that the team
// surface adds at runtime is in both places or in neither.
function renderSectionSheet(): void {
  const list = document.getElementById("sectionSheetList");
  if (!list) return;
  list.textContent = "";
  document.querySelectorAll<HTMLElement>(".surface-nav [data-panel-target]").forEach((navButton, index) => {
    const active = navButton.classList.contains("is-active");
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = `section-sheet__entry${active ? " is-active" : ""}`;
    entry.dataset.panelTarget = navButton.dataset.panelTarget ?? "salon";
    if (active) entry.setAttribute("aria-current", "step");
    const number = document.createElement("span");
    number.className = "section-sheet__number";
    number.setAttribute("aria-hidden", "true");
    number.textContent = String(index + 1);
    const label = document.createElement("span");
    label.textContent = navButton.textContent?.trim() ?? "";
    entry.append(number, label);
    list.appendChild(entry);
  });
}

function setSheetBackgroundInert(context: UiContext, on: boolean): void {
  [document.querySelector<HTMLElement>(".topbar"), context.workspace, document.querySelector<HTMLElement>(".mode-switch")]
    .forEach((element) => setInactive(element, on));
}

function setInactive(element: HTMLElement | null, inactive: boolean): void {
  if (!element) return;
  element.toggleAttribute("inert", inactive);
  if (inactive) element.setAttribute("aria-hidden", "true");
  else element.removeAttribute("aria-hidden");
}

function setPreviewReturnVisible(visible: boolean): void {
  const button = document.querySelector<HTMLElement>("[data-return-preview]");
  if (button) button.hidden = !visible;
}

function scheduleKeyboardCheck(): void {
  // The keyboard animates in; one measurement is taken now, one after two frames and one late, so
  // the bar does not sit on the keyboard for half a second.
  refreshModeBarForKeyboard();
  requestAnimationFrame(() => requestAnimationFrame(refreshModeBarForKeyboard));
  window.setTimeout(refreshModeBarForKeyboard, KEYBOARD_CHECK_FALLBACK_MS);
}

function keyboardLikelyOpen(): boolean {
  if (!isEditableControl(document.activeElement)) return false;
  const viewport = window.visualViewport;
  if (viewport && viewport.height < window.innerHeight * KEYBOARD_VIEWPORT_RATIO) return true;
  return baselineInnerHeight > 0 && window.innerHeight < baselineInnerHeight * KEYBOARD_VIEWPORT_RATIO;
}

function isEditableControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.matches("input, textarea, select");
}

function maybeShowMobileHint(): void {
  if (!isMobileModeActive() || readPreference(MOBILE_HINT_KEY)) return;
  writePreference(MOBILE_HINT_KEY, "1");
  showToast("Unten wechselst du zwischen Bearbeiten und Vorschau.");
}

// The two fixed bars are measured, not guessed: the preview between them has to end exactly where
// the mode bar starts, on every phone and with every browser chrome height.
function measureMobileChrome(): void {
  const root = document.documentElement;
  const topbar = document.querySelector<HTMLElement>(".topbar");
  const modeBar = document.querySelector<HTMLElement>(".mode-switch");
  if (topbar) root.style.setProperty("--mobile-topbar-height", `${Math.round(topbar.getBoundingClientRect().height)}px`);
  if (modeBar) root.style.setProperty("--mobile-modebar-height", `${Math.round(modeBar.getBoundingClientRect().height)}px`);
}

function matchMobileMedia(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_MODE_MEDIA) : null;
}
