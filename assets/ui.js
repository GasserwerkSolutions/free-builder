import { closeSectionSheet, initMobileModes, isMobileModeActive, isSectionSheetOpen, markPreviewReturnAvailable } from "./mobile-modes.js";
import { navigateToEditorTarget } from "./preview-navigation.js";
import { PreviewRuntime } from "./preview-runtime.js";
import { cancelActiveDrag, handleReorderKeydown, handleReorderPointerDown, handleReorderPointerEnd, handleReorderPointerLost, handleReorderPointerMove } from "./reorder-actions.js";
import { initSidebar } from "./sidebar.js";
import { handleClick, handleInput, stepHistory } from "./ui-actions.js";
import { bindStaticInputs, renderDynamicControls, renderSaveState, updateMigrationNotice, updateReadiness, } from "./ui-render.js";
import { createUiContext, isNavigatedField, markNavigatedField, releaseNavigatedField, showToast } from "./ui-shared.js";
const PREVIEW_STATUS_MESSAGES = {
    stale: "Die Vorschau antwortet nicht mehr und zeigt nicht mehr deinen aktuellen Stand. Deine Änderungen sind gespeichert — mit der nächsten Änderung wird die Vorschau erneut aufgebaut.",
    live: "Die Vorschau ist wieder aktuell.",
};
// Controls that own a text caret. Inside one of them the browser has its own undo stack, and taking
// Ctrl/Cmd + Z away from it would be a regression for the most ordinary thing a user does: fix a typo
// while typing. A native text undo produces an ordinary input event, so it reaches the draft through
// the normal path and the two histories cannot drift apart.
//
// Date and time controls are deliberately NOT in here. They look like inputs but hold a set of spin
// fields, not a text caret, and no browser keeps a text history for them — leaving Ctrl + Z to the
// browser there would make the key dead in the whole opening-hours editor.
const TEXT_ENTRY_SELECTOR = 'textarea, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="file"])'
    + ':not([type="time"]):not([type="date"]):not([type="datetime-local"]):not([type="month"]):not([type="week"])';
const DRAG_INTERRUPTED_MESSAGE = "Verschieben abgebrochen.";
export class BuilderUi {
    context;
    // Every listener is kept as one stable reference, because destroy() can only take back a listener
    // it can still name.
    onMessage = (event) => { this.handlePreviewMessage(event); };
    onClick = (event) => { handleClick(this.context, event); };
    onInput = (event) => { releaseNavigatedField(event.target); handleInput(this.context, event); };
    onKeydown = (event) => { this.handleKeydown(event); };
    onPointerDown = (event) => { handleReorderPointerDown(this.context, event); };
    onPointerMove = (event) => { handleReorderPointerMove(this.context, event); };
    onPointerUp = (event) => { handleReorderPointerEnd(this.context, event); };
    onPointerCancel = (event) => { handleReorderPointerEnd(this.context, event, true); };
    // A drag only ever ends through a pointer event — and those stop arriving as soon as the window
    // loses the pointer: an alt-tab, a tab switch, a capture the browser takes back. Without these three
    // the card would keep its dragging state, the drop marker would stay on the list and the next click
    // anywhere would still be answering a gesture the user abandoned minutes ago.
    onWindowBlur = () => { cancelActiveDrag(this.context, DRAG_INTERRUPTED_MESSAGE); };
    onVisibilityChange = () => { if (document.hidden)
        cancelActiveDrag(this.context, DRAG_INTERRUPTED_MESSAGE); };
    onLostPointerCapture = (event) => { handleReorderPointerLost(this.context, event, DRAG_INTERRUPTED_MESSAGE); };
    onPageHide = () => {
        void this.context.store.flush().catch((error) => console.error("Final draft flush failed.", error));
    };
    unsubscribeDraft = null;
    unsubscribeSave = null;
    unsubscribeHistory = null;
    teardownSidebar = null;
    teardownMobile = null;
    constructor(store, repository) {
        this.context = createUiContext(store, repository);
    }
    /** The live preview, once init() has built it. Read-only access for tests and diagnostics. */
    get previewRuntime() { return this.context.preview; }
    init(options) {
        this.context.volatileStorage = Boolean(options.volatileStorage);
        this.teardownSidebar = initSidebar(this.context);
        this.teardownMobile = initMobileModes(this.context);
        bindStaticInputs(this.context);
        renderDynamicControls(this.context);
        const preview = new PreviewRuntime({
            frame: this.context.previewFrame,
            readDraft: () => this.context.store.snapshot,
            readRevision: () => this.context.store.revision,
            onNavigate: (target) => {
                // On a phone the tap came from the preview, which is now about to disappear behind the
                // editing surface. Offer the way back instead of stranding the user in the form.
                const fromMobilePreview = isMobileModeActive() && this.context.mobileMode === "preview";
                navigateToEditorTarget(this.context, target);
                if (fromMobilePreview)
                    markPreviewReturnAvailable();
            },
            // A preview that stopped answering is not allowed to fail silently: it says so through the one
            // message channel the editor has, so nobody keeps editing against a picture that stands still.
            onStatus: (status) => showToast(PREVIEW_STATUS_MESSAGES[status]),
        });
        this.context.preview = preview;
        preview.start();
        updateReadiness(this.context);
        updateMigrationNotice(this.context);
        // Every accepted change is handed to the preview as a revision, not as "something changed": the
        // preview decides for itself whether that revision can be patched in or needs a rebuild.
        this.unsubscribeDraft = this.context.store.subscribe((_draft, mutation) => {
            preview.enqueue(mutation);
            updateReadiness(this.context);
            updateMigrationNotice(this.context);
        });
        this.unsubscribeSave = this.context.store.subscribeSave((state, error) => renderSaveState(this.context, state, error));
        this.unsubscribeHistory = this.context.store.subscribeHistory((state) => renderHistoryState(this.context, state));
        document.addEventListener("click", this.onClick);
        document.addEventListener("input", this.onInput);
        document.addEventListener("change", this.onInput);
        document.addEventListener("keydown", this.onKeydown);
        document.addEventListener("pointerdown", this.onPointerDown);
        document.addEventListener("pointermove", this.onPointerMove);
        document.addEventListener("pointerup", this.onPointerUp);
        document.addEventListener("pointercancel", this.onPointerCancel);
        document.addEventListener("lostpointercapture", this.onLostPointerCapture);
        document.addEventListener("visibilitychange", this.onVisibilityChange);
        window.addEventListener("blur", this.onWindowBlur);
        window.addEventListener("message", this.onMessage);
        window.addEventListener("pagehide", this.onPageHide);
        if (options.migratedFromV1)
            showToast("Dein bisheriger Entwurf wurde sicher auf das neue Speicherformat migriert.");
        if (options.recovered)
            showToast("Der frühere Entwurf war beschädigt. Ein neuer lokaler Entwurf wurde angelegt.");
    }
    /**
     * Give back everything init() took: the document/window listeners, the store subscriptions, the
     * sidebar and mobile-mode listeners, the preview timers and the live region that was created on
     * demand. After this the instance holds nothing that could still fire.
     */
    destroy() {
        document.removeEventListener("click", this.onClick);
        document.removeEventListener("input", this.onInput);
        document.removeEventListener("change", this.onInput);
        document.removeEventListener("keydown", this.onKeydown);
        document.removeEventListener("pointerdown", this.onPointerDown);
        document.removeEventListener("pointermove", this.onPointerMove);
        document.removeEventListener("pointerup", this.onPointerUp);
        document.removeEventListener("pointercancel", this.onPointerCancel);
        document.removeEventListener("lostpointercapture", this.onLostPointerCapture);
        document.removeEventListener("visibilitychange", this.onVisibilityChange);
        window.removeEventListener("blur", this.onWindowBlur);
        window.removeEventListener("message", this.onMessage);
        window.removeEventListener("pagehide", this.onPageHide);
        cancelActiveDrag(this.context);
        markNavigatedField(null);
        this.unsubscribeDraft?.();
        this.unsubscribeDraft = null;
        this.unsubscribeSave?.();
        this.unsubscribeSave = null;
        this.unsubscribeHistory?.();
        this.unsubscribeHistory = null;
        this.teardownSidebar?.();
        this.teardownSidebar = null;
        this.teardownMobile?.();
        this.teardownMobile = null;
        this.context.preview?.destroy();
        this.context.preview = null;
        document.getElementById("previewAnnouncer")?.remove();
    }
    handlePreviewMessage(event) { this.context.preview?.handleMessage(event); }
    handleKeydown(event) {
        if (handleReorderKeydown(this.context, event))
            return;
        // The bottom sheet is modal. The only key it answers is the one that closes it — anything else
        // would change a draft the user cannot see behind it.
        if (isSectionSheetOpen()) {
            if (event.key === "Escape") {
                event.preventDefault();
                closeSectionSheet(this.context);
            }
            return;
        }
        if (event.defaultPrevented || event.altKey)
            return;
        if (!(event.ctrlKey || event.metaKey))
            return;
        const key = event.key.toLowerCase();
        // Ctrl + Y is the second learned redo on Windows. Cmd + Y is "show history" on macOS and stays
        // with the browser, so the modifier is checked rather than assumed.
        const redoByY = key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey;
        const direction = key === "z" ? (event.shiftKey ? "redo" : "undo") : redoByY ? "redo" : null;
        if (!direction)
            return;
        // Inside a text control the browser's own undo wins — but only once the user has actually typed
        // there. A field the editor just jumped into has an empty browser history, and leaving the key to
        // it would turn every second Ctrl + Z into a no-op. See TEXT_ENTRY_SELECTOR and isNavigatedField.
        const textEntry = event.target instanceof Element ? event.target.closest(TEXT_ENTRY_SELECTOR) : null;
        if (textEntry && !isNavigatedField(textEntry))
            return;
        event.preventDefault();
        stepHistory(this.context, direction);
    }
}
/**
 * The two history buttons say what they would undo, not just that they can. The label is the same
 * one the toast uses afterwards, so nothing is announced twice under two different names.
 */
function renderHistoryState(context, state) {
    describeHistoryButton(context.undoButton, "Rückgängig", state.canUndo, state.undoAction?.label ?? null, "Strg oder Cmd + Z");
    describeHistoryButton(context.redoButton, "Wiederholen", state.canRedo, state.redoAction?.label ?? null, "Umschalt + Strg oder Cmd + Z");
}
function describeHistoryButton(button, direction, enabled, label, shortcut) {
    button.disabled = !enabled;
    const description = label ? `${direction}: ${label}` : direction;
    button.setAttribute("aria-label", `${description} (${shortcut})`);
    button.title = `${description} (${shortcut})`;
}
