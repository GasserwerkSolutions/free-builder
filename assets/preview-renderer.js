import { cloneDraft } from "./domain.js";
import { buildWebsiteHtml } from "./website.js";
/**
 * Cut the requested regions out of a full render.
 *
 * This is what keeps the preview honest: a patched region is not hand-built markup, it is the very
 * same buildWebsiteHtml output the export uses, sliced apart. A region that is not in that output
 * (because the draft no longer produces it) throws — and the caller answers a throw with a full
 * rebuild, which is the correct reaction to a section that has just disappeared.
 */
export function renderPreviewRegions(regions, draft, options) {
    const html = buildWebsiteHtml(cloneDraft(draft), {
        preview: true,
        previewInstanceId: options.previewInstanceId,
        parentOrigin: options.parentOrigin,
        previewScroll: options.previewScroll,
        previewRevision: options.revision,
        renderGeneration: options.renderGeneration,
    });
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const rendered = new Map();
    for (const region of new Set(regions)) {
        const matches = [...parsed.querySelectorAll("[data-preview-region]")].filter((element) => element.dataset.previewRegion === region);
        const only = matches.length === 1 ? matches[0] : undefined;
        if (!only)
            throw new Error(`PREVIEW_REGION_RENDER_FAILED:${region}`);
        rendered.set(region, only.outerHTML);
    }
    return rendered;
}
