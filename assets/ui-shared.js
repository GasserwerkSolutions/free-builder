function requiredElement(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`MISSING_ELEMENT:${id}`);
    return element;
}
export function createUiContext(store, repository) {
    return {
        store,
        repository,
        surfaceCard: requiredElement("surfaceCard"),
        previewFrame: requiredElement("previewFrame"),
        previewHint: requiredElement("previewHint"),
        saveStatus: requiredElement("saveStatus"),
        serviceList: requiredElement("serviceList"),
        testimonialList: requiredElement("testimonialList"),
        hoursList: requiredElement("hoursList"),
        readinessList: requiredElement("readinessList"),
        serviceTemplate: requiredElement("serviceTemplate"),
        testimonialTemplate: requiredElement("testimonialTemplate"),
        previewTimer: null,
        volatileStorage: false,
    };
}
export function getAtPath(object, path) {
    return path.split(".").reduce((value, key) => value && typeof value === "object" ? value[key] : undefined, object);
}
export function setAtPath(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    if (!last)
        return;
    let target = object;
    for (const key of keys) {
        const next = target[key];
        if (!next || typeof next !== "object" || Array.isArray(next))
            throw new Error(`INVALID_BIND_PATH:${path}`);
        target = next;
    }
    if (!(last in target))
        throw new Error(`UNKNOWN_BIND_PATH:${path}`);
    target[last] = value;
}
export function inputValue(input) {
    return input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
}
