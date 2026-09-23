import { JSDOM } from "jsdom";
globalThis.DOMParser = new JSDOM().window.DOMParser;
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioReceiver, AUDIO_CHUNK_BYTES, sendAudio } from '../scripts/libs/audio-transfer.js';
import { ChatProcessor } from '../scripts/chat-processor.js';
import { ReadAloudEnricher } from '../scripts/enrichers/read-aloud-enricher.js';
import { ReadAloudActorEnricher } from '../scripts/enrichers/read-aloud-actor-enricher.js';
import { ReadAloudNarratorEnricher } from '../scripts/enrichers/read-aloud-narrator-enricher.js';
import { ElevenlabsRequest } from '../scripts/connectors/elevenlabs/api/elevenlabs-request.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const settings = new Map();
globalThis.game = {
    settings: { get: (_, key) => settings.get(key), register() {} },
    i18n: { localize: key => key }, data: { release: { generation: 13 } },
    actors: { find: () => null, get: () => null }, modules: new Map(), user: { id: 'gm', isGM: true }
};
globalThis.Hooks = { once() {}, on() {} };
globalThis.window = {};
globalThis.Handlebars = { registerHelper() {} };
globalThis.CONST = { CHAT_MESSAGE_STYLES: { IC: 1, OOC: 2 } };
await import('../scripts/main.js');
const Main = window.ACDTalkingActors;
const main = new Main();
const processor = new ChatProcessor({}, logger);

function packet(overrides = {}) {
    return { type: 'audio-chunk', senderId: 'gm', transferId: 'test', index: 0, total: 1, data: btoa('audio'), ...overrides };
}

test('large recording survives JSON relay as bounded packets and exact audio bytes', async () => {
    const bytes = Uint8Array.from({ length: 1_500_003 }, (_, i) => i % 256);
    const receiver = new AudioReceiver();
    const packets = [];
    await sendAudio({ emit(channel, data) {
        assert.equal(channel, 'module.test');
        const serialized = JSON.stringify(data);
        assert.ok(serialized.length < 45_000);
        packets.push(JSON.parse(serialized));
    } }, 'module.test', [bytes.subarray(0, 13), bytes.subarray(13)], 'gm');
    assert.ok(packets.length > 1);
    let result;
    for (const p of packets.reverse()) {
        const received = receiver.receive(p);
        if (received) result = received;
    }
    assert.deepEqual(new Uint8Array(await new Blob(result).arrayBuffer()), bytes);
    assert.equal(receiver.receive(packets[0]), null);
    assert.equal(receiver.pending.size, 0);
});

test('interleaved transfers and duplicate chunks never play partial or mixed audio', () => {
    const r = new AudioReceiver();
    assert.equal(r.receive(packet({ total: 2 })), null);
    assert.equal(r.receive(packet({ total: 2 })), null);
    assert.deepEqual(r.receive(packet({ senderId: 'player' })), [new TextEncoder().encode('audio')]);
    assert.equal(r.receive(packet({ total: 3, index: 2 })), null);
    assert.deepEqual(r.receive(packet({ total: 2, index: 1, data: btoa('end') })), [new TextEncoder().encode('audio'), new TextEncoder().encode('end')]);
});

test('invalid packets and oversized recordings are rejected', async () => {
    const r = new AudioReceiver();
    for (const overrides of [{ total: 999999 }, { index: -1 }, { index: 1 }, { data: '?' }, { data: 'a'.repeat(50_000) }, { transferId: null }]) {
        assert.equal(r.receive(packet(overrides)), null);
    }
    assert.equal(r.pending.size, 0);
    await assert.rejects(sendAudio({}, '', [], 'gm'), /Audio must/);
    await assert.rejects(sendAudio({}, '', [new Uint8Array(AUDIO_CHUNK_BYTES * 1024 + 1)], 'gm'), /Audio must/);
});

test('incomplete transfer releases memory after timeout', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const r = new AudioReceiver();
    r.receive(packet({ total: 2 }));
    assert.equal(r.pending.size, 1);
    t.mock.timers.tick(60_001);
    assert.equal(r.pending.size, 0);
});

test('multiline speech preserves voice and actor modifiers', () => {
    const match = processor.prepareMessageData('/talk [Dave] {Actor Name} First line\nSecond line', false);
    assert.deepEqual(match.slice(1), ['talk', 'Dave', 'Actor Name', 'First line\nSecond line']);
    assert.equal(processor.prepareMessageData('/roll 1d20', true), null);
    assert.equal(processor.prepareMessageData('/ic words', false), null);
});

test('narrator without chat produces a silent narrator command', async () => {
    let command;
    globalThis.ui = { chat: { processMessage: value => { command = value; } } };
    await main.readAloud('First\nSecond', false);
    assert.equal(command, '/narrate-s First\nSecond');
    assert.equal(processor.prepareMessageData(command, false)[1], 'narrate-s');
});

test('explicit actor and normal narrator route correctly', async () => {
    let command;
    globalThis.ui = { chat: { processMessage: value => { command = value; } } };
    await main.readAloud('Hello', true, { narrator: 'Actor Name' });
    assert.equal(command, '/talk {Actor Name} Hello');
    await main.readAloudNarrator('Hello');
    assert.equal(command, '/narrate Hello');
});

test('missing narrator does not throw and silent narration does not post', async () => {
    let posted = 0;
    ui.notifications = { warn() {} };
    globalThis.ChatMessage = { create: async () => { posted++; } };
    settings.set('postSpokenTextToChat', true);
    assert.equal(processor.processChatMessage({}, '/narrate-s hello', {}), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posted, 0);
});

test('speech failure propagates even with chat disabled', async () => {
    const p = new ChatProcessor({ textToSpeech: async () => { throw new Error('quota exceeded'); } }, logger);
    await assert.rejects(p.processAndPostMessage('voice', null, false, {}, 'hi', false, {}, {}), /quota exceeded/);
});

test('v13 and v14 chat use style instead of numeric document type', async () => {
    let data;
    globalThis.ChatMessage = { create: async value => { data = value; } };
    for (const generation of [13, 14]) {
        game.data.release.generation = generation;
        await processor.postToChat({}, '', 'hello', true);
        assert.equal(data.style, CONST.CHAT_MESSAGE_STYLES.IC);
        assert.equal(data.type, undefined);
    }
});

for (const [Enricher, tag, mode] of [[ReadAloudEnricher, '@ReadAloud', 'current'], [ReadAloudNarratorEnricher, '@Narrate', 'narrator'], [ReadAloudActorEnricher, '@ReadAloud[Actor Name]', 'actor']]) {
    test(`${mode} journal tags stay separate and pass literal text as data`, async () => {
        const enricher = new Enricher();
        const matches = [...`${tag}{First\nline} ${tag}{Second}`.matchAll(enricher.pattern)];
        assert.equal(matches.length, 2);
        let data;
        globalThis.foundry = { applications: { handlebars: { renderTemplate: async (_, value) => { data = value; return 'rendered'; } } } };
        globalThis.$ = html => [html];
        const literal = 'A `quote` and \"hello\" & <em>words</em>';
        const match = [...`${tag}{${literal}}`.matchAll(enricher.pattern)][0];
        await enricher.enricher(match);
        assert.equal(data.content, literal);
        assert.equal(data.mode, mode);
        assert.equal(data.click, undefined);
        if (mode === 'actor') assert.equal(data.narrator, 'Actor Name');
    });
}

test('journal menu captures selection before menu focus clears it', async () => {
    let prevented = false;
    main.getSelectionText = () => 'Selected passage';
    main.contextMenu = { isOpen: () => false, hide() {}, show() {} };
    await main.showContextMenu({ preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(main.journalSelection, 'Selected passage');
    assert.equal(prevented, true);
    await new Promise(resolve => setTimeout(resolve, 5));
});

test('API errors report the HTTP status instead of an undefined logger error', async () => {
    const request = new ElevenlabsRequest({ mainSettingsId: 'test', logger });
    await assert.rejects(request.checkResponseStatus(new Response('', { status: 401, statusText: 'Unauthorized' })), /HTTP 401 Unauthorized/);
    assert.equal(await request.checkResponseStatus({ ok: true }), true);
});

test('all four pictured journal menu controls retain text, choose the right voice, and honor chat visibility', async () => {
    let items;
    globalThis.ContextMenuNT = class {
        constructor(options) { items = options.items; }
        hide() {}
    };
    main.createJournalContextMenu();
    const narrator = { _id: 'narrator', name: 'Narrator' };
    const actor = { _id: 'actor', name: 'Current Actor' };
    game.actors = {
        find: predicate => [narrator, actor].find(predicate),
        get: id => [narrator, actor].find(a => a._id === id)
    };
    settings.set('narrating-actor', narrator._id);
    settings.set('postSpokenTextToChat', true);
    const spoken = [], posted = [], commands = [];
    globalThis.ChatMessage = { create: async data => { posted.push(data); return { update: async () => {} }; } };
    const p = new ChatProcessor({
        getVoiceIdFromActor: a => a._id + '-voice', getVoiceSettingsFromActor: () => ({}),
        textToSpeech: async (voice, a, text) => { spoken.push({ voice, text }); return 'history-id'; }
    }, logger);
    globalThis.ui = { chat: { processMessage: command => {
        commands.push(command);
        p.processChatMessage({}, command, { speaker: { actor: actor._id } });
    } } };
    main.journalSelection = 'The creature stares.\nThen it speaks.';
    main.getSelectionText = () => ''; // Clicking the menu cleared the browser selection.
    const expectations = [
        ['narrate', 'narrator-voice', 1], ['narrate-s', 'narrator-voice', 1],
        ['talk', 'actor-voice', 2], ['talk-s', 'actor-voice', 2]
    ];
    for (let i = 0; i < 4; i++) {
        items[i].action();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(commands[i], `/${expectations[i][0]} ${main.journalSelection}`);
        assert.deepEqual(spoken[i], { voice: expectations[i][1], text: main.journalSelection });
        assert.equal(posted.length, expectations[i][2]);
    }
    assert.equal(posted[0].style, CONST.CHAT_MESSAGE_STYLES.OOC);
    assert.equal(posted[1].style, CONST.CHAT_MESSAGE_STYLES.IC);
    assert.equal(narrator.isNarrator, undefined);
    items[4].action(); // Cancel must not speak or post.
    assert.equal(spoken.length, 4);
});

test('audio playback uses the v14 promise API and holds its blob URL until playback ends', async () => {
    globalThis.Application = class {};
    const { default: Connector } = await import('../scripts/connectors/elevenlabs/elevenlabs_connector.js');
    const connector = new Connector({ id: 'test' }, logger);
    const listeners = new Map(), revoked = [];
    const sound = {
        addEventListener: (event, callback) => listeners.set(event, callback),
        removeEventListener: event => listeners.delete(event)
    };
    window.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) };
    game.audio = { play: async url => { assert.equal(url, 'blob:test'); return sound; } };
    assert.equal(await connector.playSound([new Uint8Array([1, 2, 3])]), sound);
    assert.deepEqual(revoked, []);
    listeners.get('end')();
    assert.deepEqual(revoked, ['blob:test']);
    assert.equal(listeners.size, 0);
    game.audio.play = async () => { throw new Error('decode failed'); };
    await assert.rejects(connector.playSound([]), /decode failed/);
    assert.equal(revoked.length, 2);
});

test('voice name overrides return the ElevenLabs voice_id', async () => {
    const { default: Connector } = await import('../scripts/connectors/elevenlabs/elevenlabs_connector.js');
    const connector = new Connector({ id: 'test' }, logger);
    connector.availableVoices = [{ name: 'Dave', voice_id: 'voice-dave' }];
    assert.equal(connector.getVoiceId('Dave'), 'voice-dave');
    assert.equal(connector.getVoiceId('Missing'), null);
});

test('narrator can be configured by actor ID, UUID, or exact name', async () => {
    const { SpeakerResolver } = await import('../scripts/speaker-resolver.js');
    const actor = { _id: 'narrator-id', name: 'The Narrator' };
    game.actors = { find: predicate => [actor].find(predicate) };
    for (const value of ['narrator-id', 'Actor.narrator-id', 'The Narrator', '  Actor.narrator-id  ']) {
        settings.set('narrating-actor', value);
        assert.equal(SpeakerResolver.tryGetSpeakerActorForNarratingActor(), actor);
    }
    settings.set('narrating-actor', 'missing-actor');
    assert.equal(SpeakerResolver.tryGetSpeakerActorForNarratingActor(), undefined);
});

test('journal speech strips markup and decodes entities with paragraph breaks', async () => {
    const { speechText } = await import('../scripts/libs/functions.js');
    assert.equal(speechText('<p>The <strong>creature</strong> &amp; party.</p><p>Next&nbsp;line.<br>Last.</p>'), 'The creature & party.\nNext line.\nLast.');
    assert.equal(speechText('Plain text\nwith two lines'), 'Plain text\nwith two lines');
});
