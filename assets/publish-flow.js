import { runPublishPreflight, sameStamp } from "./publish-preflight.js";
export function initialPublishState() {
    return { phase: "ready", blocks: [], stopCode: null, stopDetail: null, submittedAt: null, submittedRevision: null, staleSinceSubmit: false };
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
    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.state);
        return () => this.listeners.delete(listener);
    }
    /**
     * Restore what an earlier session already handed over. Only the two facts that are true without
     * asking the server: when it happened, and which revision it was.
     */
    restoreSubmission(submittedAt, submittedRevision) {
        if (this.inFlight)
            return;
        this.patch({ phase: "submitted", blocks: [], stopCode: null, stopDetail: null, submittedAt, submittedRevision, staleSinceSubmit: this.host.readStamp().revision !== submittedRevision });
    }
    setEmail(value) {
        this.email = value;
        // Typing a correction is the start of a new attempt, so the previous refusal stops standing in
        // front of it. A completed hand-over is a fact and is NOT cleared by editing the address.
        if (this.state.phase === "blocked" || this.state.phase === "failed") {
            this.patch({ phase: "ready", blocks: [], stopCode: null, stopDetail: null });
        }
    }
    /** Every accepted draft change is offered here, so a hand-over can go stale while it is on screen. */
    noteDraftChanged() {
        if (this.state.submittedRevision === null)
            return;
        const stale = this.host.readStamp().revision !== this.state.submittedRevision;
        if (stale !== this.state.staleSinceSubmit)
            this.patch({ staleSinceSubmit: stale });
    }
    async submit() {
        // The rate limit is address-independent by design, so a double click has to be swallowed here —
        // there is no server-side forgiveness for spending an attempt twice on the same intent.
        if (this.inFlight)
            return this.state;
        this.inFlight = true;
        try {
            const stamp = this.host.readStamp();
            this.patch({ phase: "checking", blocks: [], stopCode: null, stopDetail: null });
            const preflight = runPublishPreflight({ draft: this.host.readDraft(), email: this.email, stamp });
            if (!preflight.ok)
                return this.patch({ phase: "blocked", blocks: preflight.blocks });
            // Hand over only a draft that is durably stored locally. If the user edits during that write,
            // the stamp moves and the run is abandoned before anything is sent — the same rule the export
            // preflight applies, for the same reason: the artefact must match the state it was checked in.
            await this.host.flush();
            if (!sameStamp(this.host.readStamp(), stamp)) {
                return this.patch({ phase: "failed", stopCode: "DRAFT_CHANGED", stopDetail: null });
            }
            this.patch({ phase: "sending" });
            const outcome = await this.host.send(preflight.request);
            if (!outcome.ok)
                return this.patch({ phase: "failed", stopCode: outcome.code, stopDetail: outcome.detail });
            // The request went out and was accepted. If the draft moved while it was in flight, that
            // cannot be undone — so it is reported as what it is: handed over, and already superseded.
            const stale = !sameStamp(this.host.readStamp(), stamp);
            return this.patch({
                phase: "submitted",
                blocks: [],
                stopCode: null,
                stopDetail: null,
                submittedAt: this.host.now(),
                submittedRevision: stamp.revision,
                staleSinceSubmit: stale,
            });
        }
        catch (error) {
            // The host threw where it should have returned an outcome. Report it rather than leaving the
            // flow stuck in "sending" forever.
            return this.patch({ phase: "failed", stopCode: "NETWORK", stopDetail: error instanceof Error ? error.message : null });
        }
        finally {
            this.inFlight = false;
        }
    }
    patch(changes) {
        this.state = { ...this.state, ...changes };
        this.listeners.forEach((listener) => listener(this.state));
        return this.state;
    }
}
