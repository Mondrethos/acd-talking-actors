import { localize, speechText } from "./libs/functions.js";

const MODULE_ID = "acd-talking-actors";
const FLAG = "speechStatus";
const FLAG_PATH = `flags.${MODULE_ID}.${FLAG}`;
const ACTIVE = new Set(["preparing", "receiving", "starting"]);
const TERMINAL = new Set(["complete", "failed", "skipped"]);
const CAPTURE_TIMEOUT = 30_000;
const STATUS_TIMEOUT = 5 * 60_000;
const FAILURE_TIMEOUT = 8_000;
const MAX_JOBS = 128;

const normalize = content => speechText(content ?? "").replace(/\s+/g, " ").trim();
const readFlag = message => message.getFlag?.(MODULE_ID, FLAG) ?? message.flags?.[MODULE_ID]?.[FLAG];

function validSnapshot(value) {
    return value && typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 128
        && (ACTIVE.has(value.stage) || TERMINAL.has(value.stage))
        && Number.isFinite(value.startedAt) && value.startedAt >= 0
        && Number.isFinite(value.updatedAt) && value.updatedAt >= value.startedAt;
}

function visibleSnapshot(snapshot, now = Date.now()) {
    if (!validSnapshot(snapshot)) return false;
    // Tolerate ordinary client clock skew, but never display a corrupt future-dated wait forever.
    if (snapshot.startedAt > now + STATUS_TIMEOUT || snapshot.updatedAt > now + STATUS_TIMEOUT) return false;
    if (snapshot.stage === "failed") return now - snapshot.updatedAt < FAILURE_TIMEOUT;
    return ACTIVE.has(snapshot.stage) && now - snapshot.startedAt < STATUS_TIMEOUT;
}

/** Transient narration feedback; chat content and the journal's native flavor stay untouched. */
export class SpeechStatus {
    constructor(logger) {
        this.logger = logger;
        this.jobs = new Map();
        this.views = new Map();
        this.hooks = [];
        this.timer = null;
    }

    registerHooks() {
        if (this.hooks.length) return;
        const register = (name, callback) => {
            const id = Hooks.on(name, (...args) => {
                try { callback(...args); }
                catch (error) { this.warn(error); }
            });
            this.hooks.push([name, id]);
        };
        register("preCreateChatMessage", (message, data, _options, userId) => this.capture(message, data, userId));
        register("createChatMessage", message => {
            const job = this.jobs.get(readFlag(message)?.requestId);
            if (job) void job.attach(message);
        });
        register("renderChatMessageHTML", (message, html) => this.render(message, html));
        register("updateChatMessage", message => {
            // Flag-only updates need not rerender the native card to refresh its footer.
            for (const view of [...this.views.values()]) {
                if (view.messageId === message.id) this.render(message, view.root);
            }
        });
        register("deleteChatMessage", message => this.removeMessage(message.id));
    }

    start(text, { capture = false } = {}) {
        // getRandomValues works on self-hosted HTTP, where randomUUID may be unavailable.
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        const id = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
        const startedAt = Date.now();
        const state = { requestId: id, stage: "preparing", startedAt, updatedAt: startedAt };
        const job = {
            id, state, message: null, disposed: false, writes: Promise.resolve(),
            captureUntil: capture ? startedAt + CAPTURE_TIMEOUT : 0,
            text: capture ? normalize(text) : null,
            finishedAt: null, awaitingCreate: false,
            snapshot: () => ({ ...state }),
            attach: message => {
                if (job.disposed || !message) return Promise.resolve();
                job.message = message;
                job.text = null;
                job.captureUntil = 0;
                job.awaitingCreate = false;
                return this.write(job);
            },
            update: stage => {
                if (job.disposed || !ACTIVE.has(stage) || TERMINAL.has(state.stage)) return Promise.resolve();
                if ([...ACTIVE].indexOf(stage) <= [...ACTIVE].indexOf(state.stage)) return Promise.resolve();
                state.stage = stage;
                state.updatedAt = Date.now();
                this.refresh(job);
                return this.write(job);
            },
            finish: (stage = "complete") => {
                if (job.disposed || !TERMINAL.has(stage) || TERMINAL.has(state.stage)) return Promise.resolve();
                state.stage = stage;
                state.updatedAt = Date.now();
                job.finishedAt = state.updatedAt;
                this.refresh(job);
                return this.write(job);
            }
        };
        this.jobs.set(id, job);
        while (this.jobs.size > MAX_JOBS) this.removeJob(this.jobs.values().next().value);
        this.ensureTimer();
        return job;
    }

    capture(message, data, userId) {
        if (userId !== game.user.id || readFlag(message)) return;
        const author = message.author?.id ?? message.user?.id ?? message.user ?? data?.user;
        if (typeof author === "string" && author !== userId) return;
        const now = Date.now();
        const text = normalize(message.content ?? data?.content);
        if (!text) return;
        // Insertion order selects one request, even for simultaneous identical passages.
        const job = [...this.jobs.values()].find(job => job.captureUntil > now && job.text === text);
        if (!job) return;
        job.captureUntil = 0;
        job.text = null;
        job.awaitingCreate = true;
        message.updateSource({ [FLAG_PATH]: job.snapshot() });
    }

    write(job) {
        const message = job.message;
        if (!message || job.disposed) return Promise.resolve();
        const snapshot = job.snapshot();
        // Stage writes are serialized so a slow "preparing" update cannot overwrite "complete".
        job.writes = job.writes.then(async () => {
            if (job.disposed || job.message !== message) return;
            const previous = readFlag(message);
            if (previous?.requestId === snapshot.requestId && previous.stage === snapshot.stage
                && previous.startedAt === snapshot.startedAt && previous.updatedAt === snapshot.updatedAt) return;
            await message.update({ [FLAG_PATH]: snapshot });
        }).catch(error => this.warn(error));
        return job.writes;
    }

    render(message, html) {
        const root = html?.querySelectorAll ? html : html?.[0];
        if (!root?.querySelectorAll) return;
        this.removeView(root);
        root.querySelectorAll(".acd-ta-speech-status").forEach(element => element.remove());
        if (message.visible === false || message.isContentVisible === false) return;
        const flag = readFlag(message);
        const snapshot = this.jobs.get(flag?.requestId)?.snapshot() ?? flag;
        if (!visibleSnapshot(snapshot)) return;
        const document = root.ownerDocument;
        const row = document.createElement("div");
        row.className = "acd-ta-speech-status";
        row.setAttribute("role", "status");
        row.setAttribute("aria-live", "polite");
        const label = document.createElement("span");
        label.className = "acd-ta-speech-status-label";
        const elapsed = document.createElement("span");
        elapsed.className = "acd-ta-speech-status-elapsed";
        elapsed.setAttribute("aria-hidden", "true");
        row.append(label, elapsed);
        root.append(row);
        const view = { root, row, label, elapsed, messageId: message.id, snapshot,
            createdAt: Date.now(), wasConnected: root.isConnected };
        this.views.set(root, view);
        this.updateView(view, snapshot);
        this.ensureTimer();
    }

    updateView(view, snapshot) {
        if (!visibleSnapshot(snapshot)) {
            this.removeView(view.root);
            return;
        }
        view.snapshot = snapshot;
        const failed = snapshot.stage === "failed";
        view.row.dataset.stage = snapshot.stage;
        const label = localize(`acd.ta.speechStatus.${snapshot.stage}`);
        if (view.label.textContent !== label) view.label.textContent = label;
        view.elapsed.hidden = failed;
        if (!failed) {
            const seconds = Math.max(0, Math.floor((Date.now() - snapshot.startedAt) / 1000));
            const key = "acd.ta.speechStatus.elapsed";
            view.elapsed.textContent = game.i18n.format ? game.i18n.format(key, { seconds })
                : localize(key).replace("{seconds}", String(seconds));
        }
        const bar = view.row.querySelector(".acd-ta-speech-status-bar");
        if (failed) bar?.remove();
        else if (!bar) {
            const line = view.root.ownerDocument.createElement("span");
            line.className = "acd-ta-speech-status-bar";
            line.setAttribute("aria-hidden", "true");
            view.row.append(line);
        }
    }

    refresh(job) {
        try {
            for (const view of this.views.values()) {
                if (view.snapshot.requestId === job.id) this.updateView(view, job.snapshot());
            }
        } catch (error) { this.warn(error); }
    }

    ensureTimer() {
        if (this.timer !== null) return;
        this.timer = setInterval(() => {
            try { this.tick(); }
            catch (error) { this.warn(error); }
        }, 1000);
        this.timer.unref?.();
    }

    tick() {
        const now = Date.now();
        for (const job of this.jobs.values()) {
            if (job.captureUntil && job.captureUntil <= now) {
                job.captureUntil = 0;
                job.text = null;
            }
            // Keep a terminal snapshot briefly to handle a native post arriving after audio finishes.
            if (now - job.state.startedAt >= STATUS_TIMEOUT
                || (!job.awaitingCreate && job.finishedAt !== null
                    && now - job.finishedAt >= CAPTURE_TIMEOUT)) this.removeJob(job);
        }
        for (const view of this.views.values()) {
            if (!view.row.isConnected && (view.wasConnected || now - view.createdAt > 5000)) {
                this.removeView(view.root);
                continue;
            }
            if (view.row.isConnected) view.wasConnected = true;
            this.updateView(view, view.snapshot);
        }
        if (!this.jobs.size && !this.views.size && this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    removeView(root) {
        this.views.get(root)?.row.remove();
        this.views.delete(root);
    }

    removeJob(job) {
        job.disposed = true;
        job.text = null;
        this.jobs.delete(job.id);
    }

    removeMessage(id) {
        if (!id) return;
        for (const job of this.jobs.values()) if (job.message?.id === id) this.removeJob(job);
        for (const view of this.views.values()) if (view.messageId === id) this.removeView(view.root);
        this.tick();
    }

    warn(error) {
        try { this.logger?.warn?.("Unable to update speech status:", error); }
        catch { /* Status reporting must not interrupt speech. */ }
    }

    destroy() {
        for (const [name, id] of this.hooks) Hooks.off(name, id);
        this.hooks = [];
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        for (const root of this.views.keys()) this.removeView(root);
        for (const job of this.jobs.values()) this.removeJob(job);
    }
}
