// A real editor in a real DOM.
//
// Every other test in this repository replays call sites. This helper boots the shipped index.html in
// jsdom and runs the actual BuilderUi/team wiring against it, so a test can click a button and type
// into an input the way a user does — including the fact that handleInput is registered on both
// "input" and "change".
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { MemoryDraftRepository } from "../../assets/persistence.js";
import { BuilderStore } from "../../assets/store.js";
import { BuilderUi } from "../../assets/ui.js";
import { installTeamUi } from "../../assets/team-ui.js";

const indexHtml = await readFile(new URL("../../index.html", import.meta.url), "utf8");

// The toast and the preview both schedule timers. Left alone they hold the test process open long
// after the assertions are done, so every timer this harness creates is unref'd.
const nodeSetTimeout = globalThis.setTimeout;
let timersPatched = false;
function patchTimers() {
  if (timersPatched) return;
  timersPatched = true;
  globalThis.setTimeout = (handler, delay, ...args) => {
    const timer = nodeSetTimeout(handler, delay, ...args);
    timer.unref?.();
    return timer;
  };
}

const DOM_GLOBALS = [
  "Element", "Node", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
  "HTMLIFrameElement", "HTMLTemplateElement", "HTMLButtonElement", "Event", "CustomEvent",
  "MouseEvent", "KeyboardEvent", "MessageEvent", "DOMParser", "NodeFilter", "getComputedStyle",
];

/**
 * Boot the editor. `confirmAnswer` decides what window.confirm returns — jsdom has no implementation
 * and the destructive paths (reset, copy day) go through it.
 */
export async function bootEditor(options = {}) {
  patchTimers();
  const scrolledInto = [];
  const dom = new JSDOM(indexHtml, { url: "https://editor.test", pretendToBeVisual: true });
  const { window } = dom;
  window.confirm = () => options.confirmAnswer ?? true;
  window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  // Node exposes globalThis.navigator through a getter, so a plain assignment throws.
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });
  globalThis.CSS = window.CSS?.escape ? window.CSS : { escape: (value) => String(value).replace(/["\\]/g, "\\$&") };
  globalThis.matchMedia = (query) => window.matchMedia(query);
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  // jsdom does no layout, so it implements neither of these. Everything they would do — the actual
  // scrolling — is therefore NOT covered here; only that the calls happen on the right element.
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolledInto.push(this); };
  window.HTMLElement.prototype.scrollTo = () => {};
  for (const name of DOM_GLOBALS) if (window[name]) globalThis[name] = window[name];

  const repository = new MemoryDraftRepository();
  const draft = options.draft ?? (await import("../../assets/domain.js")).createDefaultDraft("2026-07-23T09:00:00.000Z");
  await repository.putDraft(draft);
  const store = new BuilderStore(draft, repository, options.debounceMs ?? 0);
  const ui = new BuilderUi(store, repository);
  ui.init({ draft, migratedFromV1: false, recovered: false, volatileStorage: false });
  installTeamUi(store, repository);

  const cleanup = () => {
    ui.destroy?.();
    window.close();
  };
  return { dom, window, document: window.document, store, repository, ui, scrolledInto, cleanup };
}

/** Click the way a browser does: a bubbling, cancelable MouseEvent on the element itself. */
export function click(element) {
  assertPresent(element, "click");
  element.dispatchEvent(new element.ownerDocument.defaultView.MouseEvent("click", { bubbles: true, cancelable: true }));
}

/**
 * Type into a text control. A browser fires "input" per keystroke and "change" once the field is
 * committed — and handleInput is registered on both, so this helper fires both on purpose.
 */
export function type(element, value, { commit = true } = {}) {
  assertPresent(element, "type");
  const view = element.ownerDocument.defaultView;
  element.value = value;
  element.dispatchEvent(new view.Event("input", { bubbles: true }));
  if (commit) element.dispatchEvent(new view.Event("change", { bubbles: true }));
}

/** Toggle a checkbox the way a click does: flip the state, then fire input and change. */
export function toggle(element, checked = !element.checked) {
  assertPresent(element, "toggle");
  const view = element.ownerDocument.defaultView;
  element.checked = checked;
  element.dispatchEvent(new view.Event("input", { bubbles: true }));
  element.dispatchEvent(new view.Event("change", { bubbles: true }));
}

/** Select an option and commit it, the way a browser does for a <select>. */
export function choose(element, value) {
  assertPresent(element, "choose");
  const view = element.ownerDocument.defaultView;
  element.value = value;
  element.dispatchEvent(new view.Event("input", { bubbles: true }));
  element.dispatchEvent(new view.Event("change", { bubbles: true }));
}

export function toastText(document) {
  return document.querySelector(".toast")?.textContent ?? null;
}

export function clearToast(document) {
  document.querySelector(".toast")?.remove();
}

/** Silence and collect console.error for the paths that deliberately log a rejected mutation. */
export async function withCapturedErrors(run) {
  const logged = [];
  const real = console.error;
  console.error = (...args) => logged.push(args);
  try { return { result: await run(), logged }; } finally { console.error = real; }
}

function assertPresent(element, action) {
  if (!element) throw new Error(`MISSING_ELEMENT_FOR:${action}`);
}
