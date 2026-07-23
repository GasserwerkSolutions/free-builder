import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createDefaultDraft } from "../assets/domain.js";
import { PREVIEW_CHANNEL, PREVIEW_PROTOCOL_VERSION } from "../assets/preview-contract.js";
import { buildWebsiteHtml } from "../assets/website.js";

// The preview document under test, with its bridge script actually running.
//
// In the browser the preview is a sandboxed srcdoc document with an opaque origin, and `parent` is a
// different window. jsdom can model neither: `parent` is the window itself, so a strictly targeted
// postMessage only arrives when the target origin equals the document's own origin. The document is
// therefore hosted at the editor origin here. What is under test is the strict equality check itself
// — a message from any other origin has to be invisible to the bridge.
const INSTANCE = "bridge-instance";
const GENERATION = 5;
const EDITOR_ORIGIN = "https://editor.test";

function render(draft, revision) {
  return buildWebsiteHtml(draft, { preview: true, previewInstanceId: INSTANCE, parentOrigin: EDITOR_ORIGIN, previewRevision: revision, renderGeneration: GENERATION });
}

async function bridge(revision = 0, prepare) {
  const draft = createDefaultDraft("2026-07-23T09:00:00.000Z");
  prepare?.(draft);
  const dom = new JSDOM(render(draft, revision), { url: EDITOR_ORIGIN, runScripts: "dangerously", pretendToBeVisual: true });
  const results = [];
  const outgoing = [];
  dom.window.addEventListener("message", (event) => {
    if (event.data?.action === "update-result") results.push(event.data);
    outgoing.push(event.data);
  });
  await tick(dom);
  return { dom, draft, results, outgoing, document: dom.window.document };
}

const tick = (dom) => new Promise((resolve) => dom.window.setTimeout(resolve, 10));

function request(revision, operations, { baseRevision = revision - 1, requestId = `r-${revision}` } = {}) {
  return { channel: PREVIEW_CHANNEL, version: PREVIEW_PROTOCOL_VERSION, instanceId: INSTANCE, renderGeneration: GENERATION, requestId, baseRevision, revision, action: "apply-update", operations };
}

function dispatch(dom, data, origin = EDITOR_ORIGIN) {
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: dom.window, origin }));
}

function only(document, target) {
  const key = JSON.stringify(target);
  const matches = [...document.querySelectorAll("[data-preview-target]")].filter((element) => element.getAttribute("data-preview-target") === key);
  assert.equal(matches.length, 1, `genau ein Element für ${key}`);
  return matches[0];
}

function regionHtml(draft, region, revision) {
  const parsed = new JSDOM(render(draft, revision));
  const matches = [...parsed.window.document.querySelectorAll("[data-preview-region]")].filter((element) => element.getAttribute("data-preview-region") === region);
  assert.equal(matches.length, 1);
  const outer = matches[0].outerHTML;
  parsed.window.close();
  return outer;
}

const HERO_TITLE = { kind: "field", field: "copy.heroTitle" };

// Values that crossed the jsdom realm boundary carry that realm's Object prototype, which
// deepStrictEqual counts as a difference. Only the content is of interest here.
const plain = (value) => JSON.parse(JSON.stringify(value));
const lastNavigation = (outgoing) => plain(outgoing.filter((entry) => entry?.action === "navigate-to-editor").at(-1).target);

test("eine Nachricht von einem fremden Ursprung wird gar nicht erst betrachtet", async () => {
  const { dom, results, document } = await bridge();
  const before = only(document, HERO_TITLE).textContent;
  dispatch(dom, request(1, [{ type: "patch-text", target: HERO_TITLE, value: "Von woanders" }]), "https://boese.test");
  await tick(dom);
  assert.equal(only(document, HERO_TITLE).textContent, before);
  assert.equal(results.length, 0, "kein Ergebnis, keine Antwort — die Nachricht existiert für das Kind nicht");
  dom.window.close();
});

test("eine Nachricht mit fremder Instanz oder Generation wird verworfen", async () => {
  const { dom, results, document } = await bridge();
  const before = only(document, HERO_TITLE).textContent;
  dispatch(dom, { ...request(1, [{ type: "patch-text", target: HERO_TITLE, value: "X" }]), instanceId: "geraten" });
  dispatch(dom, { ...request(1, [{ type: "patch-text", target: HERO_TITLE, value: "Y" }]), renderGeneration: 99 });
  await tick(dom);
  assert.equal(only(document, HERO_TITLE).textContent, before);
  assert.equal(results.length, 0);
  dom.window.close();
});

test("gültiger Text und Theme werden gemeinsam übernommen", async () => {
  const { dom, results, document } = await bridge();
  dispatch(dom, request(1, [
    { type: "patch-theme", primary: "#112233", accent: "#aabbcc" },
    { type: "patch-text", target: HERO_TITLE, value: "Inkrementeller Titel" },
  ]));
  await tick(dom);
  assert.equal(only(document, HERO_TITLE).textContent, "Inkrementeller Titel");
  assert.equal(document.documentElement.style.getPropertyValue("--primary"), "#112233");
  assert.equal(document.documentElement.style.getPropertyValue("--accent"), "#aabbcc");
  assert.equal(document.querySelector('meta[name="theme-color"]').getAttribute("content"), "#112233");
  assert.equal(results.at(-1).success, true);
  assert.equal(results.at(-1).revision, 1);
  dom.window.close();
});

test("eine ungültige Operation im Bündel verhindert jede einzelne davon", async () => {
  const { dom, results, document } = await bridge();
  const before = only(document, HERO_TITLE).textContent;
  dispatch(dom, request(1, [
    { type: "patch-text", target: HERO_TITLE, value: "Darf nicht sichtbar werden" },
    { type: "patch-text", target: { kind: "field", field: "copy.gibtEsNicht" }, value: "Ungültig" },
  ]));
  await tick(dom);
  assert.equal(only(document, HERO_TITLE).textContent, before);
  assert.equal(results.at(-1).success, false);
  assert.equal(results.at(-1).reason, "unknown-target");
  dom.window.close();
});

test("doppelte und ineinander verschachtelte Operationen werden vor der ersten Änderung abgelehnt", async () => {
  const { dom, draft, results, document } = await bridge();
  const before = only(document, HERO_TITLE).textContent;
  dispatch(dom, request(1, [
    { type: "patch-text", target: HERO_TITLE, value: "Erster Wert" },
    { type: "patch-text", target: HERO_TITLE, value: "Zweiter Wert" },
  ], { requestId: "doppelt" }));
  await tick(dom);
  assert.equal(only(document, HERO_TITLE).textContent, before);
  assert.equal(results.at(-1).reason, "conflicting-operations");

  draft.copy.heroTitle = "Regionaler Titel";
  dispatch(dom, request(1, [
    { type: "patch-text", target: HERO_TITLE, value: "Nicht anwenden" },
    { type: "replace-region", region: "hero", html: regionHtml(draft, "hero", 1) },
  ], { requestId: "verschachtelt" }));
  await tick(dom);
  assert.equal(only(document, HERO_TITLE).textContent, before);
  assert.equal(results.at(-1).reason, "conflicting-operations");
  dom.window.close();
});

test("veraltete und lückenhafte Revisionen fassen den DOM nicht an", async () => {
  const { dom, results, document } = await bridge(3);
  const before = only(document, HERO_TITLE).textContent;
  dispatch(dom, request(3, [{ type: "patch-text", target: HERO_TITLE, value: "Veraltet" }], { baseRevision: 3, requestId: "veraltet" }));
  dispatch(dom, request(5, [{ type: "patch-text", target: HERO_TITLE, value: "Lücke" }], { baseRevision: 2, requestId: "luecke" }));
  await tick(dom);
  assert.equal(only(document, HERO_TITLE).textContent, before);
  assert.deepEqual(results.slice(-2).map((result) => result.reason), ["stale-revision", "revision-gap"]);
  dom.window.close();
});

test("eine Region mit fremdem Skript oder falschem Namen wird nicht eingesetzt", async () => {
  const { dom, results, document } = await bridge();
  const boese = '<section data-preview-region="hero"><script>globalThis.eingedrungen = true;<\/script></section>';
  dispatch(dom, request(1, [{ type: "replace-region", region: "hero", html: boese }], { requestId: "skript" }));
  await tick(dom);
  assert.equal(dom.window.eingedrungen, undefined);
  assert.equal(results.at(-1).reason, "invalid-region");

  dispatch(dom, request(1, [{ type: "replace-region", region: "hero", html: '<section data-preview-region="footer"></section>' }], { requestId: "falsch" }));
  await tick(dom);
  assert.equal(results.at(-1).reason, "invalid-region");
  assert.ok(document.querySelector('[data-preview-region="hero"] h1'), "der Hero steht noch");
  dom.window.close();
});

test("ein Regionentausch stellt den Fokus auf dasselbe Ziel zurück", async () => {
  const { dom, draft, results, document } = await bridge();
  only(document, HERO_TITLE).focus();
  assert.equal(document.activeElement.getAttribute("data-preview-target"), JSON.stringify(HERO_TITLE));

  draft.copy.heroTitle = "Neu gerenderter Titel";
  dispatch(dom, request(1, [{ type: "replace-region", region: "hero", html: regionHtml(draft, "hero", 1) }]));
  await tick(dom);

  assert.equal(only(document, HERO_TITLE).textContent, "Neu gerenderter Titel");
  assert.equal(document.activeElement.getAttribute("data-preview-target"), JSON.stringify(HERO_TITLE));
  assert.equal(document.activeElement.getAttribute("data-preview-occurrence"), "hero-title");
  assert.equal(results.at(-1).success, true);
  dom.window.close();
});

test("bricht ein Schritt der Übernahme ab, wird der ganze Stand zurückgerollt", async () => {
  const { dom, draft, results, document } = await bridge();
  const heroBefore = document.querySelector('[data-preview-region="hero"]').outerHTML;
  const servicesBefore = document.querySelector('[data-preview-region="services"]').outerHTML;

  draft.copy.heroTitle = "Wird zurückgerollt";
  draft.copy.servicesTitle = "Auch zurückgerollt";
  const heroHtml = regionHtml(draft, "hero", 1);
  const servicesHtml = regionHtml(draft, "services", 1);

  // Let the second replacement fail mid-commit. The first one has already landed at that point, so
  // only a real rollback can bring the document back.
  const proto = dom.window.Element.prototype;
  const realReplaceWith = proto.replaceWith;
  let replacements = 0;
  proto.replaceWith = function patched(...args) {
    replacements += 1;
    if (replacements === 2) throw new Error("Absturz mitten in der Übernahme");
    return realReplaceWith.apply(this, args);
  };
  try {
    dispatch(dom, request(1, [
      { type: "replace-region", region: "hero", html: heroHtml },
      { type: "replace-region", region: "services", html: servicesHtml },
    ]));
    await tick(dom);
  } finally {
    proto.replaceWith = realReplaceWith;
  }

  assert.equal(results.at(-1).success, false);
  assert.equal(results.at(-1).reason, "internal-error");
  assert.equal(document.querySelector('[data-preview-region="hero"]').outerHTML, heroBefore, "der Hero ist zurückgerollt");
  assert.equal(document.querySelector('[data-preview-region="services"]').outerHTML, servicesBefore);
  dom.window.close();
});

test("nach einem abgelehnten Bündel gilt die alte Revision weiter", async () => {
  const { dom, results, document } = await bridge();
  dispatch(dom, request(1, [{ type: "patch-text", target: { kind: "field", field: "copy.gibtEsNicht" }, value: "x" }], { requestId: "abgelehnt" }));
  await tick(dom);
  assert.equal(results.at(-1).success, false);
  // baseRevision 0 still fits: the failed attempt did not move the document forward.
  dispatch(dom, request(1, [{ type: "patch-text", target: HERO_TITLE, value: "Jetzt aber" }], { requestId: "danach" }));
  await tick(dom);
  assert.equal(results.at(-1).success, true);
  assert.equal(only(document, HERO_TITLE).textContent, "Jetzt aber");
  dom.window.close();
});

test("ein Klick auf einen Text meldet das zugehörige Editor-Feld statt zu navigieren", async () => {
  const { dom, outgoing, document } = await bridge();
  const element = only(document, HERO_TITLE);
  const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  await tick(dom);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(lastNavigation(outgoing), HERO_TITLE);
  dom.window.close();
});

test("ein Klick auf eine Leistung meldet genau diese Leistung", async () => {
  const { dom, draft, outgoing, document } = await bridge();
  const target = { kind: "service", serviceClientId: draft.services[1].clientId, field: "name" };
  only(document, target).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick(dom);
  assert.deepEqual(lastNavigation(outgoing), target);
  dom.window.close();
});

test("Enter auf einem Vorschau-Ziel wirkt wie ein Klick", async () => {
  const { dom, outgoing, document } = await bridge();
  only(document, HERO_TITLE).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await tick(dom);
  assert.deepEqual(lastNavigation(outgoing), HERO_TITLE);
  dom.window.close();
});

test("ein Klick auf eine leere Stelle öffnet den Bereich dieser Sektion", async () => {
  const { dom, outgoing, document } = await bridge();
  document.querySelector('[data-preview-region="details"] .hours').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick(dom);
  assert.deepEqual(lastNavigation(outgoing), { kind: "panel", panel: "hours" });
  dom.window.close();
});

test("echte Navigation wird in der Vorschau geschluckt", async () => {
  const { dom, document } = await bridge();
  const external = document.querySelector('a[href^="mailto:"]');
  const blocked = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  external.dispatchEvent(blocked);
  assert.equal(blocked.defaultPrevented, true);

  const booking = document.querySelector("a.header-booking");
  const hash = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  booking.dispatchEvent(hash);
  assert.equal(hash.defaultPrevented, true, "auch Sprungmarken werden selbst behandelt, nie vom Browser");
  dom.window.close();
});

test("das Kind meldet sich nach dem Laden genau einmal bereit", async () => {
  const { dom, outgoing } = await bridge(4);
  const ready = outgoing.filter((entry) => entry?.action === "ready");
  assert.equal(ready.length, 1);
  assert.equal(ready[0].instanceId, INSTANCE);
  assert.equal(ready[0].renderGeneration, GENERATION);
  assert.equal(ready[0].revision, 4, "die Revision, mit der dieses Dokument gebaut wurde");
  dom.window.close();
});
