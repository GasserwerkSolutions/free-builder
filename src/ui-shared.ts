import type { DraftRepository } from "./persistence.js";
import type { BuilderStore } from "./store.js";

export type UiContext = {
  store: BuilderStore;
  repository: DraftRepository;
  surfaceCard: HTMLElement;
  previewFrame: HTMLIFrameElement;
  previewHint: HTMLElement;
  saveStatus: HTMLElement;
  serviceList: HTMLElement;
  testimonialList: HTMLElement;
  hoursList: HTMLElement;
  readinessList: HTMLElement;
  serviceTemplate: HTMLTemplateElement;
  testimonialTemplate: HTMLTemplateElement;
  previewTimer: ReturnType<typeof setTimeout> | null;
  volatileStorage: boolean;
};

function requiredElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`MISSING_ELEMENT:${id}`);
  return element as unknown as T;
}

export function createUiContext(store: BuilderStore, repository: DraftRepository): UiContext {
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

export function getAtPath(object: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
  object);
}

export function setAtPath(object: object, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop();
  if (!last) return;
  let target = object as Record<string, unknown>;
  for (const key of keys) {
    const next = target[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error(`INVALID_BIND_PATH:${path}`);
    target = next as Record<string, unknown>;
  }
  if (!(last in target)) throw new Error(`UNKNOWN_BIND_PATH:${path}`);
  target[last] = value;
}

export function inputValue(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | boolean {
  return input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
}
