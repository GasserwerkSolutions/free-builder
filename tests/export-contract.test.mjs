import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { buildWebsiteHtml } from "../assets/website.js";
import { exportFixtureDraft, withFixedClock } from "./fixtures/export-draft.mjs";

// The export gate.
//
// buildWebsiteHtml is the single renderer for the preview and for the exported file. That is only
// worth anything as long as the preview instrumentation cannot leak into the export. The baseline in
// fixtures/export-baseline.html was recorded from the commit before the preview protocol landed
// (7f117ad); the exported HTML has to stay byte-identical to it.
//
// Regenerating the baseline is only ever legitimate for a deliberate export change — or after a
// Node/ICU upgrade, because formatPrice goes through Intl.NumberFormat. Any other difference is the
// bug this test exists to catch.
//
// The baseline is not self-generated, which would make it circular and worthless. It is the output of
// the renderer as it stood before this stage, and that can be re-derived at any time:
//
//   git show 7f117ad:assets/website.js > <tmp>/assets/website.js   (plus the domain-* modules)
//   node -e "buildWebsiteHtml(exportFixtureDraft()) under withFixedClock" > from-precommit.html
//   cmp from-precommit.html tests/fixtures/export-baseline.html     -> identical

const baseline = await readFile(new URL("./fixtures/export-baseline.html", import.meta.url), "utf8");

test("der Export bleibt byte-identisch zum aufgezeichneten Vorher-Stand", () => {
  const html = withFixedClock(() => buildWebsiteHtml(exportFixtureDraft()));
  assert.equal(Buffer.byteLength(html, "utf8"), Buffer.byteLength(baseline, "utf8"));
  assert.equal(html, baseline);
});

test("der Export enthält keine einzige Vorschau-Instrumentierung", () => {
  const html = withFixedClock(() => buildWebsiteHtml(exportFixtureDraft()));
  assert.doesNotMatch(html, /data-preview-/);
  assert.doesNotMatch(html, /preview-edit-trigger/);
  assert.doesNotMatch(html, /postMessage/);
  // The exported page carries exactly one script: the JSON-LD block. No behaviour ships with it.
  assert.equal(html.match(/<script/g)?.length, 1);
  assert.match(html, /<script type="application\/ld\+json">/);
});

test("die Vorschau rendert denselben Inhalt, nur zusätzlich instrumentiert", () => {
  const draft = exportFixtureDraft();
  const preview = withFixedClock(() => buildWebsiteHtml(draft, { preview: true, previewInstanceId: "gate", parentOrigin: "https://editor.test", previewRevision: 0, renderGeneration: 1 }));
  // Instrumentation is additive, never substitutive: the words on the page have to be identical.
  // The migration notice is the one deliberate preview-only element and predates this port, so it is
  // removed before the comparison instead of being smuggled past it.
  const visibleText = (html) => {
    const { window } = new JSDOM(html);
    window.document.querySelectorAll("script, style, .migration-notice").forEach((element) => element.remove());
    const text = window.document.body.textContent.replace(/\s+/g, " ").trim();
    window.close();
    return text;
  };
  assert.equal(visibleText(preview), visibleText(baseline));
});
