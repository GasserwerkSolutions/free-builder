import type { DraftRepository, DraftLoadResult } from "./persistence.js";
import { navigateToEditorTarget } from "./preview-navigation.js";
import { PreviewRuntime, type PreviewStatus } from "./preview-runtime.js";
import type { BuilderStore } from "./store.js";
import { handleClick, handleInput } from "./ui-actions.js";
import {
  bindStaticInputs,
  renderDynamicControls,
  renderSaveState,
  updateMigrationNotice,
  updateReadiness,
} from "./ui-render.js";
import { createUiContext, showToast, type UiContext } from "./ui-shared.js";

const PREVIEW_STATUS_MESSAGES: Record<PreviewStatus, string> = {
  stale: "Die Vorschau antwortet nicht mehr und zeigt nicht mehr deinen aktuellen Stand. Deine Änderungen sind gespeichert — mit der nächsten Änderung wird die Vorschau erneut aufgebaut.",
  live: "Die Vorschau ist wieder aktuell.",
};

export class BuilderUi {
  private readonly context: UiContext;
  // Every listener is kept as one stable reference, because destroy() can only take back a listener
  // it can still name.
  private readonly onMessage = (event: MessageEvent): void => { this.context.preview?.handleMessage(event); };
  private readonly onClick = (event: Event): void => { handleClick(this.context, event); };
  private readonly onInput = (event: Event): void => { handleInput(this.context, event); };
  private readonly onPageHide = (): void => {
    void this.context.store.flush().catch((error) => console.error("Final draft flush failed.", error));
  };
  private unsubscribeDraft: (() => void) | null = null;
  private unsubscribeSave: (() => void) | null = null;

  constructor(store: BuilderStore, repository: DraftRepository) {
    this.context = createUiContext(store, repository);
  }

  /** The live preview, once init() has built it. Read-only access for tests and diagnostics. */
  get previewRuntime(): PreviewRuntime | null { return this.context.preview; }

  init(options: DraftLoadResult & { volatileStorage?: boolean }): void {
    this.context.volatileStorage = Boolean(options.volatileStorage);
    bindStaticInputs(this.context);
    renderDynamicControls(this.context);
    const preview = new PreviewRuntime({
      frame: this.context.previewFrame,
      readDraft: () => this.context.store.snapshot,
      readRevision: () => this.context.store.revision,
      onNavigate: (target) => navigateToEditorTarget(this.context, target),
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
    document.addEventListener("click", this.onClick);
    document.addEventListener("input", this.onInput);
    document.addEventListener("change", this.onInput);
    window.addEventListener("message", this.onMessage);
    window.addEventListener("pagehide", this.onPageHide);
    if (options.migratedFromV1) showToast("Dein bisheriger Entwurf wurde sicher auf das neue Speicherformat migriert.");
    if (options.recovered) showToast("Der frühere Entwurf war beschädigt. Ein neuer lokaler Entwurf wurde angelegt.");
  }

  /**
   * Give back everything init() took: the four document/window listeners, both store subscriptions,
   * the preview timers and the live region that was created on demand. After this the instance holds
   * nothing that could still fire.
   */
  destroy(): void {
    document.removeEventListener("click", this.onClick);
    document.removeEventListener("input", this.onInput);
    document.removeEventListener("change", this.onInput);
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("pagehide", this.onPageHide);
    this.unsubscribeDraft?.();
    this.unsubscribeDraft = null;
    this.unsubscribeSave?.();
    this.unsubscribeSave = null;
    this.context.preview?.destroy();
    this.context.preview = null;
    document.getElementById("previewAnnouncer")?.remove();
  }
}
