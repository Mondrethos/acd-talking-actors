import test from 'node:test';
import assert from 'node:assert/strict';
import { ElevenlabsRequest, getApiKey } from '../scripts/connectors/elevenlabs/api/elevenlabs-request.js';

const settings = new Map();
const logger = { debug() {}, info() {}, warn() {}, error() {} };
globalThis.game = { settings: { get: (_, key) => settings.get(key), register() {}, settings: new Map() } };
globalThis.Hooks = { on() {} };
globalThis.Application = class {};
globalThis.window = {};
const { default: Connector } = await import('../scripts/connectors/elevenlabs/elevenlabs_connector.js');
const { Mp3Utils } = await import('../scripts/libs/mp3-utils.js');
const context = { mainSettingsId: 'test', logger };

test('key selection trims whitespace and preserves explicit client-key precedence', () => {
    settings.set('xi-api-key', '  client-test-key  ');
    settings.set('xi-master-api-key', '  shared-test-key\n');
    assert.equal(getApiKey('test'), 'client-test-key');
    assert.equal(new ElevenlabsRequest(context).api_key, 'client-test-key');
    settings.set('xi-api-key', ' \n ');
    assert.equal(getApiKey('test'), 'shared-test-key');
    settings.clear();
    assert.equal(getApiKey('test'), '');
});

test('API errors preserve invalid-key and permission details for each request path', async t => {
    for (const [method, args] of [['fetchJson', ['voices']], ['fetchResponse', ['history/id/audio']], ['postData', ['text-to-speech/voice', 'audio/mpeg', '{}']]]) {
        for (const detail of [
            { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key.' },
            { status: 'missing_permissions', message: 'Missing permission user_read.' }
        ]) {
            t.mock.method(globalThis, 'fetch', async () => Response.json({ detail }, { status: 401 }));
            await assert.rejects(new ElevenlabsRequest(context)[method](...args), error => {
                assert.equal(error.status, 401);
                assert.equal(error.code, detail.code || detail.status);
                assert.ok(error.message.includes(detail.message));
                return true;
            });
            t.mock.restoreAll();
        }
    }
});

test('non-JSON failure keeps HTTP status and a successful audio body is untouched', async () => {
    const request = new ElevenlabsRequest(context);
    await assert.rejects(request.checkResponseStatus(new Response('<html>Gateway error</html>', { status: 502 })), /HTTP 502/);
    const audio = new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    assert.equal(await request.checkResponseStatus(audio), true);
    assert.equal(audio.bodyUsed, false);
    assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test('an error that echoes a credential redacts it before logging', async () => {
    settings.set('xi-api-key', 'unit-test-secret');
    const request = new ElevenlabsRequest(context);
    settings.clear();
    await assert.rejects(request.checkResponseStatus(Response.json({ detail: { code: 'invalid_api_key', message: 'Invalid unit-test-secret' } }, { status: 401 })), error => {
        assert.ok(!error.message.includes('unit-test-secret'));
        assert.ok(error.message.includes('[redacted]'));
        return true;
    });
});

test('startup loads voices and models without requiring subscription permissions', async t => {
    settings.set('xi-api-key', 'restricted-test-key');
    t.mock.method(Mp3Utils, 'init', () => {});
    const requested = [], errors = [];
    t.mock.method(globalThis, 'fetch', async url => {
        requested.push(url);
        if (url.endsWith('/voices')) return Response.json({ voices: [{ voice_id: 'voice-test' }] });
        if (url.endsWith('/models')) return Response.json([{ model_id: 'model-test', languages: [] }]);
        return Response.json({ detail: { status: 'missing_permissions', message: 'Missing user_read.' } }, { status: 401 });
    });
    const connector = new Connector({ id: 'test' }, logger);
    connector.logger = { ...logger, error: (...args) => errors.push(args) };
    // Registration is a Foundry UI concern; exercise the actual API loaders here.
    t.mock.method(connector, 'registerAdditionalSettings', () => {});
    await connector.init();
    assert.deepEqual(requested, ['https://api.elevenlabs.io/v1/voices', 'https://api.elevenlabs.io/v1/models']);
    assert.equal(connector.availableVoices[0].voice_id, 'voice-test');
    assert.equal(connector.models[0].model_id, 'model-test');
    assert.deepEqual(errors, []);
    settings.clear();
});

test('invalid credentials still report errors for required startup requests', async t => {
    settings.set('xi-api-key', 'invalid-test-key');
    t.mock.method(Mp3Utils, 'init', () => {});
    t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: { code: 'invalid_api_key', message: 'Invalid API key.' } }, { status: 401 }));
    const connector = new Connector({ id: 'test' }, logger);
    const errors = [];
    connector.logger = { ...logger, error: (...args) => errors.push(args) };
    t.mock.method(connector, 'registerAdditionalSettings', () => {});
    await connector.init();
    assert.equal(errors.length, 2);
    assert.ok(errors.every(args => args[1].code === 'invalid_api_key'));
    settings.clear();
});

test('speech reports missing keys and unavailable voices instead of returning silently', async () => {
    game.i18n = { localize: key => key };
    const connector = new Connector({ id: 'test' }, logger);
    settings.clear();
    await assert.rejects(connector.textToSpeech('voice-test', null, 'Hello'), /noApiKey/);
    settings.set('xi-api-key', 'restricted-test-key');
    await assert.rejects(connector.textToSpeech('missing-voice', null, 'Hello'), /voiceUnavailable/);
    assert.equal(connector._speaking, false);
    settings.clear();
});

test('speech API failures propagate to the caller with their actual cause', async t => {
    settings.set('xi-api-key', 'restricted-test-key');
    const connector = new Connector({ id: 'test' }, logger);
    connector.logger = logger;
    connector.availableVoices = [{ voice_id: 'voice-test' }];
    t.mock.method(connector, 'retrieveModelId', () => 'model-test');
    t.mock.method(connector, 'retrieveLanguageId', () => 'en');
    t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: { code: 'insufficient_permissions', message: 'This key cannot generate speech.' } }, { status: 403 }));
    await assert.rejects(connector.textToSpeech('voice-test', null, 'Hello'), /insufficient_permissions.*cannot generate speech/);
    assert.equal(connector._speaking, false);
    settings.clear();
});
