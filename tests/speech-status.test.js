import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { SpeechStatus } from '../scripts/speech-status.js';

const SCOPE = 'acd-talking-actors';
const FLAG = 'speechStatus';
const FLAG_PATH = `flags.${SCOPE}.${FLAG}`;
const NOW = Date.UTC(2026, 8, 23, 12);
const nextTick = () => new Promise(resolve => setImmediate(resolve));

function applyDocumentPatch(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
        const path = key.split('.');
        let parent = target;
        for (const part of path.slice(0, -1)) parent = parent[part] ??= {};
        parent[path.at(-1)] = structuredClone(value);
    }
}

function fixture(t) {
    const dom = new JSDOM('<!doctype html><body></body>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.DOMParser = dom.window.DOMParser;
    const callbacks = new Map();
    let hookSequence = 0;
    globalThis.Hooks = {
        on(name, callback) {
            const id = ++hookSequence;
            if (!callbacks.has(name)) callbacks.set(name, new Map());
            callbacks.get(name).set(id, callback);
            return id;
        },
        off(name, id) { callbacks.get(name)?.delete(id); },
        callAll(name, ...args) {
            for (const callback of [...(callbacks.get(name)?.values() ?? [])]) callback(...args);
        }
    };
    globalThis.game = {
        user: { id: 'gm', name: 'Gamemaster', isGM: true },
        messages: new Map(),
        i18n: { localize: key => key, format: (key, data) => `${key} ${JSON.stringify(data)}` }
    };
    const logs = [];
    const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level, args })]));
    const status = new SpeechStatus(logger);
    status.registerHooks();
    let messageSequence = 0;

    function message(data = {}, { id = `message-${++messageSequence}`, failUpdates = false } = {}) {
        const updates = [];
        const sourceUpdates = [];
        const result = {
            id,
            author: { id: data.user ?? 'gm' },
            user: data.user ?? 'gm',
            content: data.content ?? '<p>A native journal passage.</p>',
            flavor: data.flavor ?? '<time>49 Blooming AS2523, 11:00am</time>',
            flags: structuredClone(data.flags ?? { ember: { journal: 'page-123' } }),
            visible: true,
            isContentVisible: true,
            blind: false,
            ...data,
            getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
            updateSource(patch) {
                sourceUpdates.push(structuredClone(patch));
                applyDocumentPatch(this, patch);
            },
            async update(patch) {
                updates.push(structuredClone(patch));
                if (failUpdates) throw new Error('Permission denied');
                applyDocumentPatch(this, patch);
                Hooks.callAll('updateChatMessage', this, patch, {}, 'gm');
                return this;
            },
            updates,
            sourceUpdates
        };
        if (id) game.messages.set(id, result);
        return result;
    }

    function preCreate(data = {}, userId = 'gm') {
        const native = message(data, { id: null });
        Hooks.callAll('preCreateChatMessage', native, data, {}, userId);
        return native;
    }

    function create(native, userId = 'gm') {
        native.id ||= `message-${++messageSequence}`;
        game.messages.set(native.id, native);
        Hooks.callAll('createChatMessage', native, {}, userId);
        return native;
    }

    function render(native, existing) {
        const element = existing ?? document.createElement('li');
        element.classList.add('chat-message', 'message');
        element.dataset.messageId = native.id;
        if (!existing) {
            element.innerHTML = `<header class="message-header">Gamemaster</header><div class="message-content">${native.content}</div>`;
            document.body.append(element);
        }
        Hooks.callAll('renderChatMessageHTML', native, element, {});
        return element;
    }

    t.after(() => {
        status.destroy();
        dom.window.close();
    });
    return { status, message, preCreate, create, render, logs, callbacks };
}

function statusFlag(message) { return message.flags?.[SCOPE]?.[FLAG]; }

test('native capture adds only status flags to the exact current-user passage', async t => {
    const { status, preCreate, create } = fixture(t);
    const job = status.start('A narrow stair.\nTwo lanterns glow.', { capture: true });
    const data = {
        user: 'gm',
        content: '<section class="ember-journal"><div class="block readaloud"><p>A narrow <strong>stair.</strong></p><p>Two lanterns glow.</p></div></section>',
        flavor: '<time>49 Blooming AS2523, 11:00am</time>',
        flags: { ember: { journal: 'page-123', original: true }, unrelated: { keep: 42 } }
    };
    const native = preCreate(data);
    assert.equal(statusFlag(native)?.requestId, job.id);
    assert.equal(statusFlag(native)?.stage, 'preparing');
    assert.equal(native.content, data.content);
    assert.equal(native.flavor, data.flavor);
    assert.deepEqual(native.flags.ember, data.flags.ember);
    assert.deepEqual(native.flags.unrelated, data.flags.unrelated);
    assert.ok(native.sourceUpdates.every(patch => Object.keys(patch).every(key => key === FLAG_PATH)));
    create(native);
    await job.update('receiving');
    assert.equal(statusFlag(native).stage, 'receiving');
    assert.ok(native.updates.every(patch => Object.keys(patch).every(key => key === FLAG_PATH)));
    assert.equal(native.content, data.content);
    assert.equal(native.flavor, data.flavor);
    await job.finish();
});

test('native capture ignores other authors, unrelated and partial passages', async t => {
    const { status, preCreate, create } = fixture(t);
    const job = status.start('A narrow stair. Two lanterns glow.', { capture: true });
    const ignored = [
        preCreate({ user: 'player', content: '<p>A narrow stair. Two lanterns glow.</p>' }, 'player'),
        preCreate({ user: 'player', content: '<p>A narrow stair. Two lanterns glow.</p>' }, 'gm'),
        preCreate({ content: '<p>A narrow stair.</p>' }),
        preCreate({ content: '<p>A different passage.</p>' }),
        preCreate({ content: '<p>Private prefix. A narrow stair. Two lanterns glow.</p>' })
    ];
    for (const native of ignored) {
        create(native, native.user);
        assert.equal(statusFlag(native), undefined);
    }
    const match = create(preCreate({ content: '<p>A narrow stair.\n\nTwo lanterns glow.</p>' }));
    assert.equal(statusFlag(match)?.requestId, job.id);
    await job.finish();
});

test('simultaneous native requests bind each matching message once in request order', async t => {
    const { status, preCreate, create } = fixture(t);
    const first = status.start('Same passage.', { capture: true });
    const second = status.start('Same passage.', { capture: true });
    const different = status.start('Other passage.', { capture: true });
    const other = create(preCreate({ content: '<p>Other passage.</p>' }));
    const one = create(preCreate({ content: '<p>Same passage.</p>' }));
    const two = create(preCreate({ content: '<p>Same passage.</p>' }));
    const unclaimed = create(preCreate({ content: '<p>Same passage.</p>' }));
    assert.equal(statusFlag(other)?.requestId, different.id);
    assert.equal(statusFlag(one)?.requestId, first.id);
    assert.equal(statusFlag(two)?.requestId, second.id);
    assert.equal(statusFlag(unclaimed), undefined);
    await Promise.all([first.finish(), second.finish(), different.finish()]);
});

test('native message completed before persistence cannot leave a pending status', async t => {
    const { status, preCreate, create, render } = fixture(t);
    const job = status.start('A slow native post.', { capture: true });
    const native = preCreate({ content: '<p>A slow native post.</p>' });
    assert.equal(statusFlag(native)?.stage, 'preparing');
    await job.finish();
    create(native);
    await nextTick();
    assert.equal(statusFlag(native)?.stage, 'complete');
    assert.equal(render(native).querySelector('.acd-ta-speech-status'), null);
});

test('an expired or already completed capture cannot add a waiting indicator to a later share', async t => {
    const { status, preCreate, create, render } = fixture(t);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
    const completed = status.start('A finished passage.', { capture: true });
    await completed.finish();
    const late = create(preCreate({ content: '<p>A finished passage.</p>' }));
    assert.ok(!statusFlag(late) || statusFlag(late).stage === 'complete');
    assert.equal(render(late).querySelector('.acd-ta-speech-status'), null);
    const expired = status.start('An expired passage.', { capture: true });
    t.mock.timers.tick(31_000);
    const standalone = create(preCreate({ content: '<p>An expired passage.</p>' }));
    assert.equal(statusFlag(standalone), undefined);
    await expired.finish();
});

test('ordinary chat creation can attach a snapshot without changing content or flavor', async t => {
    const { status, message } = fixture(t);
    const job = status.start('A regular spoken message.');
    const original = { content: '<span class="acd-ta-talked">A regular spoken message.</span>', flavor: 'Talked Text' };
    const direct = message({ ...original, flags: { [SCOPE]: { [FLAG]: job.snapshot() } } });
    await job.attach(direct);
    await job.update('receiving');
    await job.update('starting');
    await job.finish();
    assert.equal(statusFlag(direct).requestId, job.id);
    assert.equal(statusFlag(direct).stage, 'complete');
    assert.equal(direct.content, original.content);
    assert.equal(direct.flavor, original.flavor);
});

test('rendered waiting status updates elapsed time locally and leaves native content intact', async t => {
    const { status, message, render } = fixture(t);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
    const job = status.start('Wait for the voice.');
    const native = message({ flags: { [SCOPE]: { [FLAG]: job.snapshot() } } });
    await job.attach(native);
    const element = render(native);
    const originalContent = element.querySelector('.message-content').outerHTML;
    const row = element.querySelector('.acd-ta-speech-status');
    assert.ok(row, 'Show a small status on the message awaiting its narration');
    assert.ok(row.querySelector('.acd-ta-speech-status-label'));
    assert.ok(row.querySelector('.acd-ta-speech-status-bar'));
    const elapsed = row.querySelector('.acd-ta-speech-status-elapsed');
    assert.equal(elapsed?.getAttribute('aria-hidden'), 'true', 'Avoid announcing every second to screen readers');
    const writesBefore = native.updates.length;
    t.mock.timers.tick(20_000);
    assert.match(elapsed.textContent, /20/);
    assert.equal(native.updates.length, writesBefore, 'Elapsed ticks never write the chat document');
    assert.equal(element.querySelector('.message-content').outerHTML, originalContent);
    assert.equal(element.querySelector('.message-content .acd-ta-speech-status'), null);
    await job.finish();
});

test('rerendering creates one status per message and completion or skipping removes it', async t => {
    for (const terminal of ['complete', 'skipped']) {
        await t.test(terminal, async t => {
            const { status, message, render } = fixture(t);
            const job = status.start('A pending passage.');
            const native = message({ flags: { [SCOPE]: { [FLAG]: job.snapshot() } } });
            await job.attach(native);
            const element = render(native);
            render(native, element);
            assert.equal(element.querySelectorAll('.acd-ta-speech-status').length, 1);
            await job.finish(terminal);
            render(native, element);
            assert.equal(element.querySelector('.acd-ta-speech-status'), null);
        });
    }
});

test('failed narration shows a brief non-spinning status then disappears', async t => {
    const { status, message, render } = fixture(t);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
    const job = status.start('A failed passage.');
    const native = message({ flags: { [SCOPE]: { [FLAG]: job.snapshot() } } });
    await job.attach(native);
    const element = render(native);
    await job.finish('failed');
    render(native, element);
    const row = element.querySelector('.acd-ta-speech-status');
    assert.ok(row);
    assert.notEqual(row.getAttribute('aria-busy'), 'true');
    assert.equal(row.querySelector('.acd-ta-speech-status-bar'), null);
    t.mock.timers.tick(9_000);
    assert.equal(element.querySelector('.acd-ta-speech-status'), null);
});

test('private and blind messages never render status for a user lacking visibility', t => {
    const { status, message, render } = fixture(t);
    game.user.isGM = false;
    const job = status.start('Hidden passage.');
    for (const visibility of [{ visible: false }, { isContentVisible: false }, { blind: true, isContentVisible: false }]) {
        const native = message({ ...visibility, flags: { [SCOPE]: { [FLAG]: job.snapshot() } } });
        assert.equal(render(native).querySelector('.acd-ta-speech-status'), null);
    }
});

test('stale or malformed stored statuses cannot leave an endless spinner after reload', t => {
    const { message, render } = fixture(t);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
    const valid = { requestId: 'old-request', stage: 'preparing', startedAt: NOW, updatedAt: NOW };
    const invalid = [
        null,
        {},
        { ...valid, stage: 'made-up-stage' },
        { ...valid, requestId: '' },
        { ...valid, startedAt: 'today' },
        { ...valid, updatedAt: NaN },
        { ...valid, startedAt: NOW + 301_000, updatedAt: NOW + 301_000 },
        { ...valid, startedAt: NOW - 301_000, updatedAt: NOW - 301_000 },
        { ...valid, stage: 'complete' },
        { ...valid, stage: 'skipped' },
        { ...valid, stage: 'failed', updatedAt: NOW - 9_000 }
    ];
    for (const payload of invalid) {
        const native = message({ flags: { [SCOPE]: { [FLAG]: payload } } });
        assert.equal(render(native).querySelector('.acd-ta-speech-status'), null, JSON.stringify(payload));
    }
});

test('an orphaned active status expires even without a completion update', t => {
    const { message, render } = fixture(t);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
    const native = message({ flags: { [SCOPE]: { [FLAG]: {
        requestId: 'remote-request', stage: 'preparing', startedAt: NOW, updatedAt: NOW
    } } } });
    const element = render(native);
    assert.ok(element.querySelector('.acd-ta-speech-status'));
    t.mock.timers.tick(301_000);
    assert.equal(element.querySelector('.acd-ta-speech-status'), null);
    assert.deepEqual(native.updates, [], 'Receiving clients never write expiry updates');
});

test('remote flag updates advance and remove a rendered status without a chat rerender', async t => {
    const { message, render } = fixture(t);
    const snapshot = { requestId: 'remote-request', stage: 'preparing', startedAt: Date.now(), updatedAt: Date.now() };
    const native = message({ flags: { [SCOPE]: { [FLAG]: snapshot } } });
    const element = render(native);
    assert.equal(element.querySelector('.acd-ta-speech-status')?.dataset.stage, 'preparing');
    await native.update({ [FLAG_PATH]: { ...snapshot, stage: 'receiving', updatedAt: Date.now() } });
    assert.equal(element.querySelector('.acd-ta-speech-status')?.dataset.stage, 'receiving');
    await native.update({ [FLAG_PATH]: { ...snapshot, stage: 'complete', updatedAt: Date.now() } });
    assert.equal(element.querySelector('.acd-ta-speech-status'), null);
});

test('status persistence errors do not reject narration lifecycle calls', async t => {
    const { status, message } = fixture(t);
    const job = status.start('Speech must still work.');
    const native = message({}, { failUpdates: true });
    await assert.doesNotReject(async () => {
        await job.attach(native);
        await job.update('receiving');
        await job.update('starting');
        await job.finish();
    });
    assert.equal(job.snapshot().stage, 'complete');
    assert.ok(native.updates.length > 0, 'Exercise an actual failed document update');
});

test('a slow status write cannot overwrite a later completed state', async t => {
    const { status, message } = fixture(t);
    const job = status.start('Fast speech and slow chat persistence.');
    const native = message({ flags: { [SCOPE]: { [FLAG]: job.snapshot() } } });
    await job.attach(native);
    const originalUpdate = native.update.bind(native);
    let release;
    const waitForWrite = new Promise(resolve => { release = resolve; });
    native.update = async patch => {
        if (patch[FLAG_PATH]?.stage === 'receiving') await waitForWrite;
        return originalUpdate(patch);
    };
    const receiving = job.update('receiving');
    await nextTick();
    const finished = job.finish();
    release();
    await Promise.all([receiving, finished]);
    assert.equal(statusFlag(native).stage, 'complete');
});

test('registration is idempotent and destroy removes hooks and visible status', async t => {
    const { status, message, render, callbacks } = fixture(t);
    status.registerHooks();
    for (const handlers of callbacks.values()) assert.equal(handlers.size, 1);
    const job = status.start('A disposable status.');
    const native = message({ flags: { [SCOPE]: { [FLAG]: job.snapshot() } } });
    await job.attach(native);
    const element = render(native);
    assert.ok(element.querySelector('.acd-ta-speech-status'));
    status.destroy();
    assert.equal(element.querySelector('.acd-ta-speech-status'), null);
    for (const handlers of callbacks.values()) assert.equal(handlers.size, 0);
    const writes = native.updates.length;
    await job.finish();
    assert.equal(native.updates.length, writes);
});

test('deleted messages and detached rendered views release their status rows', async t => {
    const { status, message, render } = fixture(t);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW });
    const deletedJob = status.start('Delete this message.');
    const deleted = message({ flags: { [SCOPE]: { [FLAG]: deletedJob.snapshot() } } });
    await deletedJob.attach(deleted);
    const deletedElement = render(deleted);
    Hooks.callAll('deleteChatMessage', deleted, {}, 'gm');
    assert.equal(deletedElement.querySelector('.acd-ta-speech-status'), null);
    const writes = deleted.updates.length;
    await deletedJob.finish();
    assert.equal(deleted.updates.length, writes, 'Do not update a deleted chat document');

    const detachedJob = status.start('A chat view scrolling away.');
    const detached = message({ flags: { [SCOPE]: { [FLAG]: detachedJob.snapshot() } } });
    await detachedJob.attach(detached);
    const detachedElement = render(detached);
    detachedElement.remove();
    t.mock.timers.tick(1_000);
    assert.equal(detachedElement.querySelector('.acd-ta-speech-status'), null);
    await detachedJob.finish();
});
