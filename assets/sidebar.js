import { ensureMobileEditMode } from "./mobile-modes.js";
import { readPreference, writePreference } from "./ui-shared.js";
// Collapsing the editing surface so the preview can have the screen — and remembering that choice.
//
// Deliberately not ported: the reference also lets the user drag the surface wider. A second width
// control is one decision more for a salon owner and nothing the preview needs, so this stage ships
// only the one state that matters: open or out of the way.
const COLLAPSED_KEY = "gasserwerk-salon-sidebar-collapsed-v1";
export function initSidebar(context) {
    const onToggle = () => setSidebarCollapsed(context, !isCollapsed(context));
    setSidebarCollapsed(context, readPreference(COLLAPSED_KEY) === "true", false);
    context.sidebarToggle.addEventListener("click", onToggle);
    return () => context.sidebarToggle.removeEventListener("click", onToggle);
}
/** Whatever else is going on, make sure the editing surface is actually reachable. */
export function ensureEditorOpen(context) {
    ensureMobileEditMode(context);
    if (isCollapsed(context))
        setSidebarCollapsed(context, false);
}
export function isCollapsed(context) {
    return context.controlSurface.classList.contains("is-collapsed");
}
export function setSidebarCollapsed(context, collapsed, persist = true) {
    context.controlSurface.classList.toggle("is-collapsed", collapsed);
    context.workspace.classList.toggle("is-sidebar-collapsed", collapsed);
    context.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    const title = collapsed ? "Bearbeitungsfläche ausklappen" : "Bearbeitungsfläche einklappen";
    context.sidebarToggle.title = title;
    const label = context.sidebarToggle.querySelector(".visually-hidden");
    if (label)
        label.textContent = title;
    const arrow = context.sidebarToggle.querySelector("[aria-hidden]");
    if (arrow)
        arrow.textContent = collapsed ? "›" : "‹";
    context.surfaceStage.setAttribute("aria-hidden", String(collapsed));
    // A collapsed surface must not keep the focus inside itself, where nothing is visible any more.
    if (collapsed && context.surfaceStage.contains(document.activeElement))
        context.sidebarToggle.focus();
    if (persist)
        writePreference(COLLAPSED_KEY, String(collapsed));
}
