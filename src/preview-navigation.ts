import { isPreviewTarget, panelForTarget, type PreviewTarget } from "./preview-contract.js";
import { ensureEditorOpen } from "./sidebar.js";
import { showPanel } from "./ui-render.js";
import { announce, cssEscape, type UiContext } from "./ui-shared.js";

const HIGHLIGHT_MS = 1_800;
const highlightTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * A click in the preview — or an entry in the publish list, or an undone step — opens the field that
 * produced it.
 *
 * The target arrives from a sandboxed document, so it is treated as a claim, not a fact: the panel is
 * derived from the shape and the element only from a target the current draft still contains. A stale
 * target (the service was deleted a moment ago) opens the right panel and says so, instead of doing
 * nothing or focusing the wrong card.
 */
export function navigateToEditorTarget(context: UiContext, target: PreviewTarget): void {
  const stillExists = isPreviewTarget(target, context.store.snapshot);
  const panel = panelForTarget(target);
  // Focusing a field behind a collapsed sidebar or behind the mobile preview would put the caret
  // somewhere the user cannot see, so the surface is made reachable first.
  ensureEditorOpen(context);
  showPanel(context, panel);
  const element = stillExists ? resolveEditorTarget(target) : null;
  const destination = element ?? document.querySelector<HTMLElement>(`[data-panel="${panel}"] h1, [data-panel="${panel}"] h2`);
  if (!destination) return;
  if (destination.matches("h1, h2")) destination.tabIndex = -1;
  destination.focus({ preventScroll: true });
  destination.scrollIntoView({ block: "center" });
  const running = highlightTimers.get(destination);
  if (running) clearTimeout(running);
  destination.classList.remove("is-preview-target");
  void destination.offsetWidth;
  destination.classList.add("is-preview-target");
  highlightTimers.set(destination, setTimeout(() => {
    destination.classList.remove("is-preview-target");
    highlightTimers.delete(destination);
  }, HIGHLIGHT_MS));
  announce(context, stillExists ? "Das passende Bearbeitungsfeld ist geöffnet." : "Der gewählte Eintrag ist nicht mehr vorhanden. Der passende Bereich wurde geöffnet.");
}

/** Where a preview target lives on the editing surface. Read-only: it never mutates the draft. */
export function resolveEditorTarget(target: PreviewTarget): HTMLElement | null {
  if (target.kind === "field") return document.querySelector<HTMLElement>(`[data-bind="${cssEscape(target.field)}"]`);
  if (target.kind === "service") return document.querySelector<HTMLElement>(`[data-service-card][data-service-id="${cssEscape(target.serviceClientId)}"] [data-service-field="${target.field}"]`);
  if (target.kind === "testimonial") return document.querySelector<HTMLElement>(`[data-testimonial-card][data-testimonial-id="${cssEscape(target.testimonialClientId)}"] [data-testimonial-field="${target.field}"]`);
  if (target.kind === "staff") return document.querySelector<HTMLElement>(`[data-staff-card][data-staff-id="${cssEscape(target.staffClientId)}"] [data-staff-field="${target.field}"]`);
  return document.querySelector<HTMLElement>(`[data-panel="${target.panel}"] h1, [data-panel="${target.panel}"] h2`);
}
