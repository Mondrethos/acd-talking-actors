import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ChatProcessor } from '../scripts/chat-processor.js';
import { SpeechStatus } from '../scripts/speech-status.js';

const SCOPE = 'acd-talking-actors';
const tick = () => new Promise(resolve => setImmediate(resolve));
const logger = { debug() {}, info() {}, warn() {}, error() {} };

function fixture(t, speak) {
    const dom = new JSDOM();
    globalThis.DOMParser = dom.window.DOMParser;
    const listeners = new Map();
    globalThis.Hooks = {
        on(name, callback) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(callback);
            return callback;
        },
        off(name, callback) { listeners.get(name)?.delete(callback); },
        callAll(name, ...args) { for (const callback of listeners.get(name) ?? []) callback(...args); }
    };
    const actor = { _id: 'narrator', name: 'Narrator' };
    globalThis.game = {
        user: { id: 'gm', isGM: true },
        settings: { get: (_scope, key) => key === 'narrating-actor' ? 'narrator' : true },
        actors: { find: predicate => [actor].find(predicate) },
        i18n: { localize: key => key },
        data: { release: { generation: 14 } }
    };
    globalThis.CONST = { CHAT_MESSAGE_STYLES: { IC: 1, OOC: 2 } };
    const messages = [];
    globalThis.ChatMessage = {
        async create(data) {
            const message = {
                ...structuredClone(data), id: `message-${messages.length}`, flags: structuredClone(data.flags ?? {}),
                getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
                updateSource(patch) {
                    for (const [key, value] of Object.entries(patch)) {
                        if (key === `flags.${SCOPE}.speechStatus`) {
                            this.flags[SCOPE] ??= {};
                            this.flags[SCOPE].speechStatus = structuredClone(value);
                        } else this[key] = value;
                    }
                },
                async update(patch) { this.updateSource(patch); return this; }
            };
            Hooks.callAll('preCreateChatMessage', message, data, {}, 'gm');
            messages.push(message);
            await Promise.resolve();
            Hooks.callAll('createChatMessage', message, {}, 'gm');
            return message;
        }
    };
    const connector = {
        isMuted: false,
        getVoiceIdFromActor: () => 'voice',
        getVoiceSettingsFromActor: () => ({}),
        textToSpeech: async (...args) => connector.isMuted ? null : speak(...args)
    };
    const status = new SpeechStatus(logger);
    status.registerHooks();
    const processor = new ChatProcessor(connector, logger, status);
    t.after(() => { status.destroy(); dom.window.close(); });
    return { messages, connector, status, processor };
}

test('native narration captures the original card and clears status at playback before transfer finishes', async t => {
    let report, finish;
    const waiting = new Promise(resolve => { finish = resolve; });
    const f = fixture(t, async (_voice, _actor, text, _settings, { onProgress }) => {
        assert.equal(text, 'A narrow stair.\nTwo lanterns glow.');
        report = onProgress;
        return waiting;
    });
    const native = {
        user: 'gm', content: '<div class="block readaloud"><p>A narrow stair.</p><p>Two lanterns glow.</p></div>',
        flavor: '<time>49 Blooming AS2523</time>', flags: { ember: { untouched: true } }
    };
    const pending = f.processor.narrateJournalBlock('<p>A narrow stair.</p><p>Two lanterns glow.</p>', () => {
        void ChatMessage.create(native);
    });
    await tick();
    const message = f.messages[0];
    assert.equal(message.getFlag(SCOPE, 'speechStatus').stage, 'preparing');
    report('receiving');
    await tick();
    assert.equal(message.getFlag(SCOPE, 'speechStatus').stage, 'receiving');
    report('playing');
    await tick();
    assert.equal(message.getFlag(SCOPE, 'speechStatus').stage, 'complete');
    finish('history-id');
    await pending;
    assert.equal(f.messages.length, 1);
    assert.equal(message.content, native.content);
    assert.equal(message.flavor, native.flavor);
    assert.deepEqual(message.flags.ember, native.flags.ember);
});

test('ordinary spoken chat carries its own status and retains the replay control', async t => {
    const f = fixture(t, async (_voice, _actor, _text, _settings, { onProgress }) => {
        onProgress('starting');
        onProgress('playing');
        return 'history-id';
    });
    await f.processor.processAndPostMessage('voice', null, true, { user: 'gm' }, 'Hello!', false, {}, {});
    await tick();
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].getFlag(SCOPE, 'speechStatus').stage, 'complete');
    assert.match(f.messages[0].content, /Hello!/);
    assert.match(f.messages[0].flavor, /acd-ta-replay/);
});

test('silent speech creates no message or status, and muted native sharing creates no spinner', async t => {
    let calls = 0;
    const f = fixture(t, async () => { calls++; return 'history'; });
    await f.processor.processAndPostMessage('voice', null, false, { user: 'gm' }, 'Silent chat.', false, {}, {});
    assert.equal(calls, 1);
    assert.equal(f.messages.length, 0);
    assert.equal(f.status.jobs.size, 0);
    f.connector.isMuted = true;
    await f.processor.narrateJournalBlock('A muted passage.', () => {
        void ChatMessage.create({ user: 'gm', content: '<p>A muted passage.</p>' });
    });
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].getFlag(SCOPE, 'speechStatus'), undefined);
    assert.equal(f.status.jobs.size, 0);
});

test('speech failure ends the native card waiting state and keeps the provider error', async t => {
    const f = fixture(t, async () => { throw new Error('Speech quota exceeded'); });
    await assert.rejects(f.processor.narrateJournalBlock('A native passage.', () => {
        void ChatMessage.create({ user: 'gm', content: '<p>A native passage.</p>', flavor: 'Original date' });
    }), /Speech quota exceeded/);
    await tick();
    assert.equal(f.messages[0].getFlag(SCOPE, 'speechStatus').stage, 'failed');
    assert.equal(f.messages[0].flavor, 'Original date');
    assert.equal(f.messages.length, 1);
});
