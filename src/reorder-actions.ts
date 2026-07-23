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
  stepReorder(context, target, direction);
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
  const { target, targetIndex, originalIndex } = drag;
  releasePointerCapture(drag);
  cleanupDrag(context, drag);
  if (cancelled) announce(context, "Verschieben abgebrochen.");
  else if (targetIndex === originalIndex) announce(context, "Reihenfolge unverändert.");
  else moveReorderTarget(context, target, targetIndex);
  event.preventDefault();
  return true;
}

/**
 * The single write path of this module: verify the move as a `move-collection-item`, re-render the
 * list and put the focus back on the handle of the card that just moved.
 */
export function moveReorderTarget(context: UiContext, target: ReorderTarget, nextIndex: number): boolean {
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
  focusHandle(surface.cardFor(target.clientId));
  return true;
}

function stepReorder(context: UiContext, target: ReorderTarget, direction: ReorderDirection): void {
  const nextIndex = adjacentReorderIndex(itemIndex(context, target), direction, itemCount(context, target));
  if (nextIndex !== null) moveReorderTarget(context, target, nextIndex);
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

function focusHandle(cardSelector: string): void {
  const handle = document.querySelector<HTMLButtonElement>(`${cardSelector} [data-reorder-handle]`);
  if (handle && !handle.disabled) handle.focus({ preventScroll: true });
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
function cleanupDrag(context: UiContext, drag: ActiveDrag): void {
  drag.item.classList.remove("is-dragging");
  drag.handle.classList.remove("is-dragging-handle");
  clearDropMarkers(drag.container);
  activeDrags.delete(context);
}
export function cancelActiveDrag(context: UiContext, message?: string): void {
  const drag = activeDrags.get(context);
  if (!drag) return;
  releasePointerCapture(drag);
  cleanupDrag(context, drag);
  if (message) announce(context, message);
}
