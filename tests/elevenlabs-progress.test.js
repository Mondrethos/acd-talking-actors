import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_CHUNK_BYTES } from '../scripts/libs/audio-transfer.js';

globalThis.Hooks = { on() {} };
globalThis.Application = class {};
globalThis.window = {};
const { default: Connector } = await import('../scripts/connectors/elevenlabs/elevenlabs_connector.js');
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve, reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function audioResponse(chunks = [new Uint8Array([1, 2, 3])]) {
    let index = 0;
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'history-item-id': 'history-test' }),
        body: {
            getReader: () => ({
                read: async () => index < chunks.length
                    ? { done: false, value: chunks[index++] }
                    : { done: true }
            })
        }
    };
}

function fixture(t) {
    const settings = new Map([
        ['xi-api-key', 'test-key'],
        ['xi-default-model', 'model-test'],
        ['xi-default-language', 'en']
    ]);
    const packets = [], revoked = [], requests = [], playRequests = [];
    const sound = new EventTarget();
    globalThis.game = {
        user: { id: 'gm' },
        settings: { get: (_, key) => settings.get(key), register() {} },
        i18n: { localize: key => key },
        socket: { emit: (channel, packet) => packets.push({ channel, packet }) },
        audio: { play: async url => { playRequests.push(url); return sound; } }
    };
    window.URL = {
        createObjectURL: () => 'blob:progress-test',
        revokeObjectURL: url => revoked.push(url)
    };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push({ url, options });
        return audioResponse();
    });
    const connector = new Connector({ id: 'test' }, logger);
    connector.logger = logger;
    connector.availableVoices = [{ voice_id: 'voice-test' }];
    t.after(() => sound.dispatchEvent(new Event('end')));
    return { connector, settings, sound, packets, revoked, requests, playRequests };
}

test('speech stages follow generation and local playback while history waits for audio transfer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    const headersReady = deferred(), chunkReady = deferred(), playbackReady = deferred();
    const events = [], stages = [];
    let readCount = 0;
    const response = audioResponse();
    response.body.getReader = () => {
        events.push('read-stream');
        return { read: () => readCount++ ? Promise.resolve({ done: true }) : chunkReady.promise };
    };
    t.mock.method(globalThis, 'fetch', async () => {
        events.push('fetch');
        return headersReady.promise;
    });
    game.audio.play = () => {
        events.push('play-request');
        return playbackReady.promise;
    };
    let finished = false;
    const speech = f.connector.textToSpeech('voice-test', null, 'A long passage.', undefined, {
        onProgress: stage => { stages.push(stage); events.push(stage); }
    });
    const finishedSpeech = speech.then(value => { finished = true; return value; });
    assert.deepEqual(events, ['preparing', 'fetch']);

    headersReady.resolve(response);
    await nextTurn();
    assert.deepEqual(events, ['preparing', 'fetch', 'receiving', 'read-stream']);
    chunkReady.resolve({ done: false, value: new Uint8Array(AUDIO_CHUNK_BYTES + 1) });
    await nextTurn();
    assert.deepEqual(events, ['preparing', 'fetch', 'receiving', 'read-stream', 'starting', 'play-request']);
    assert.equal(finished, false);

    playbackReady.resolve(f.sound);
    await nextTurn();
    assert.deepEqual(stages, ['preparing', 'receiving', 'starting', 'playing']);
    assert.equal(f.packets.length, 1);
    assert.equal(finished, false, 'Playback progress is immediate even while socket packets remain');
    t.mock.timers.tick(10);
    await nextTurn();
    assert.equal(f.packets.length, 2);
    assert.equal(finished, false);
    t.mock.timers.tick(10);
    assert.equal(await finishedSpeech, 'history-test');
    assert.equal(f.connector.isSpeaking(), true, 'Started playback remains active until its end event');
    f.sound.dispatchEvent(new Event('end'));
    assert.equal(f.connector.isSpeaking(), false);
    assert.deepEqual(f.revoked, ['blob:progress-test']);
});

test('existing four-argument callers still receive history and unchanged speech requests', async t => {
    const f = fixture(t);
    assert.equal(await f.connector.textToSpeech('voice-test', null, 'Same request.', undefined), 'history-test');
    assert.equal(f.requests[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/voice-test');
    assert.deepEqual(JSON.parse(f.requests[0].options.body), {
        text: 'Same request.', model_id: 'model-test', language_code: 'en'
    });
    assert.equal(f.playRequests.length, 1);
    assert.equal(f.packets.length, 1);
});

test('muted speech returns null without progress, network requests, or playback', async t => {
    const f = fixture(t);
    f.connector.isMuted = true;
    const stages = [];
    assert.equal(await f.connector.textToSpeech('voice-test', null, 'Muted.', undefined, {
        onProgress: stage => stages.push(stage)
    }), null);
    assert.deepEqual(stages, []);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.playRequests, []);
    assert.deepEqual(f.packets, []);
});

test('progress observers cannot break or delay audio with throws, rejections, or pending promises', async t => {
    for (const behavior of ['throw', 'reject', 'pending']) {
        await t.test(behavior, async t => {
            const f = fixture(t);
            const stages = [];
            const history = await f.connector.textToSpeech('voice-test', null, 'Keep speaking.', undefined, {
                onProgress: stage => {
                    stages.push(stage);
                    if (behavior === 'throw') throw new Error('UI failed');
                    if (behavior === 'reject') return Promise.reject(new Error('Async UI failed'));
                    return new Promise(() => {});
                }
            });
            assert.equal(history, 'history-test');
            assert.deepEqual(stages, ['preparing', 'receiving', 'starting', 'playing']);
            assert.equal(f.playRequests.length, 1);
            assert.equal(f.packets.length, 1);
        });
    }
});

test('validation, generation, and stream failures reset speaking without claiming playback', async t => {
    const cases = [
        { name: 'missing key', stages: [], error: /noApiKey/, setup: f => f.settings.clear() },
        { name: 'missing voice', stages: [], error: /voiceUnavailable/, setup: f => { f.connector.availableVoices = []; } },
        { name: 'model lookup', stages: [], error: /No models/, setup: (f, t) => {
            t.mock.method(f.connector, 'retrieveModelId', () => { throw new Error('No models'); });
        } },
        { name: 'language lookup', stages: [], error: /No languages/, setup: (f, t) => {
            t.mock.method(f.connector, 'retrieveLanguageId', () => { throw new Error('No languages'); });
        } },
        { name: 'network', stages: ['preparing'], error: /Network down/, setup: (f, t) => {
            t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network down'); });
        } },
        { name: 'provider rejection', stages: ['preparing'], error: /HTTP 429/, setup: (f, t) => {
            t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'Quota exceeded' }, { status: 429 }));
        } },
        { name: 'missing stream', stages: ['preparing'], error: /Invalid stream/, setup: (f, t) => {
            t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, body: null }));
        } },
        { name: 'stream interrupted', stages: ['preparing', 'receiving'], error: /Stream lost/, setup: (f, t) => {
            const response = audioResponse();
            response.body.getReader = () => ({ read: async () => { throw new Error('Stream lost'); } });
            t.mock.method(globalThis, 'fetch', async () => response);
        } }
    ];
    for (const example of cases) {
        await t.test(example.name, async t => {
            const f = fixture(t);
            f.connector._speaking = true;
            example.setup(f, t);
            const stages = [];
            await assert.rejects(f.connector.textToSpeech('voice-test', null, 'Failed request.', undefined, {
                onProgress: stage => stages.push(stage)
            }), example.error);
            assert.equal(f.connector.isSpeaking(), false);
            assert.deepEqual(stages, example.stages);
            assert.deepEqual(f.playRequests, []);
            assert.deepEqual(f.packets, []);
        });
    }
});

test('local playback failure reports no playing stage and cleans up its audio URL', async t => {
    const f = fixture(t);
    game.audio.play = async () => { throw new Error('Audio decoding failed'); };
    const stages = [];
    await assert.rejects(f.connector.textToSpeech('voice-test', null, 'Cannot play.', undefined, {
        onProgress: stage => stages.push(stage)
    }), /Audio decoding failed/);
    assert.deepEqual(stages, ['preparing', 'receiving', 'starting']);
    assert.equal(f.connector.isSpeaking(), false);
    assert.deepEqual(f.revoked, ['blob:progress-test']);
});

test('transport failure cannot later replace the failure with playing progress', async t => {
    const f = fixture(t);
    const playbackReady = deferred();
    game.audio.play = () => playbackReady.promise;
    game.socket.emit = () => { throw new Error('Socket unavailable'); };
    const stages = [];
    await assert.rejects(f.connector.textToSpeech('voice-test', null, 'Cannot broadcast.', undefined, {
        onProgress: stage => stages.push(stage)
    }), /Socket unavailable/);
    assert.equal(f.connector.isSpeaking(), false);
    playbackReady.resolve(f.sound);
    await nextTurn();
    assert.deepEqual(stages, ['preparing', 'receiving', 'starting']);
});

test('broadcast playback observer failures never reject successful audio transfer', async t => {
    const f = fixture(t);
    for (const callback of [
        () => { throw new Error('Observer failed'); },
        () => Promise.reject(new Error('Async observer failed'))
    ]) {
        await f.connector.broadcastAudio([new Uint8Array([1])], { onPlaybackStarted: callback });
    }
    assert.equal(f.packets.length, 2);
    assert.equal(f.playRequests.length, 2);
});
