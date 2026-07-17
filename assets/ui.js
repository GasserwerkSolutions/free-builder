import { handleClick, handleInput } from "./ui-actions.js";
import { bindStaticInputs, renderDynamicControls, renderPreview, renderSaveState, schedulePreview, showToast, updateMigrationNotice, updateReadiness, } from "./ui-render.js";
import { createUiContext } from "./ui-shared.js";
export class BuilderUi {
    context;
    constructor(store, repository) {
        this.context = createUiContext(store, repository);
    }
    init(options) {
        this.context.volatileStorage = Boolean(options.volatileStorage);
        bindStaticInputs(this.context);
        renderDynamicControls(this.context);
        renderPreview(this.context);
        updateReadiness(this.context);
        updateMigrationNotice(this.context);
        this.context.store.subscribe(() => {
            schedulePreview(this.context);
            updateReadiness(this.context);
            updateMigrationNotice(this.context);
        });
        this.context.store.subscribeSave((state, error) => renderSaveState(this.context, state, error));
        document.addEventListener("click", (event) => handleClick(this.context, event));
        document.addEventListener("input", (event) => handleInput(this.context, event));
        document.addEventListener("change", (event) => handleInput(this.context, event));
        window.addEventListener("pagehide", () => {
            void this.context.store.flush().catch((error) => console.error("Final draft flush failed.", error));
        });
        if (options.migratedFromV1)
            showToast("Dein bisheriger Entwurf wurde sicher auf das neue Speicherformat migriert.");
        if (options.recovered)
            showToast("Der frühere Entwurf war beschädigt. Ein neuer lokaler Entwurf wurde angelegt.");
    }
}
