import { MOBILE_MODE_MEDIA, ensureMobileEditMode, isMobileModeActive } from "./mobile-modes.js";
import { readPreference, writePreference } from "./ui-shared.js";
// Collapsing the editing surface so the preview can have the screen — and remembering that choice.
//
// Deliberately not ported: the reference also lets the user drag the surface wider. A second width
// control is one decision more for a salon owner and nothing the preview needs, so this stage ships
// only the one state that matters: open or out of the way.
const COLLAPSED_KEY = "gasserwerk-salon-sidebar-collapsed-v1";
// The remembered wish, per editor instance. It survives a trip below the mobile breakpoint, where it
// deliberately has no effect at all.
const collapseWish = new WeakMap();
export function initSidebar(context) {
    const onToggle = () => setSidebarCollapsed(context, !isCollapseWished(context));
    // Crossing the breakpoint is not a reload: narrowing the window, rotating a tablet or opening a
    // split screen all change what the media query answers while the editor keeps running.
    const media = typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_MODE_MEDIA) : null;
    const onMediaChange = () => applySidebarState(context);
    setSidebarCollapsed(context, readPreference(COLLAPSED_KEY) === "true", false);
    context.sidebarToggle.addEventListener("click", onToggle);
    media?.addEventListener("change", onMediaChange);
    return () => {
        context.sidebarToggle.removeEventListener("click", onToggle);
        media?.removeEventListener("change", onMediaChange);
    };
}
/** Whatever else is going on, make sure the editing surface is actually reachable. */
export function ensureEditorOpen(context) {
    ensureMobileEditMode(context);
    // Below the breakpoint the collapsed state already has no effect; overwriting the remembered
    // desktop wish there would throw away a choice the user made at a different window size.
    if (!isMobileModeActive() && isCollapseWished(context))
        setSidebarCollapsed(context, false);
}
/** Whether the editing surface is collapsed right now. Always false below the mobile breakpoint. */
export function isCollapsed(context) {
    return context.controlSurface.classList.contains("is-collapsed");
}
export function setSidebarCollapsed(context, collapsed, persist = true) {
    collapseWish.set(context, collapsed);
    if (persist)
        writePreference(COLLAPSED_KEY, String(collapsed));
    applySidebarState(context);
}
function isCollapseWished(context) {
    return collapseWish.get(context) === true;
}
/**
 * Put the remembered wish on the surface — or deliberately not.
 *
 * Below the mobile breakpoint a collapsed editor has nothing left to collapse into: the stage, the
 * expand button and the section navigation are all display:none there, so "Bearbeiten" would show an
 * empty strip between the header and the mode bar with no visible way out. The wish is therefore
 * remembered but not applied, and it takes effect again as soon as the window is wide enough for the
 * two columns.
 */
function applySidebarState(context) {
    const collapsed = isCollapseWished(context) && !isMobileModeActive();
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
}
