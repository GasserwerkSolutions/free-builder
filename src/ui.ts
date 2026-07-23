import type { DraftRepository, DraftLoadResult } from "./persistence.js";
import { navigateToEditorTarget } from "./preview-navigation.js";
import { PreviewRuntime } from "./preview-runtime.js";
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

export class BuilderUi {
  private readonly context: UiContext;
  private readonly onMessage = (event: MessageEvent): void => { this.context.preview?.handleMessage(event); };

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
    });
    this.context.preview = preview;
    preview.start();
    updateReadiness(this.context);
    updateMigrationNotice(this.context);
    // Every accepted change is handed to the preview as a revision, not as "something changed": the
    // preview decides for itself whether that revision can be patched in or needs a rebuild.
    this.context.store.subscribe((_draft, mutation) => {
      preview.enqueue(mutation);
      updateReadiness(this.context);
      updateMigrationNotice(this.context);
    });
    this.context.store.subscribeSave((state, error) => renderSaveState(this.context, state, error));
    document.addEventListener("click", (event) => handleClick(this.context, event));
    document.addEventListener("input", (event) => handleInput(this.context, event));
    document.addEventListener("change", (event) => handleInput(this.context, event));
    window.addEventListener("message", this.onMessage);
    window.addEventListener("pagehide", () => {
      void this.context.store.flush().catch((error) => console.error("Final draft flush failed.", error));
    });
    if (options.migratedFromV1) showToast("Dein bisheriger Entwurf wurde sicher auf das neue Speicherformat migriert.");
    if (options.recovered) showToast("Der frühere Entwurf war beschädigt. Ein neuer lokaler Entwurf wurde angelegt.");
  }

  /** Release the preview timers and the message listener. Used by tests and by a future teardown. */
  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    this.context.preview?.destroy();
    this.context.preview = null;
  }
}
