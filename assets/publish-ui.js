import { escapeAttr, escapeHtml } from "./domain.js";
import { sendPublishIntent } from "./publish-client.js";
import { MAX_PUBLISH_PAYLOAD_BYTES } from "./publish-contract.js";
import { PublishFlow } from "./publish-flow.js";
import { stampOf } from "./publish-preflight.js";
import { readPreference, writePreference } from "./ui-shared.js";
// The publish surface.
//
// It says exactly what the endpoint gives it and nothing more. The success answer is the constant
// `{ ok: true }` from the anti-enumeration rule, so this surface may not claim that an account now
// exists, that an e-mail was delivered, or that a website is live. What it may claim is what actually
// happened here: a copy of the draft was handed over at a point in time.
//
// The second honesty duty is less obvious and easier to get wrong: the draft is UPLOADED at that
// moment. Everything the user edits afterwards stays in this browser. Nothing pushes it across, and
// the builder has no channel to update an intent it does not even have an id for. Hiding that would
// leave people editing for an hour and wondering why the confirmation mail shows an older salon.
const SUBMISSION_PREFIX = "gasserwerk-salon-publish-v1:";
/**
 * Wire the publish flow to the surface. Returns the teardown, so a destroyed editor leaves no
 * listener behind — the same contract the sidebar and the mobile modes follow.
 */
export function installPublishUi(context, options = {}) {
    const elements = findElements();
    if (!elements)
        return () => { };
    const now = options.now ?? (() => new Date().toISOString());
    const flow = new PublishFlow({
        readDraft: () => context.store.snapshot,
        readStamp: () => stampOf(context.store),
        flush: () => context.store.flush(),
        send: (request) => sendPublishIntent(request, options),
        now,
    });
    const unsubscribeFlow = flow.subscribe((state) => render(elements, flow.address, state));
    // Every accepted draft change can turn a completed hand-over into an outdated one.
    const unsubscribeStore = context.store.subscribe(() => flow.noteDraftChanged());
    const onClick = (event) => {
        const target = event.target;
        if (!(target instanceof Element))
            return;
        const button = target.closest("[data-publish-action]");
        if (!button)
            return;
        const action = button.dataset.publishAction;
        if (action !== "submit" && action !== "retry")
            return;
        void runSubmit(flow, elements, context);
    };
    const onInput = (event) => {
        if (event.target === elements.email)
            flow.setEmail(elements.email.value);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onInput);
    restoreSubmission(flow, context.store.snapshot);
    return () => {
        document.removeEventListener("click", onClick);
        document.removeEventListener("input", onInput);
        document.removeEventListener("change", onInput);
        unsubscribeFlow();
        unsubscribeStore();
    };
}
async function runSubmit(flow, elements, context) {
    const state = await flow.submit();
    if (state.phase === "submitted" && state.submittedAt && state.submittedRevision !== null) {
        rememberSubmission(context.store.snapshot, state.submittedAt, state.submittedRevision);
    }
    // A refused attempt has to land somewhere the user can act: on the address, or on the first open
    // entry of the list they were already looking at.
    if (state.phase === "blocked") {
        const emailBlock = state.blocks.find((block) => block.code === "EMAIL_MISSING" || block.code === "EMAIL_INVALID");
        if (emailBlock) {
            elements.email.focus();
            return;
        }
    }
}
/**
 * Bring back the one fact an earlier session established without asking the server: that a copy was
 * handed over, and which revision it was.
 *
 * This is deliberately NOT written into `draft.publication`. That block mirrors the SERVER's intent
 * lifecycle (`intentId`, `EMAIL_SENT`, `VERIFIED`, …) and the builder holds none of it: the neutral
 * answer returns no intent id and does not say whether a mail went out. Filling those fields would
 * be inventing server state, so they stay untouched — and the local timestamp lives in the same
 * preference channel that already carries remembered UI state. No token, no image, no draft field.
 */
function restoreSubmission(flow, draft) {
    const raw = readPreference(SUBMISSION_PREFIX + draft.draftId);
    if (!raw)
        return;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null)
            return;
        const { at, revision } = parsed;
        if (typeof at !== "string" || typeof revision !== "number")
            return;
        flow.restoreSubmission(at, revision);
    }
    catch { /* a damaged note is simply no note */ }
}
function rememberSubmission(draft, at, revision) {
    writePreference(SUBMISSION_PREFIX + draft.draftId, JSON.stringify({ at, revision }));
}
function findElements() {
    const panel = document.querySelector('[data-panel="publish"]');
    const email = document.getElementById("publishEmail");
    const submit = document.getElementById("publishButton");
    const retry = document.getElementById("publishRetry");
    const status = document.getElementById("publishStatus");
    if (!panel || !(email instanceof HTMLInputElement) || !(submit instanceof HTMLButtonElement) || !(retry instanceof HTMLButtonElement) || !status)
        return null;
    return { panel, email, submit, retry, status };
}
// --- rendering ----------------------------------------------------------------------------------
const SUBMIT_LABELS = {
    ready: "Website veröffentlichen",
    checking: "Wird geprüft …",
    sending: "Wird übergeben …",
    submitted: "Erneut senden",
    blocked: "Website veröffentlichen",
    failed: "Website veröffentlichen",
};
function render(elements, address, state) {
    const busy = state.phase === "checking" || state.phase === "sending";
    elements.submit.disabled = busy;
    elements.submit.textContent = SUBMIT_LABELS[state.phase];
    elements.submit.setAttribute("aria-busy", String(busy));
    elements.retry.hidden = state.phase !== "failed";
    elements.status.className = `publish-status is-${state.phase}`;
    elements.status.innerHTML = statusHtml(address, state);
}
function statusHtml(address, state) {
    if (state.phase === "ready") {
        return note("Bereit", "Sobald du auf „Website veröffentlichen“ tippst, wird dein Entwurf einmalig übergeben und du bekommst eine Nachricht.");
    }
    if (state.phase === "checking")
        return note("Wird geprüft", "Der Entwurf wird gegen die offenen Punkte und die Grössengrenze geprüft.");
    if (state.phase === "sending")
        return note("Wird übergeben", "Der Entwurf ist unterwegs. Bitte nichts anklicken, bis eine Antwort da ist.");
    if (state.phase === "blocked")
        return blockedHtml(state.blocks);
    if (state.phase === "failed")
        return failedHtml(state.stopCode, state.stopDetail);
    return submittedHtml(address, state);
}
/**
 * The end of the builder. It has to be exact:
 *
 *   * "übergeben" — that is what `{ ok: true }` confirms.
 *   * "falls diese Adresse verwendbar ist" — the answer is identical for an address that already has
 *     an account, so no delivery may be promised.
 *   * the uploaded state is named with its timestamp, because everything after it is local only.
 */
function submittedHtml(address, state) {
    const when = formatMoment(state.submittedAt);
    const target = address.trim();
    const lines = [
        `<strong>Abgeschickt${when ? ` am ${escapeHtml(when)}` : ""}</strong>`,
        `<span>Dein Entwurf wurde übergeben. Falls diese Adresse verwendbar ist, ist eine Nachricht${target ? ` an ${escapeHtml(target)}` : ""} unterwegs. Ob wirklich eine E-Mail verschickt wurde, bestätigt der Server bewusst nicht — das schützt fremde Konten davor, hier erraten zu werden.</span>`,
        `<span>Schau in dein Postfach, auch im Spam-Ordner. Der nächste Schritt passiert dort: erst dein Klick auf den Bestätigungslink legt Konto und Website an.</span>`,
    ];
    if (state.staleSinceSubmit) {
        lines.push(`<span class="publish-status__warn"><strong>Deine späteren Änderungen sind noch nicht drüben.</strong> Übergeben wurde der Stand von vorhin; alles, was du danach bearbeitet hast, liegt nur in diesem Browser. „Erneut senden“ übergibt den aktuellen Stand — du bekommst dann eine weitere Nachricht.</span>`);
    }
    return lines.join("");
}
function blockedHtml(blocks) {
    const items = blocks.map((block) => `<li>${blockHtml(block)}</li>`).join("");
    return `<strong>Noch nicht abgeschickt</strong><span>Das hält den Versand auf:</span><ul class="publish-status__list">${items}</ul>`;
}
function blockHtml(block) {
    if (block.code === "EMAIL_MISSING")
        return "Trag deine E-Mail-Adresse ein. Ohne sie gibt es keinen Bestätigungslink und damit keinen Zugang.";
    if (block.code === "EMAIL_INVALID")
        return "Diese E-Mail-Adresse ist so nicht verwendbar. Prüfe sie auf Tippfehler — ohne zustellbare Adresse kommt der Bestätigungslink nicht an.";
    if (block.code === "PAYLOAD_TOO_LARGE") {
        return `Der Entwurf ist mit ${formatKilobytes(block.bytes)} zu gross; erlaubt sind ${formatKilobytes(block.limit)}. Kürze die längsten Texte — meist sind es Beschreibungen und Kundenstimmen.`;
    }
    if (block.code === "BINARY_IN_DRAFT") {
        return `Im Entwurf stecken Bilddaten (${escapeHtml(block.paths.join(", "))}), die auf diesem Weg nicht übergeben werden können. Bilder werden erst nach der Bestätigung hochgeladen.`;
    }
    const count = block.count;
    return `${count} ${count === 1 ? "Punkt ist" : "Punkte sind"} noch offen. Sie stehen oben in der Liste, jeder Eintrag führt direkt ins zuständige Feld. `
        + `<button class="text-button" type="button" data-editor-target="${escapeAttr(JSON.stringify(block.first.target))}">Zum ersten offenen Punkt: ${escapeHtml(block.first.title)}</button>`;
}
/**
 * One message per failure, and every one of them says what to do next. "Ungültige Eingabe" on its own
 * is exactly the dead end this table exists to replace.
 */
const STOP_MESSAGES = {
    DRAFT_CHANGED: {
        title: "Abgebrochen — nichts wurde gesendet",
        detail: "Während der Prüfung hat sich dein Entwurf geändert, deshalb wurde die Übergabe abgebrochen. Es ist nichts verloren gegangen und nichts angekommen. Tippe einfach nochmals auf Veröffentlichen.",
    },
    PAYLOAD_TOO_LARGE: {
        title: "Zu gross für die Übergabe",
        detail: `Der Server nimmt höchstens ${formatKilobytes(MAX_PUBLISH_PAYLOAD_BYTES)} entgegen. Kürze die längsten Texte — Beschreibungen, Einleitung, Kundenstimmen — und versuche es erneut.`,
    },
    MALFORMED_REQUEST: {
        title: "Der Server konnte die Anfrage nicht lesen",
        detail: "Das ist ein Fehler auf unserer Seite, nicht an deinen Angaben. Lade die Seite neu und versuche es noch einmal; dein Entwurf bleibt lokal vollständig gespeichert.",
    },
    SCHEMA_REJECTED: {
        title: "Der Server hat den Inhalt abgelehnt",
        detail: "Meist steckt eine Angabe dahinter, die zwar ausgefüllt, aber nicht verwendbar ist. Prüfe E-Mail-Adresse und Telefonnummer im Bereich „Salon“ sowie Dauer und Preis deiner Leistungen, und versuche es dann erneut.",
    },
    RATE_LIMITED: {
        title: "Zu viele Versuche",
        detail: "Es wurden in kurzer Zeit zu viele Anfragen gestellt. Warte ein paar Minuten und versuche es dann erneut. Die Sperre gilt bewusst unabhängig von der Adresse — sie sagt nichts über dein Konto aus.",
    },
    SERVER_ERROR: {
        title: "Der Server hatte ein Problem",
        detail: "Es liegt nicht an deinem Entwurf. Versuche es in ein paar Minuten erneut; bleibt es dabei, melde dich bei uns.",
    },
    NETWORK: {
        title: "Keine Verbindung",
        detail: "Die Anfrage hat den Server nicht erreicht. Prüfe deine Internetverbindung und versuche es erneut. Dein Entwurf ist lokal gespeichert und vollständig.",
    },
    TIMEOUT: {
        title: "Keine Antwort in der erwarteten Zeit",
        detail: "Ob deine Übergabe noch angekommen ist, lässt sich von hier aus nicht sagen. Warte ein paar Minuten und schau in dein Postfach — erst wenn dort nichts ankommt, versuche es erneut.",
    },
    UNEXPECTED_RESPONSE: {
        title: "Unerwartete Antwort",
        detail: "Der Server hat etwas zurückgegeben, das der Builder nicht deuten kann. Es wurde nichts bestätigt. Versuche es erneut; bleibt es dabei, melde dich bei uns.",
    },
};
function failedHtml(code, detail) {
    const message = code ? STOP_MESSAGES[code] : { title: "Nicht abgeschickt", detail: "Der Vorgang wurde nicht abgeschlossen." };
    const technical = detail ? `<span class="publish-status__technical">Technische Angabe: ${escapeHtml(detail)}</span>` : "";
    return `<strong>${escapeHtml(message.title)}</strong><span>${escapeHtml(message.detail)}</span>${technical}`;
}
function note(title, detail) {
    return `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
}
function formatKilobytes(bytes) {
    return `${Math.round(bytes / 1024)} KB`;
}
function formatMoment(iso) {
    if (!iso)
        return null;
    const value = new Date(iso);
    if (Number.isNaN(value.getTime()))
        return null;
    try {
        return new Intl.DateTimeFormat("de-CH", { dateStyle: "medium", timeStyle: "short" }).format(value);
    }
    catch {
        return value.toISOString();
    }
}
