import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ChatProcessor } from '../scripts/chat-processor.js';
import { JournalNarration } from '../scripts/journal-narration.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const nextTick = () => new Promise(resolve => setImmediate(resolve));

function journalFixture(t, markup, { accessible = true, postToChat = true, speak } = {}) {
    const dom = new JSDOM(`<!doctype html><body><article class="journal-page-content">${markup}</article></body>`);
    t.after(() => dom.window.close());
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.DOMParser = dom.window.DOMParser;
    const root = document.querySelector('.journal-page-content');
    const settings = new Map([
        ['narrating-actor', 'narrator'],
        ['postSpokenTextToChat', postToChat]
    ]);
    const narrator = { _id: 'narrator', name: 'Narrator' };
    globalThis.game = {
        user: { id: 'gm', name: 'Gamemaster', isGM: true },
        settings: { get: (_, key) => settings.get(key) },
        i18n: { localize: key => key },
        data: { release: { generation: 14 } },
        actors: { find: predicate => [narrator].find(predicate) }
    };
    globalThis.CONST = { CHAT_MESSAGE_STYLES: { IC: 1, OOC: 2 } };
    const posted = [], spoken = [], updated = [], notifications = [];
    globalThis.ChatMessage = {
        create: async data => {
            posted.push(data);
            return { update: async data => { updated.push(data); } };
        }
    };
    globalThis.ui = {
        chat: {},
        notifications: {
            error: message => notifications.push(message),
            warn: message => notifications.push(message)
        }
    };
    const connector = {
        getVoiceIdFromActor: actor => `${actor._id}-voice`,
        getVoiceSettingsFromActor: () => ({ stability: 0.5 }),
        textToSpeech: async (voice, actor, text, voiceSettings) => {
            spoken.push({ voice, actor: actor._id, text, settings: voiceSettings });
            return speak ? speak() : 'history-id';
        }
    };
    const access = { allowed: accessible };
    const module = {
        logger,
        isModuleAccessible: () => access.allowed,
        chatProcessor: new ChatProcessor(connector, logger)
    };
    const narration = new JournalNarration(module);
    return { root, narration, access, connector, settings, posted, spoken, updated, notifications };
}

function nativeMessage(content = '<div class="adventure-journal"><aside class="narrative">Native passage.</aside></div>') {
    return {
        user: 'gm',
        speaker: { alias: 'Gamemaster', actor: null, token: null, scene: 'current-scene' },
        flavor: '<time>49 Blooming AS2523, 11:00am</time>',
        content,
        style: CONST.CHAT_MESSAGE_STYLES.OOC,
        flags: { adventure: { journalPage: 'original-page', originalMarkup: true } }
    };
}

function bindNativeShare(fixture, control, { delegated = false, message = nativeMessage() } = {}) {
    const state = { clicks: 0, message };
    const listener = event => {
        if (delegated && !control.contains(event.target)) return;
        event.preventDefault();
        state.clicks++;
        void ChatMessage.create(message);
    };
    (delegated ? fixture.root : control).addEventListener('click', listener);
    return state;
}

function simpleNativeFixture(t, text, options) {
    const fixture = journalFixture(t, `<blockquote><p>${text}</p><button type="button" data-action="sendToChat">Share in chat</button></blockquote>`, options);
    fixture.native = bindNativeShare(fixture, fixture.root.querySelector('[data-action="sendToChat"]'));
    return fixture;
}

test('journal narration invokes the native delegated share action and preserves its complete message', async t => {
    const fixture = journalFixture(t, `
        <p>Private introduction outside the read-aloud box.</p>
        <div class="narrative" id="target"><p id="first">You follow the <strong>rocky path</strong>.</p><p>A <em>creature</em> waits.<br>It speaks.</p><a class="content-link" data-action="openDocument" data-uuid="Actor.creature">Suarrrok</a><a href="#" data-action="sendToChat"><i class="fas fa-comment-quote"></i>Share in chat</a><a data-action="readAloud">Native narration</a><span hidden>Hidden hint</span><section class="secret">The monster is an illusion.</section></div>
        <blockquote id="other"><p>Another passage must not be read.</p><button data-action="sendToChat">Share other passage</button></blockquote>
    `);
    const block = document.getElementById('target');
    const originalHTML = block.innerHTML;
    const message = nativeMessage('<section class="adventure-journal textured-parchment"><aside class="narrative"><p>You follow the <strong>rocky path</strong>.</p><p>A <em>creature</em> waits.<br>It speaks.</p><a class="content-link" data-uuid="Actor.creature">Suarrrok</a></aside></section>');
    const native = bindNativeShare(fixture, block.querySelector('[data-action="sendToChat"]'), { delegated: true, message });
    const other = bindNativeShare(fixture, document.querySelector('#other button'));
    fixture.narration.inject(fixture.root);

    const button = block.nextElementSibling;
    assert.ok(button.matches('button.acd-ta-journal-narrate'));
    assert.equal(button.type, 'button');
    assert.ok(button.getAttribute('aria-label'));
    assert.equal(block.innerHTML, originalHTML, 'Preserve the native box and its sharing controls');
    assert.equal(window.getSelection().rangeCount, 0);
    button.click();
    await nextTick();

    assert.equal(native.clicks, 1);
    assert.equal(other.clicks, 0);
    assert.deepEqual(fixture.posted, [message], 'Native content, flavor, speaker and flags pass through unchanged');
    assert.deepEqual(fixture.updated, [], 'Never replace the native date/flavor or add a second card');
    assert.deepEqual(fixture.spoken, [{
        voice: 'narrator-voice', actor: 'narrator',
        text: 'You follow the rocky path.\nA creature waits.\nIt speaks.\nSuarrrok',
        settings: { stability: 0.5 }
    }]);
    assert.deepEqual(fixture.notifications, []);
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute('aria-busy'), false);
    assert.equal(block.innerHTML, originalHTML);
});

test('original standalone share clicks stay speech-free and match the narrated message exactly', async t => {
    const fixture = simpleNativeFixture(t, 'A native passage.');
    fixture.narration.inject(fixture.root);
    fixture.root.querySelector('[data-action="sendToChat"]').click();
    await nextTick();
    assert.equal(fixture.native.clicks, 1);
    assert.equal(fixture.posted.length, 1);
    assert.deepEqual(fixture.spoken, []);

    fixture.root.querySelector('.acd-ta-journal-narrate').click();
    await nextTick();
    assert.equal(fixture.native.clicks, 2);
    assert.equal(fixture.posted.length, 2);
    assert.deepEqual(fixture.posted[1], fixture.posted[0]);
    assert.equal(fixture.spoken.length, 1);
    assert.deepEqual(fixture.updated, []);
});

test('Ember DOM control delegates sharing once and narrates only its two passage paragraphs', async t => {
    for (const translated of [false, true]) {
        await t.test(translated ? 'localized control identified by its stable class' : 'supplied Ember control markup', async t => {
            const fixture = journalFixture(t, `
                <section class="journal-page-content"><section class="exposition">
                    <h2 class="ember-header double" data-anchor="setting-the-scene">Setting the Scene</h2>
                    <div class="block readaloud" id="ember-passage">
                        <button type="button" class="readaloud-chat icon ${translated ? 'alternate-symbol' : 'fa-solid fa-message-quote'}" data-tooltip="${translated ? 'An den Chat senden' : 'EMBER.ReadaloudSendToChat'}" aria-label="${translated ? 'An den Chat senden' : 'Send to Chat'}"></button>
                        <p>A narrow stair winds toward the tower.</p>
                        <p>Two lanterns glow beside its locked door.</p>
                    </div>
                    <div class="block readaloud" id="ember-other"><button type="button" class="readaloud-chat icon fa-solid fa-message-quote" data-tooltip="EMBER.ReadaloudSendToChat" aria-label="Send to Chat"></button><p>A different passage stays unread.</p></div>
                </section></section>
            `);
            const block = document.getElementById('ember-passage');
            const originalHTML = block.innerHTML;
            const message = nativeMessage('<section class="ember-journal"><div class="block readaloud"><p>A narrow stair winds toward the tower.</p><p>Two lanterns glow beside its locked door.</p></div></section>');
            // The screenshot supplies Ember's DOM. Its private share handler is mocked here.
            const native = bindNativeShare(fixture, block.querySelector('.readaloud-chat'), { delegated: true, message });
            const other = bindNativeShare(fixture, document.querySelector('#ember-other .readaloud-chat'));
            fixture.narration.inject(fixture.root);
            assert.equal(window.getSelection().rangeCount, 0);
            const button = block.nextElementSibling;
            assert.ok(button.matches('.acd-ta-journal-narrate'));
            button.click();
            await nextTick();
            assert.equal(native.clicks, 1);
            assert.equal(other.clicks, 0);
            assert.deepEqual(fixture.posted, [message]);
            assert.deepEqual(fixture.updated, []);
            assert.equal(fixture.spoken.length, 1);
            assert.deepEqual(fixture.spoken[0].text.split('\n').map(line => line.trim()).filter(Boolean), [
                'A narrow stair winds toward the tower.',
                'Two lanterns glow beside its locked door.'
            ]);
            assert.equal(block.innerHTML, originalHTML);
            assert.deepEqual(fixture.notifications, []);
        });
    }
});

test('native sharing controls added after journal rendering are discovered when clicked', async t => {
    const fixture = journalFixture(t, '<blockquote><p>A late share control.</p></blockquote>');
    const block = fixture.root.querySelector('blockquote');
    fixture.narration.inject(fixture.root);
    const control = document.createElement('button');
    control.dataset.action = 'share-to-chat';
    control.textContent = 'Late share in chat';
    block.append(control);
    const native = bindNativeShare(fixture, control);
    fixture.root.querySelector('.acd-ta-journal-narrate').click();
    await nextTick();
    assert.equal(native.clicks, 1);
    assert.equal(fixture.posted.length, 1);
    assert.equal(fixture.spoken[0].text, 'A late share control.');
});

test('actionable native quote controls work without changing their listener or markup', async t => {
    const fixture = journalFixture(t, '<blockquote><p>A quoted passage.</p><a href="#" title="Send to chat"><i class="fas fa-quote-right"></i></a></blockquote>');
    const control = fixture.root.querySelector('a');
    const native = bindNativeShare(fixture, control);
    fixture.narration.inject(fixture.root);
    fixture.root.querySelector('.acd-ta-journal-narrate').click();
    await nextTick();
    assert.equal(native.clicks, 1);
    assert.equal(fixture.spoken[0].text, 'A quoted passage.');
    assert.ok(control.querySelector('.fa-quote-right'));
});

test('bare SVG quote controls dispatch a bubbling native click without an HTMLElement click method', async t => {
    const fixture = journalFixture(t, '<blockquote><p>A passage beside an SVG control.</p><svg data-icon="comment-quote" viewBox="0 0 24 24"><title>Share passage</title><path d="M0 0h24v24H0z"/></svg></blockquote>');
    const control = fixture.root.querySelector('svg');
    assert.equal(typeof control.click, 'undefined');
    const native = bindNativeShare(fixture, control, { delegated: true });
    fixture.narration.inject(fixture.root);
    fixture.root.querySelector('.acd-ta-journal-narrate').click();
    await nextTick();
    assert.equal(native.clicks, 1);
    assert.deepEqual(fixture.posted, [native.message]);
    assert.equal(fixture.spoken[0].text, 'A passage beside an SVG control.');
    assert.deepEqual(fixture.updated, []);
    assert.deepEqual(fixture.notifications, []);
});

test('native controls can be identified by their sharing labels without a recognized icon or action', async t => {
    for (const [attribute, label] of [['title', 'Send to chat'], ['aria-label', 'Share to Chat'], ['data-tooltip', 'Post to chat']]) {
        await t.test(attribute, async t => {
            const fixture = journalFixture(t, `<blockquote><p>A labeled share control.</p><a href="#" ${attribute}="${label}">Original native control</a></blockquote>`);
            const native = bindNativeShare(fixture, fixture.root.querySelector('a'));
            fixture.narration.inject(fixture.root);
            fixture.root.querySelector('.acd-ta-journal-narrate').click();
            await nextTick();
            assert.equal(native.clicks, 1);
            assert.deepEqual(fixture.posted, [native.message]);
            assert.equal(fixture.spoken[0].text, 'A labeled share control.');
            assert.deepEqual(fixture.notifications, []);
        });
    }
});

test('DDB sibling controls are limited to the selected passage wrapper', async t => {
    const fixture = journalFixture(t, `
        <div class="ddbimporter-image-container"><blockquote id="first">First imported passage.</blockquote><a class="ddbimporter-to-chat" href="#">Share first</a></div>
        <div class="ddbimporter-image-container"><blockquote id="second">Second imported passage.</blockquote><a class="ddbimporter-to-chat" href="#">Share second</a></div>
    `);
    const controls = fixture.root.querySelectorAll('.ddbimporter-to-chat');
    const first = bindNativeShare(fixture, controls[0]);
    const second = bindNativeShare(fixture, controls[1]);
    fixture.narration.inject(fixture.root);
    document.getElementById('second').nextElementSibling.click();
    await nextTick();
    assert.equal(first.clicks, 0);
    assert.equal(second.clicks, 1);
    assert.equal(fixture.posted.length, 1);
    assert.equal(fixture.spoken[0].text, 'Second imported passage.');
});

test('DDB hover-generated native share controls can be activated without selecting text', async t => {
    const fixture = journalFixture(t, '<div class="ddbimporter-image-container"><blockquote>Hover-created sharing.</blockquote></div>');
    const wrapper = fixture.root.querySelector('.ddbimporter-image-container');
    let native;
    wrapper.addEventListener('mouseenter', () => {
        if (native) return;
        const control = document.createElement('a');
        control.className = 'ddbimporter-to-chat';
        control.href = '#';
        control.textContent = 'Share imported text';
        wrapper.append(control);
        native = bindNativeShare(fixture, control);
    });
    fixture.narration.inject(fixture.root);
    fixture.root.querySelector('.acd-ta-journal-narrate').click();
    await nextTick();
    assert.equal(native?.clicks, 1);
    assert.equal(fixture.posted.length, 1);
    assert.equal(fixture.spoken[0].text, 'Hover-created sharing.');
});

test('DDB delegated mouseover creates the share control without a second hover initialization', async t => {
    const fixture = journalFixture(t, '<div class="ddbimporter-image-container"><blockquote>Delegated hover sharing.</blockquote></div>');
    const wrapper = fixture.root.querySelector('.ddbimporter-image-container');
    let native;
    let mouseEnterCount = 0;
    fixture.root.addEventListener('mouseover', event => {
        if (event.target !== wrapper || native) return;
        const control = document.createElement('a');
        control.className = 'ddbimporter-to-chat';
        control.href = '#';
        wrapper.append(control);
        native = bindNativeShare(fixture, control, { delegated: true });
    });
    wrapper.addEventListener('mouseenter', () => mouseEnterCount++);
    fixture.narration.inject(fixture.root);
    fixture.root.querySelector('.acd-ta-journal-narrate').click();
    await nextTick();
    assert.equal(native?.clicks, 1);
    assert.equal(mouseEnterCount, 0);
    assert.equal(wrapper.querySelectorAll('.ddbimporter-to-chat').length, 1);
    assert.equal(fixture.posted.length, 1);
    assert.equal(fixture.spoken[0].text, 'Delegated hover sharing.');
});

test('missing native sharing gives an error without posting an imitation card or narrating', async t => {
    const fixture = journalFixture(t, '<blockquote><p>No native sharing here.</p><a class="content-link" data-action="openDocument">An actor link</a></blockquote><button data-action="sendToChat">Unrelated page share</button>');
    const unrelated = bindNativeShare(fixture, fixture.root.querySelector('button'));
    fixture.narration.inject(fixture.root);
    const button = fixture.root.querySelector('.acd-ta-journal-narrate');
    button.click();
    await nextTick();
    assert.equal(unrelated.clicks, 0);
    assert.deepEqual(fixture.posted, []);
    assert.deepEqual(fixture.spoken, []);
    assert.equal(fixture.notifications.length, 1);
    assert.match(fixture.notifications[0], /share|native|journal/i);
    assert.equal(button.disabled, false);
});

test('rendering common read-aloud boxes repeatedly adds one button per outer passage', t => {
    const fixture = journalFixture(t, `
        <blockquote id="plain">A plain quote.</blockquote>
        <div class="narrative" id="nested"><blockquote>A nested quote.</blockquote></div>
        <div class="read-aloud-text">Read-aloud text.</div>
        <div class="read-aloud">Read aloud.</div>
        <div class="readaloud">Readaloud.</div>
        <div class="adventure-read-aloud-text">Adventure text.</div>
        <div class="ddb-blockquote">Imported quote.</div>
        <blockquote><button>Share empty quote</button></blockquote>
    `);
    fixture.narration.inject(fixture.root);
    fixture.narration.inject([fixture.root]);
    fixture.narration.inject(document.getElementById('nested'));
    const buttons = fixture.root.querySelectorAll('.acd-ta-journal-narrate');
    assert.equal(buttons.length, 7);
    assert.equal(document.querySelector('#nested .acd-ta-journal-narrate'), null);
    assert.ok(document.getElementById('nested').nextElementSibling.matches('.acd-ta-journal-narrate'));
    assert.ok(document.getElementById('plain').nextElementSibling.matches('.acd-ta-journal-narrate'));
});

test('editor content and unrevealed or hidden passages have no narration action', t => {
    const fixture = journalFixture(t, `
        <div contenteditable="true"><blockquote>Being edited.</blockquote></div>
        <div contenteditable><blockquote>Also being edited.</blockquote></div>
        <div contenteditable="plaintext-only"><blockquote>Plain text editing.</blockquote></div>
        <div class="secret"><blockquote>GM only.</blockquote></div>
        <blockquote class="secret">Another secret.</blockquote>
        <section hidden><blockquote>Hidden passage.</blockquote></section>
        <blockquote hidden>Also hidden.</blockquote>
        <blockquote class="secret revealed" id="public">Revealed to players.</blockquote>
    `);
    fixture.narration.inject(fixture.root);
    assert.equal(fixture.root.querySelectorAll('.acd-ta-journal-narrate').length, 1);
    assert.ok(document.getElementById('public').nextElementSibling.matches('.acd-ta-journal-narrate'));
});

test('unauthorized users cannot add buttons or activate a previously rendered button', async t => {
    const fixture = simpleNativeFixture(t, 'Read me.', { accessible: false });
    fixture.narration.inject(fixture.root);
    assert.equal(fixture.root.querySelector('.acd-ta-journal-narrate'), null);
    fixture.access.allowed = true;
    fixture.narration.inject(fixture.root);
    const button = fixture.root.querySelector('.acd-ta-journal-narrate');
    assert.ok(button);
    fixture.access.allowed = false;
    button.click();
    await nextTick();
    assert.equal(fixture.native.clicks, 0);
    assert.deepEqual(fixture.posted, []);
    assert.deepEqual(fixture.spoken, []);
});

test('native journal sharing works when automatic spoken-text chat posting is disabled', async t => {
    const fixture = simpleNativeFixture(t, 'Share this passage.', { postToChat: false });
    fixture.narration.inject(fixture.root);
    fixture.root.querySelector('.acd-ta-journal-narrate').click();
    await nextTick();
    assert.equal(fixture.native.clicks, 1);
    assert.equal(fixture.posted.length, 1);
    assert.equal(fixture.spoken.length, 1);
    assert.equal(fixture.spoken[0].text, 'Share this passage.');
    assert.deepEqual(fixture.updated, []);
});

test('pending narration disables repeat clicks and reenables the button when complete', async t => {
    let completeSpeech;
    const pendingSpeech = new Promise(resolve => { completeSpeech = resolve; });
    const fixture = simpleNativeFixture(t, 'A long narration.', { speak: () => pendingSpeech });
    fixture.narration.inject(fixture.root);
    const button = fixture.root.querySelector('.acd-ta-journal-narrate');
    button.click();
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    button.click();
    await fixture.narration.activate(button.previousElementSibling, button);
    assert.equal(fixture.native.clicks, 1);
    assert.equal(fixture.posted.length, 1);
    assert.equal(fixture.spoken.length, 1);
    completeSpeech('long-history-id');
    await nextTick();
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute('aria-busy'), false);
    assert.deepEqual(fixture.updated, []);
});

test('failed narration reports the error and leaves the button usable for a retry', async t => {
    let fail = true;
    const fixture = simpleNativeFixture(t, 'Try to read this.', {
        speak: () => {
            if (fail) throw new Error('ElevenLabs request failed: HTTP 429');
            return 'retry-history-id';
        }
    });
    fixture.narration.inject(fixture.root);
    const button = fixture.root.querySelector('.acd-ta-journal-narrate');
    button.click();
    await nextTick();
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute('aria-busy'), false);
    assert.deepEqual(fixture.notifications, ['Talking Actors: ElevenLabs request failed: HTTP 429']);
    fail = false;
    button.click();
    await nextTick();
    assert.equal(fixture.native.clicks, 2);
    assert.equal(fixture.posted.length, 2);
    assert.equal(fixture.spoken.length, 2);
    assert.deepEqual(fixture.updated, []);
});

test('missing narrator or voice explains the configuration problem without invoking native sharing', async t => {
    for (const missing of ['narrator', 'voice']) {
        await t.test(missing, async t => {
            const fixture = simpleNativeFixture(t, 'Read this aloud.');
            if (missing === 'narrator') fixture.settings.set('narrating-actor', '');
            else fixture.connector.getVoiceIdFromActor = () => null;
            fixture.narration.inject(fixture.root);
            const button = fixture.root.querySelector('.acd-ta-journal-narrate');
            button.click();
            await nextTick();
            assert.equal(fixture.native.clicks, 0);
            assert.deepEqual(fixture.posted, []);
            assert.deepEqual(fixture.spoken, []);
            assert.equal(fixture.notifications.length, 1);
            assert.match(fixture.notifications[0], missing === 'narrator' ? /noNarratorConfigured/ : /noVoiceConfigured/);
            assert.equal(button.disabled, false);
        });
    }
});
