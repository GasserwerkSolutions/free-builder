import type { BuilderDraftV2 } from "./domain.js";
import type { DraftCollection } from "./draft-mutations.js";
import type { PreviewTarget } from "./preview-contract.js";
import { adjacentReorderIndex, moveArrayItem, pointerInsertionIndex, type ReorderDirection } from "./reorder-core.js";
import { renderServices, renderTestimonials } from "./ui-render.js";
import { announce, cssEscape, historyDescriptor, safeMutate, type UiContext } from "./ui-shared.js";
import { renderTeam } from "./team-ui.js";

// Reordering services, people and voices — with the arrow buttons, with Alt + arrow key and by drag.
//
// All three ways end in the same call, and that call goes through the verified mutation layer with a
// `move-collection-item` intent. So a reorder is not a special case of the editor: it is checked like
// every other change, it lands in the undo history like every other change, and the preview learns
// about it through the same protocol. Nothing here reorders sections or writes a new draft field —
// the order of a collection is already the order of its array.

export type ReorderTarget = { collection: DraftCollection; clientId: string };
/** Which control a finished move hands the focus back to — the one the user actually operated. */
type ReorderFocus = "handle" | "up" | "down";

const STALE_DRAG_MESSAGE = "Die Liste hat sich während des Verschiebens geändert. Das Verschieben wurde abgebrochen.";

type ActiveDrag = {
  pointerId: number;
  target: ReorderTarget;
  item: HTMLElement;
  container: HTMLElement;
  handle: HTMLElement;
  originalIndex: number;
  targetIndex: number;
};

type CollectionSurface = {
  /** The card element of one item, and where its client id sits. */
  cardSelector: string;
  clientIdOf: (card: HTMLElement) => string;
  items: (draft: Readonly<BuilderDraftV2>) => readonly { clientId: string }[];
  move: (draft: BuilderDraftV2, fromIndex: number, toIndex: number) => void;
  label: (draft: Readonly<BuilderDraftV2>, clientId: string) => string;
  historyTarget: (clientId: string) => PreviewTarget;
  render: (context: UiContext) => void;
  cardFor: (clientId: string) => string;
};

// The one place that knows how each reorderable collection is addressed on the surface and in the
// draft. Every function below stays collection-agnostic.
const SURFACES: Record<DraftCollection, CollectionSurface> = {
  services: {
    cardSelector: "[data-service-card]",
    clientIdOf: (card) => card.dataset.serviceId ?? "",
    items: (draft) => draft.services,
    move: (draft, fromIndex, toIndex) => { moveArrayItem(draft.services, fromIndex, toIndex); },
    label: (draft, clientId) => `Leistung „${draft.services.find((item) => item.clientId === clientId)?.name.trim() || "Ohne Namen"}“`,
    historyTarget: (clientId) => ({ kind: "service", serviceClientId: clientId, field: "name" }),
    render: (context) => renderServices(context),
    cardFor: (clientId) => `[data-service-card][data-service-id="${cssEscape(clientId)}"]`,
  },
  staff: {
    cardSelector: "[data-staff-card]",
    clientIdOf: (card) => card.dataset.staffId ?? "",
    items: (draft) => draft.staff,
    move: (draft, fromIndex, toIndex) => { moveArrayItem(draft.staff, fromIndex, toIndex); },
    label: (draft, clientId) => `Person „${draft.staff.find((item) => item.clientId === clientId)?.name.trim() || "Ohne Namen"}“`,
    historyTarget: (clientId) => ({ kind: "staff", staffClientId: clientId, field: "name" }),
    render: (context) => renderTeam(context.store),
    cardFor: (clientId) => `[data-staff-card][data-staff-id="${cssEscape(clientId)}"]`,
  },
  testimonials: {
    cardSelector: "[data-testimonial-card]",
    clientIdOf: (card) => card.dataset.testimonialId ?? "",
    items: (draft) => draft.testimonials.items,
    move: (draft, fromIndex, toIndex) => { moveArrayItem(draft.testimonials.items, fromIndex, toIndex); },
    label: (draft, clientId) => `Kundenstimme „${draft.testimonials.items.find((item) => item.clientId === clientId)?.name.trim() || "Ohne Namen"}“`,
    historyTarget: (clientId) => ({ kind: "testimonial", testimonialClientId: clientId, field: "quote" }),
    render: (context) => renderTestimonials(context),
    cardFor: (clientId) => `[data-testimonial-card][data-testimonial-id="${cssEscape(clientId)}"]`,
  },
};

const CARD_SELECTOR = Object.values(SURFACES).map((surface) => surface.cardSelector).join(", ");
const activeDrags = new WeakMap<UiContext, ActiveDrag>();

/** Returns true when the click belonged to a reorder control, whether or not it moved anything. */
export function handleReorderClick(context: UiContext, element: Element): boolean {
  const button = element.closest<HTMLElement>("[data-reorder-direction]");
  if (!button) return false;
  const direction = button.dataset.reorderDirection;
  const target = resolveReorderTarget(button);
  if (!target || (direction !== "up" && direction !== "down")) return true;
  // The focus goes back to the arrow that was pressed, not to the handle: pressing "down" twice in a
  // row is the most ordinary keyboard reorder there is, and it has to work without re-aiming.
  stepReorder(context, target, direction, direction);
  return true;
}

/** Alt + arrow moves the focused handle; Escape aborts a running drag. */
export function handleReorderKeydown(context: UiContext, event: KeyboardEvent): boolean {
  if (event.key === "Escape" && activeDrags.has(context)) {
    event.preventDefault();
    cancelActiveDrag(context, "Verschieben abgebrochen.");
    return true;
  }
  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return false;
  const handle = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-reorder-handle]") : null;
  if (!handle) return false;
  const target = resolveReorderTarget(handle);
  if (!target) return false;
  event.preventDefault();
  stepReorder(context, target, event.key === "ArrowUp" ? "up" : "down");
  return true;
}

export function handleReorderPointerDown(context: UiContext, event: PointerEvent): boolean {
  if (event.button !== 0) return false;
  const handle = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-reorder-handle]") : null;
  if (!handle) return false;
  const target = resolveReorderTarget(handle);
  const item = handle.closest<HTMLElement>(CARD_SELECTOR);
  const container = item?.parentElement ?? null;
  if (!target || !item || !container || itemCount(context, target) < 2) return true;
  const originalIndex = itemIndex(context, target);
  if (originalIndex < 0) return true;
  cancelActiveDrag(context);
  activeDrags.set(context, { pointerId: event.pointerId, target, item, container, handle, originalIndex, targetIndex: originalIndex });
  item.classList.add("is-dragging");
  handle.classList.add("is-dragging-handle");
  try { handle.setPointerCapture(event.pointerId); } catch { /* a browser without pointer capture still works */ }
  announce(context, `${label(context, target)} wird verschoben. Ziehe an die neue Position oder drücke Escape.`);
  event.preventDefault();
  return true;
}

export function handleReorderPointerMove(context: UiContext, event: PointerEvent): boolean {
  const drag = activeDrags.get(context);
  if (!drag || drag.pointerId !== event.pointerId) return false;
  if (!dragIsLive(drag)) { cancelActiveDrag(context, STALE_DRAG_MESSAGE); return true; }
  const candidates = reorderItems(drag.container).filter((item) => item !== drag.item);
  drag.targetIndex = pointerInsertionIndex(event.clientY, candidates.map((item) => {
    const rect = item.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  }));
  clearDropMarkers(drag.container);
  if (candidates.length) {
    if (drag.targetIndex < candidates.length) candidates[drag.targetIndex]?.classList.add("is-drop-target-before");
    else candidates.at(-1)?.classList.add("is-drop-target-after");
  }
  event.preventDefault();
  return true;
}

export function handleReorderPointerEnd(context: UiContext, event: PointerEvent, cancelled = false): boolean {
  const drag = activeDrags.get(context);
  if (!drag || drag.pointerId !== event.pointerId) return false;
  if (!dragIsLive(drag)) { cancelActiveDrag(context, STALE_DRAG_MESSAGE); event.preventDefault(); return true; }
  const { target, targetIndex, originalIndex } = drag;
  cleanupDrag(context, drag);
  releasePointerCapture(drag);
  if (cancelled) announce(context, "Verschieben abgebrochen.");
  else if (targetIndex === originalIndex) announce(context, "Reihenfolge unverändert.");
  else moveReorderTarget(context, target, targetIndex);
  event.preventDefault();
  return true;
}

/**
 * A pointer capture the browser takes back ends the gesture: no pointerup will follow, so the drag
 * can never be finished and must not stay on the surface as if it could.
 */
export function handleReorderPointerLost(context: UiContext, event: PointerEvent, message: string): void {
  const drag = activeDrags.get(context);
  if (!drag || drag.pointerId !== event.pointerId) return;
  cancelActiveDrag(context, message);
}

/**
 * Is the card this drag started on still the card the list is showing?
 *
 * A list can be rebuilt while a drag runs — an Alt + arrow step, an undo, a removal elsewhere. The
 * dragged element is then detached, `candidates` no longer excludes it and every index the drop would
 * compute is about a list that no longer exists. That produced a silently wrong position with no
 * error and no toast, so the drag ends here instead of guessing.
 */
function dragIsLive(drag: ActiveDrag): boolean {
  return drag.item.isConnected && drag.container.isConnected && drag.container.contains(drag.item);
}

/**
 * The single write path of this module: verify the move as a `move-collection-item`, re-render the
 * list and put the focus back on the handle of the card that just moved.
 */
export function moveReorderTarget(context: UiContext, target: ReorderTarget, nextIndex: number, focus: ReorderFocus = "handle"): boolean {
  const surface = SURFACES[target.collection];
  const currentIndex = itemIndex(context, target);
  const count = itemCount(context, target);
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= count || currentIndex === nextIndex) return false;
  const movedLabel = label(context, target);
  // A move is always its own undo step, never grouped with the typing that happened just before it.
  context.store.flushHistoryGroup();
  const mutation = safeMutate(
    context.store,
    (draft) => surface.move(draft, currentIndex, nextIndex),
    {
      intent: { type: "move-collection-item", collection: target.collection, clientId: target.clientId },
      history: historyDescriptor(`${movedLabel} verschoben`, { target: surface.historyTarget(target.clientId) }),
    },
  );
  surface.render(context);
  if (!mutation) return false;
  announce(context, `${movedLabel} an Position ${nextIndex + 1} von ${count} verschoben.`);
  focusAfterMove(surface.cardFor(target.clientId), focus);
  return true;
}

function stepReorder(context: UiContext, target: ReorderTarget, direction: ReorderDirection, focus: ReorderFocus = "handle"): void {
  const nextIndex = adjacentReorderIndex(itemIndex(context, target), direction, itemCount(context, target));
  if (nextIndex !== null) moveReorderTarget(context, target, nextIndex, focus);
}

function resolveReorderTarget(element: Element): ReorderTarget | null {
  const card = element.closest<HTMLElement>(CARD_SELECTOR);
  if (!card) return null;
  for (const [collection, surface] of Object.entries(SURFACES) as [DraftCollection, CollectionSurface][]) {
    if (!card.matches(surface.cardSelector)) continue;
    const clientId = surface.clientIdOf(card);
    return clientId ? { collection, clientId } : null;
  }
  return null;
}

function itemIndex(context: UiContext, target: ReorderTarget): number {
  return SURFACES[target.collection].items(context.store.snapshot).findIndex((item) => item.clientId === target.clientId);
}
function itemCount(context: UiContext, target: ReorderTarget): number {
  return SURFACES[target.collection].items(context.store.snapshot).length;
}
function label(context: UiContext, target: ReorderTarget): string {
  return SURFACES[target.collection].label(context.store.snapshot, target.clientId);
}

/**
 * Put the focus back on the control the move came from. At the end of a list that control is disabled
 * — an arrow that can no longer point anywhere — so the handle of the same card takes over rather than
 * letting the focus fall back to the document.
 */
function focusAfterMove(cardSelector: string, preferred: ReorderFocus): void {
  const card = document.querySelector<HTMLElement>(cardSelector);
  if (!card) return;
  const arrow = preferred === "handle" ? null : card.querySelector<HTMLButtonElement>(`[data-reorder-direction="${preferred}"]`);
  const handle = card.querySelector<HTMLButtonElement>("[data-reorder-handle]");
  const destination = arrow && !arrow.disabled ? arrow : handle && !handle.disabled ? handle : null;
  destination?.focus({ preventScroll: true });
}

function reorderItems(container: HTMLElement): HTMLElement[] {
  return [...container.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches(CARD_SELECTOR));
}
function clearDropMarkers(container: HTMLElement): void {
  reorderItems(container).forEach((item) => item.classList.remove("is-drop-target-before", "is-drop-target-after"));
}
function releasePointerCapture(drag: ActiveDrag): void {
  try { drag.handle.releasePointerCapture(drag.pointerId); } catch { /* see setPointerCapture above */ }
}
// The registration goes first: releasing a pointer capture makes the browser fire lostpointercapture,
// and that listener must find no drag left to cancel a second time.
function cleanupDrag(context: UiContext, drag: ActiveDrag): void {
  activeDrags.delete(context);
  drag.item.classList.remove("is-dragging");
  drag.handle.classList.remove("is-dragging-handle");
  clearDropMarkers(drag.container);
}
export function cancelActiveDrag(context: UiContext, message?: string): void {
  const drag = activeDrags.get(context);
  if (!drag) return;
  cleanupDrag(context, drag);
  releasePointerCapture(drag);
  if (message) announce(context, message);
}
