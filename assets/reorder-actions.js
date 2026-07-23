import { adjacentReorderIndex, moveArrayItem, pointerInsertionIndex } from "./reorder-core.js";
import { renderServices, renderTestimonials } from "./ui-render.js";
import { announce, cssEscape, historyDescriptor, safeMutate } from "./ui-shared.js";
import { renderTeam } from "./team-ui.js";
const STALE_DRAG_MESSAGE = "Die Liste hat sich während des Verschiebens geändert. Das Verschieben wurde abgebrochen.";
// The one place that knows how each reorderable collection is addressed on the surface and in the
// draft. Every function below stays collection-agnostic.
const SURFACES = {
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
const activeDrags = new WeakMap();
/** Returns true when the click belonged to a reorder control, whether or not it moved anything. */
export function handleReorderClick(context, element) {
    const button = element.closest("[data-reorder-direction]");
    if (!button)
        return false;
    const direction = button.dataset.reorderDirection;
    const target = resolveReorderTarget(button);
    if (!target || (direction !== "up" && direction !== "down"))
        return true;
    // The focus goes back to the arrow that was pressed, not to the handle: pressing "down" twice in a
    // row is the most ordinary keyboard reorder there is, and it has to work without re-aiming.
    stepReorder(context, target, direction, direction);
    return true;
}
/** Alt + arrow moves the focused handle; Escape aborts a running drag. */
export function handleReorderKeydown(context, event) {
    if (event.key === "Escape" && activeDrags.has(context)) {
        event.preventDefault();
        cancelActiveDrag(context, "Verschieben abgebrochen.");
        return true;
    }
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown"))
        return false;
    const handle = event.target instanceof Element ? event.target.closest("[data-reorder-handle]") : null;
    if (!handle)
        return false;
    const target = resolveReorderTarget(handle);
    if (!target)
        return false;
    event.preventDefault();
    stepReorder(context, target, event.key === "ArrowUp" ? "up" : "down");
    return true;
}
export function handleReorderPointerDown(context, event) {
    if (event.button !== 0)
        return false;
    const handle = event.target instanceof Element ? event.target.closest("[data-reorder-handle]") : null;
    if (!handle)
        return false;
    const target = resolveReorderTarget(handle);
    const item = handle.closest(CARD_SELECTOR);
    const container = item?.parentElement ?? null;
    if (!target || !item || !container || itemCount(context, target) < 2)
        return true;
    const originalIndex = itemIndex(context, target);
    if (originalIndex < 0)
        return true;
    cancelActiveDrag(context);
    activeDrags.set(context, { pointerId: event.pointerId, target, item, container, handle, originalIndex, targetIndex: originalIndex });
    item.classList.add("is-dragging");
    handle.classList.add("is-dragging-handle");
    try {
        handle.setPointerCapture(event.pointerId);
    }
    catch { /* a browser without pointer capture still works */ }
    announce(context, `${label(context, target)} wird verschoben. Ziehe an die neue Position oder drücke Escape.`);
    event.preventDefault();
    return true;
}
export function handleReorderPointerMove(context, event) {
    const drag = activeDrags.get(context);
    if (!drag || drag.pointerId !== event.pointerId)
        return false;
    if (!dragIsLive(drag)) {
        cancelActiveDrag(context, STALE_DRAG_MESSAGE);
        return true;
    }
    const candidates = reorderItems(drag.container).filter((item) => item !== drag.item);
    drag.targetIndex = pointerInsertionIndex(event.clientY, candidates.map((item) => {
        const rect = item.getBoundingClientRect();
        return { top: rect.top, height: rect.height };
    }));
    clearDropMarkers(drag.container);
    if (candidates.length) {
        if (drag.targetIndex < candidates.length)
            candidates[drag.targetIndex]?.classList.add("is-drop-target-before");
        else
            candidates.at(-1)?.classList.add("is-drop-target-after");
    }
    event.preventDefault();
    return true;
}
export function handleReorderPointerEnd(context, event, cancelled = false) {
    const drag = activeDrags.get(context);
    if (!drag || drag.pointerId !== event.pointerId)
        return false;
    if (!dragIsLive(drag)) {
        cancelActiveDrag(context, STALE_DRAG_MESSAGE);
        event.preventDefault();
        return true;
    }
    const { target, targetIndex, originalIndex } = drag;
    cleanupDrag(context, drag);
    releasePointerCapture(drag);
    if (cancelled)
        announce(context, "Verschieben abgebrochen.");
    else if (targetIndex === originalIndex)
        announce(context, "Reihenfolge unverändert.");
    else
        moveReorderTarget(context, target, targetIndex);
    event.preventDefault();
    return true;
}
/**
 * A pointer capture the browser takes back ends the gesture: no pointerup will follow, so the drag
 * can never be finished and must not stay on the surface as if it could.
 */
export function handleReorderPointerLost(context, event, message) {
    const drag = activeDrags.get(context);
    if (!drag || drag.pointerId !== event.pointerId)
        return;
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
function dragIsLive(drag) {
    return drag.item.isConnected && drag.container.isConnected && drag.container.contains(drag.item);
}
/**
 * The single write path of this module: verify the move as a `move-collection-item`, re-render the
 * list and put the focus back on the handle of the card that just moved.
 */
export function moveReorderTarget(context, target, nextIndex, focus = "handle") {
    const surface = SURFACES[target.collection];
    const currentIndex = itemIndex(context, target);
    const count = itemCount(context, target);
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= count || currentIndex === nextIndex)
        return false;
    const movedLabel = label(context, target);
    // A move is always its own undo step, never grouped with the typing that happened just before it.
    context.store.flushHistoryGroup();
    const mutation = safeMutate(context.store, (draft) => surface.move(draft, currentIndex, nextIndex), {
        intent: { type: "move-collection-item", collection: target.collection, clientId: target.clientId },
        history: historyDescriptor(`${movedLabel} verschoben`, { target: surface.historyTarget(target.clientId) }),
    });
    surface.render(context);
    if (!mutation)
        return false;
    announce(context, `${movedLabel} an Position ${nextIndex + 1} von ${count} verschoben.`);
    focusAfterMove(surface.cardFor(target.clientId), focus);
    return true;
}
function stepReorder(context, target, direction, focus = "handle") {
    const nextIndex = adjacentReorderIndex(itemIndex(context, target), direction, itemCount(context, target));
    if (nextIndex !== null)
        moveReorderTarget(context, target, nextIndex, focus);
}
function resolveReorderTarget(element) {
    const card = element.closest(CARD_SELECTOR);
    if (!card)
        return null;
    for (const [collection, surface] of Object.entries(SURFACES)) {
        if (!card.matches(surface.cardSelector))
            continue;
        const clientId = surface.clientIdOf(card);
        return clientId ? { collection, clientId } : null;
    }
    return null;
}
function itemIndex(context, target) {
    return SURFACES[target.collection].items(context.store.snapshot).findIndex((item) => item.clientId === target.clientId);
}
function itemCount(context, target) {
    return SURFACES[target.collection].items(context.store.snapshot).length;
}
function label(context, target) {
    return SURFACES[target.collection].label(context.store.snapshot, target.clientId);
}
/**
 * Put the focus back on the control the move came from. At the end of a list that control is disabled
 * — an arrow that can no longer point anywhere — so the handle of the same card takes over rather than
 * letting the focus fall back to the document.
 */
function focusAfterMove(cardSelector, preferred) {
    const card = document.querySelector(cardSelector);
    if (!card)
        return;
    const arrow = preferred === "handle" ? null : card.querySelector(`[data-reorder-direction="${preferred}"]`);
    const handle = card.querySelector("[data-reorder-handle]");
    const destination = arrow && !arrow.disabled ? arrow : handle && !handle.disabled ? handle : null;
    destination?.focus({ preventScroll: true });
}
function reorderItems(container) {
    return [...container.children].filter((child) => child instanceof HTMLElement && child.matches(CARD_SELECTOR));
}
function clearDropMarkers(container) {
    reorderItems(container).forEach((item) => item.classList.remove("is-drop-target-before", "is-drop-target-after"));
}
function releasePointerCapture(drag) {
    try {
        drag.handle.releasePointerCapture(drag.pointerId);
    }
    catch { /* see setPointerCapture above */ }
}
// The registration goes first: releasing a pointer capture makes the browser fire lostpointercapture,
// and that listener must find no drag left to cancel a second time.
function cleanupDrag(context, drag) {
    activeDrags.delete(context);
    drag.item.classList.remove("is-dragging");
    drag.handle.classList.remove("is-dragging-handle");
    clearDropMarkers(drag.container);
}
export function cancelActiveDrag(context, message) {
    const drag = activeDrags.get(context);
    if (!drag)
        return;
    cleanupDrag(context, drag);
    releasePointerCapture(drag);
    if (message)
        announce(context, message);
}
