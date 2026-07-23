import { draftIdentity, sameDraftIdentity } from "./publish-identity.js";
import { runPublishPreflight, sameStamp } from "./publish-preflight.js";
/**
 * How long the surface locks itself after a 429 that came without a `Retry-After`.
 *
 * It is a local brake, not a guess at the server's window: it exists so a second tap cannot burn
 * another attempt, and the message it belongs to says plainly that the server did not name a time.
 */
export const RATE_LIMIT_FALLBACK_COOLDOWN_MS = 60_000;
export function initialPublishState() {
    return {
        phase: "ready", blocks: [], stopCode: null, stopDetail: null,
        submittedAt: null, submittedDraft: null, staleSinceSubmit: false,
        retryNotBefore: null, retryAfterMs: null, localCopySecured: false,
    };
}
export class PublishFlow {
    host;
    state = initialPublishState();
    listeners = new Set();
    inFlight = false;
    email = "";
    constructor(host) {
        this.host = host;
    }
    get snapshot() { return this.state; }
    get busy() { return this.inFlight; }
    get address() { return this.email; }
    /** True while a 429 lock still holds. The one reason a ready-looking surface refuses a click. */
    get rateLimited() {
        return this.state.retryNotBefore !== null && this.clock() < this.state.retryNotBefore;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.state);
        return () => this.listeners.delete(listener);
    }
    /**
     * Bring back what an earlier session handed over: when it happened, and which draft it was.
     *
     * The note names its owner, and a note for another draft is not restored at all — an imported or
     * freshly reset draft has no hand-over behind it, no matter what the previous one did.
     */
    restoreSubmission(submittedAt, submitted) {
        if (this.inFlight)
            return;
        const current = draftIdentity(this.host.readDraft());
        if (current.draftId !== submitted.draftId)
            return;
        this.patch({
            phase: "submitted", blocks: [], stopCode: null, stopDetail: null,
            submittedAt, submittedDraft: submitted, staleSinceSubmit: !sameDraftIdentity(submitted, current),
        });
    }
    setEmail(value) {
        this.email = value;
        // A rate limit outlives a typed correction. Clearing it here would replace the one message that
        // explains the wait with "Bereit" — and the next tap would spend another attempt for nothing.
        if (this.rateLimited)
            return;
        // Otherwise typing a correction is the start of a new attempt, so the previous refusal stops
        // standing in front of it. A completed hand-over is a fact and is NOT cleared by editing the address.
        if (this.state.phase === "blocked" || this.state.phase === "failed") {
            this.patch({ phase: "ready", blocks: [], stopCode: null, stopDetail: null, retryNotBefore: null, retryAfterMs: null });
        }
    }
    /**
     * The 429 lock has run out. Called by whoever watches the clock, so the surface offers the retry
     * again on its own instead of leaving the user in front of a button that never comes back.
     */
    refreshRateLimit() {
        if (this.state.retryNotBefore === null || this.rateLimited)
            return;
        this.patch({ retryNotBefore: null });
    }
    /** Every accepted draft change is offered here, so a hand-over can go stale while it is on screen. */
    noteDraftChanged() {
        const submitted = this.state.submittedDraft;
        if (submitted === null)
            return;
        const current = draftIdentity(this.host.readDraft());
        if (current.draftId !== submitted.draftId) {
            // An authoritative replacement (reset, import, recovery) put a DIFFERENT draft in place. The
            // hand-over belongs to the old one and says nothing about this one, so the surface goes back to
            // having nothing to claim rather than crediting a stranger with someone else's send.
            this.patch({
                phase: this.state.phase === "submitted" ? "ready" : this.state.phase,
                submittedAt: null, submittedDraft: null, staleSinceSubmit: false,
            });
            return;
        }
        const stale = !sameDraftIdentity(submitted, current);
        if (stale !== this.state.staleSinceSubmit)
            this.patch({ staleSinceSubmit: stale });
    }
    async submit() {
        // The rate limit is address-independent by design, so a double click has to be swallowed here —
        // there is no server-side forgiveness for spending an attempt twice on the same intent.
        if (this.inFlight)
            return this.state;
        // Same reasoning one step later: while the server's own lock holds, an attempt cannot succeed and
        // would only push the wait further out.
        if (this.rateLimited)
            return this.state;
        this.inFlight = true;
        try {
            const stamp = this.host.readStamp();
            this.patch({ phase: "checking", blocks: [], stopCode: null, stopDetail: null, localCopySecured: false });
            const preflight = runPublishPreflight({ draft: this.host.readDraft(), email: this.email, stamp });
            if (!preflight.ok)
                return this.patch({ phase: "blocked", blocks: preflight.blocks });
            // WHAT is being handed over is settled here, before the first await. Reading it afterwards
            // would attach the note to whatever draft happens to be in the store when the answer arrives —
            // a reset mid-flight would then make a brand new, empty draft claim someone else's send.
            const submitted = draftIdentity(this.host.readDraft());
            // Hand over only a draft that is durably stored locally. If the user edits during that write,
            // the stamp moves and the run is abandoned before anything is sent — the same rule the export
            // preflight applies, for the same reason: the artefact must match the state it was checked in.
            try {
                await this.host.flush();
            }
            catch (error) {
                // A refused local write is not a network problem. It is also the one moment where the surface
                // may not repeat its "your draft is stored here" line, so it gets its own code and its own
                // message instead of being folded into NETWORK.
                return this.patch({ phase: "failed", stopCode: "LOCAL_SAVE_FAILED", stopDetail: messageOf(error) });
            }
            // The local copy is now proven durable, and that fact travels with the next patch rather than
            // in one of its own: an extra notification would make listeners render a phase twice.
            if (!sameStamp(this.host.readStamp(), stamp)) {
                return this.patch({ phase: "failed", stopCode: "DRAFT_CHANGED", stopDetail: null, localCopySecured: true });
            }
            this.patch({ phase: "sending", localCopySecured: true });
            const outcome = await this.host.send(preflight.request);
            if (!outcome.ok)
                return this.failWith(outcome);
            // The request went out and was accepted. If the draft moved while it was in flight, that
            // cannot be undone — so it is reported as what it is: handed over, and already superseded.
            const current = draftIdentity(this.host.readDraft());
            const accepted = this.patch({
                phase: "submitted",
                blocks: [],
                stopCode: null,
                stopDetail: null,
                submittedAt: this.host.now(),
                submittedDraft: submitted,
                staleSinceSubmit: !sameDraftIdentity(submitted, current),
            });
            // If the draft was REPLACED while the request was in flight, the hand-over still happened and
            // is still worth remembering for the draft it belonged to — but the draft on screen is not that
            // one. noteDraftChanged() takes the claim off the new draft again; the caller keeps the record
            // it was handed here and files it under the right owner.
            this.noteDraftChanged();
            return accepted;
        }
        catch (error) {
            // The host threw where it should have returned an outcome. Report it rather than leaving the
            // flow stuck in "sending" forever.
            return this.patch({ phase: "failed", stopCode: "NETWORK", stopDetail: messageOf(error) });
        }
        finally {
            this.inFlight = false;
        }
    }
    /** Turn a refused answer into a stop — and, for a 429, into a wait the next click cannot skip. */
    failWith(outcome) {
        if (outcome.code !== "RATE_LIMITED") {
            return this.patch({ phase: "failed", stopCode: outcome.code, stopDetail: outcome.detail });
        }
        const said = typeof outcome.retryAfterMs === "number" && outcome.retryAfterMs > 0 ? outcome.retryAfterMs : null;
        return this.patch({
            phase: "failed",
            stopCode: "RATE_LIMITED",
            stopDetail: outcome.detail,
            retryAfterMs: said,
            retryNotBefore: this.clock() + (said ?? RATE_LIMIT_FALLBACK_COOLDOWN_MS),
        });
    }
    /** The flow's own clock, taken from the host so a test does not have to wait in real time. */
    clock() {
        const parsed = Date.parse(this.host.now());
        return Number.isNaN(parsed) ? Date.now() : parsed;
    }
    patch(changes) {
        this.state = { ...this.state, ...changes };
        this.listeners.forEach((listener) => listener(this.state));
        return this.state;
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : null;
}
