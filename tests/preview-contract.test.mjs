import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultDraft } from "../assets/domain.js";
import {
  EDITABLE_FIELDS,
  PREVIEW_CHANNEL,
  PREVIEW_PROTOCOL_VERSION,
  isPreviewMessageEnvelope,
  isPreviewRegion,
  isPreviewTarget,
  isPreviewTargetShape,
  panelForTarget,
  parseNavigateMessage,
  parseReadyMessage,
  parseScrollMessage,
  parseUpdateResult,
  resolveParentOrigin,
} from "../assets/preview-contract.js";

const envelope = (extra = {}) => ({ channel: PREVIEW_CHANNEL, version: PREVIEW_PROTOCOL_VERSION, instanceId: "i-1", renderGeneration: 2, revision: 3, ...extra });

test("eine Nachricht ohne passende Instanz oder Generation gilt nicht als unsere", () => {
  assert.equal(isPreviewMessageEnvelope(envelope(), "i-1", 2), true);
  assert.equal(isPreviewMessageEnvelope(envelope(), "i-2", 2), false);
  assert.equal(isPreviewMessageEnvelope(envelope(), "i-1", 3), false);
  assert.equal(isPreviewMessageEnvelope(envelope({ channel: "fremd" }), "i-1", 2), false);
  assert.equal(isPreviewMessageEnvelope(envelope({ version: 99 }), "i-1", 2), false);
  assert.equal(isPreviewMessageEnvelope(envelope({ revision: -1 }), "i-1", 2), false);
  assert.equal(isPreviewMessageEnvelope(envelope({ revision: 1.5 }), "i-1", 2), false);
  assert.equal(isPreviewMessageEnvelope(null, "i-1", 2), false);
  assert.equal(isPreviewMessageEnvelope([envelope()], "i-1", 2), false);
});

test("nur Ziele aus dem Vertrag werden anerkannt", () => {
  assert.equal(isPreviewTargetShape({ kind: "field", field: "salon.name" }), true);
  assert.equal(isPreviewTargetShape({ kind: "field", field: "salon.erfunden" }), false);
  assert.equal(isPreviewTargetShape({ kind: "service", serviceClientId: "s", field: "name" }), true);
  assert.equal(isPreviewTargetShape({ kind: "service", serviceClientId: "s", field: "price" }), false);
  assert.equal(isPreviewTargetShape({ kind: "staff", staffClientId: "p", field: "email" }), false);
  assert.equal(isPreviewTargetShape({ kind: "panel", panel: "team" }), true);
  assert.equal(isPreviewTargetShape({ kind: "panel", panel: "structure" }), false);
  assert.equal(isPreviewTargetShape({ kind: "abschnitt", section: "hero" }), false);
});

test("jedes gebundene Eingabefeld hat ein anerkanntes Vorschau-Ziel", () => {
  for (const field of EDITABLE_FIELDS) assert.equal(isPreviewTargetShape({ kind: "field", field }), true, field);
});

test("ein Ziel auf einen gelöschten Eintrag ist formal gültig, inhaltlich aber nicht", () => {
  const draft = createDefaultDraft();
  const existing = draft.services[0].clientId;
  assert.equal(isPreviewTarget({ kind: "service", serviceClientId: existing, field: "name" }, draft), true);
  assert.equal(isPreviewTarget({ kind: "service", serviceClientId: "weg", field: "name" }, draft), false);
  assert.equal(isPreviewTarget({ kind: "testimonial", testimonialClientId: "weg", field: "quote" }, draft), false);
  assert.equal(isPreviewTarget({ kind: "staff", staffClientId: "weg", field: "name" }, draft), false);
  // A panel target points at the surface itself and can never go stale.
  assert.equal(isPreviewTarget({ kind: "panel", panel: "voices" }, draft), true);
});

test("jedes Ziel kennt genau einen Bearbeitungsbereich", () => {
  assert.equal(panelForTarget({ kind: "field", field: "salon.city" }), "salon");
  assert.equal(panelForTarget({ kind: "field", field: "copy.heroTitle" }), "copy");
  assert.equal(panelForTarget({ kind: "field", field: "theme.primary" }), "design");
  assert.equal(panelForTarget({ kind: "field", field: "testimonials.enabled" }), "voices");
  assert.equal(panelForTarget({ kind: "service", serviceClientId: "s", field: "name" }), "services");
  assert.equal(panelForTarget({ kind: "testimonial", testimonialClientId: "t", field: "quote" }), "voices");
  assert.equal(panelForTarget({ kind: "staff", staffClientId: "p", field: "bio" }), "team");
  assert.equal(panelForTarget({ kind: "panel", panel: "publish" }), "publish");
});

test("Regionen sind eine geschlossene Liste", () => {
  assert.equal(isPreviewRegion("details"), true);
  assert.equal(isPreviewRegion("offers"), false);
  assert.equal(isPreviewRegion(7), false);
});

test("nur ein echter http-Ursprung darf als Ziel-Origin dienen", () => {
  assert.equal(resolveParentOrigin("https://builder.example"), "https://builder.example");
  assert.equal(resolveParentOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  // A file:// page and an opaque origin have nothing the child could name; only there is "*" allowed.
  assert.equal(resolveParentOrigin("null"), "*");
  assert.equal(resolveParentOrigin("file://"), "*");
  assert.equal(resolveParentOrigin(undefined), "*");
});

test("jede Nachrichtenart wird einzeln geprüft statt pauschal geglaubt", () => {
  assert.ok(parseReadyMessage(envelope({ action: "ready" }), "i-1", 2));
  assert.equal(parseReadyMessage(envelope({ action: "fertig" }), "i-1", 2), null);

  assert.ok(parseUpdateResult(envelope({ action: "update-result", requestId: "r", success: true }), "i-1", 2));
  assert.equal(parseUpdateResult(envelope({ action: "update-result", requestId: 5, success: true }), "i-1", 2), null);
  assert.equal(parseUpdateResult(envelope({ action: "update-result", requestId: "r", success: false, reason: "erfunden" }), "i-1", 2), null);
  assert.ok(parseUpdateResult(envelope({ action: "update-result", requestId: "r", success: false, reason: "invalid-region" }), "i-1", 2));

  assert.ok(parseNavigateMessage(envelope({ action: "navigate-to-editor", target: { kind: "panel", panel: "hours" } }), "i-1", 2));
  assert.equal(parseNavigateMessage(envelope({ action: "navigate-to-editor", target: { kind: "panel", panel: "nirgendwo" } }), "i-1", 2), null);

  assert.ok(parseScrollMessage(envelope({ action: "preview-scroll", position: { section: "top", offsetWithinSection: 0, fallbackScrollY: 0 } }), "i-1", 2));
  assert.equal(parseScrollMessage(envelope({ action: "preview-scroll", position: { section: "top", offsetWithinSection: "x", fallbackScrollY: 0 } }), "i-1", 2), null);
  assert.equal(parseScrollMessage(envelope({ action: "preview-scroll" }), "i-1", 2), null);
});
