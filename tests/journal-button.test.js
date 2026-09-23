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

test('journal button posts one formatted passage and narrates without selection or native sharing clicks', async t => {
    const fixture = journalFixture(t, `
        <p>Private introduction outside the read-aloud box.</p>
        <div class="narrative" id="target"><p id="first">You follow the <strong>rocky path</strong>.</p><p>A <em>creature</em> waits.<br>It speaks.</p><a class="content-link" data-action="openDocument" data-uuid="Actor.creature">Suarrrok</a><button data-action="share">Share in chat</button><a class="ddbimporter-to-chat">Imported share</a><a data-action="readAloud">Native narration</a><span hidden>Hidden hint</span><section class="secret">The monster is an illusion.</section></div>
        <blockquote id="other"><p>Another passage must not be read.</p></blockquote>
    `);
    const block = document.getElementById('target');
    const originalHTML = block.innerHTML;
    let nativeClicks = 0;
    let delegatedClicks = 0;
    block.querySelector('button').addEventListener('click', () => nativeClicks++);
    fixture.root.addEventListener('click', () => delegatedClicks++);
    fixture.narration.inject(fixture.root);

    const button = block.nextElementSibling;
    assert.ok(button.matches('button.acd-ta-journal-narrate'));
    assert.equal(button.type, 'button');
    assert.ok(button.getAttribute('aria-label'));
    assert.equal(block.innerHTML, originalHTML, 'Preserve the native box and its sharing controls');
    assert.equal(window.getSelection().rangeCount, 0);
    button.click();
    await nextTick();

    assert.equal(nativeClicks, 0);
    assert.equal(delegatedClicks, 0, 'Do not also invoke the journal system\'s delegated actions');
    assert.equal(fixture.posted.length, 1);
    const message = fixture.posted[0];
    assert.equal(message.style, CONST.CHAT_MESSAGE_STYLES.OOC);
    assert.equal(message.user, 'gm');
    assert.equal(message.speaker.actor, null);
    const card = new DOMParser().parseFromString(message.content, 'text/html');
    assert.ok(card.querySelector('.acd-ta-narration-card'));
    assert.equal(card.querySelector('strong').textContent, 'rocky path');
    assert.equal(card.querySelector('em').textContent, 'creature');
    assert.equal(card.querySelectorAll('p').length, 2);
    assert.equal(card.querySelector('.content-link').dataset.uuid, 'Actor.creature');
    assert.equal(card.querySelectorAll('button, [id], .secret, [hidden], .ddbimporter-to-chat').length, 0);
    assert.doesNotMatch(card.body.textContent, /Private introduction|Another passage|Share in chat|Imported share|Native narration|Hidden hint|illusion/);
    assert.deepEqual(fixture.spoken, [{
        voice: 'narrator-voice', actor: 'narrator',
        text: 'You follow the rocky path.\nA creature waits.\nIt speaks.\nSuarrrok',
        settings: { stability: 0.5 }
    }]);
    assert.equal(fixture.updated.length, 1);
    assert.match(fixture.updated[0].flavor, /acd-ta-replay.*data-item-id="history-id"/);
    assert.deepEqual(fixture.notifications, []);
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute('aria-busy'), false);
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
    const fixture = journalFixture(t, '<blockquote>Read me.</blockquote>', { accessible: false });
    fixture.narration.inject(fixture.root);
    assert.equal(fixture.root.querySelector('.acd-ta-journal-narrate'), null);
    fixture.access.allowed = true;
    fixture.narration.inject(fixture.root);
    const button = fixture.root.querySelector('.acd-ta-journal-narrate');
    assert.ok(button);
    fixture.access.allowed = false;
    button.click();
    await nextTick();
    assert.deepEqual(fixture.posted, []);
    assert.deepEqual(fixture.spoken, []);
});

test('explicit journal posting works when automatic spoken-text chat posting is disabled', async t => {
    const fixture = journalFixture(t, '<blockquote><p>Share this passage.</p></blockquote>', { postToChat: false });
    fixture.narration.inject(fixture.root);
    fixture.root.querySelector('.acd-ta-journal-narrate').click();
    await nextTick();
    assert.equal(fixture.posted.length, 1);
    assert.equal(fixture.spoken.length, 1);
    assert.equal(fixture.spoken[0].text, 'Share this passage.');
});

test('pending narration disables repeat clicks and reenables the button when complete', async t => {
    let completeSpeech;
    const pendingSpeech = new Promise(resolve => { completeSpeech = resolve; });
    const fixture = journalFixture(t, '<blockquote>A long narration.</blockquote>', { speak: () => pendingSpeech });
    fixture.narration.inject(fixture.root);
    const button = fixture.root.querySelector('.acd-ta-journal-narrate');
    button.click();
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    button.click();
    await fixture.narration.activate(button.previousElementSibling, button);
    assert.equal(fixture.posted.length, 1);
    assert.equal(fixture.spoken.length, 1);
    completeSpeech('long-history-id');
    await nextTick();
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute('aria-busy'), false);
    assert.match(fixture.updated[0].flavor, /long-history-id/);
});

test('failed narration reports the error and leaves the button usable for a retry', async t => {
    let fail = true;
    const fixture = journalFixture(t, '<blockquote>Try to read this.</blockquote>', {
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
    assert.equal(fixture.spoken.length, 2);
    assert.match(fixture.updated[0].flavor, /retry-history-id/);
});

test('missing narrator or voice explains the configuration problem without posting a silent card', async t => {
    for (const missing of ['narrator', 'voice']) {
        await t.test(missing, async t => {
            const fixture = journalFixture(t, '<blockquote>Read this aloud.</blockquote>');
            if (missing === 'narrator') fixture.settings.set('narrating-actor', '');
            else fixture.connector.getVoiceIdFromActor = () => null;
            fixture.narration.inject(fixture.root);
            const button = fixture.root.querySelector('.acd-ta-journal-narrate');
            button.click();
            await nextTick();
            assert.deepEqual(fixture.posted, []);
            assert.deepEqual(fixture.spoken, []);
            assert.equal(fixture.notifications.length, 1);
            assert.match(fixture.notifications[0], missing === 'narrator' ? /noNarratorConfigured/ : /noVoiceConfigured/);
            assert.equal(button.disabled, false);
        });
    }
});
