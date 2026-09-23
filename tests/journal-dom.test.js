import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { ChatProcessor } from '../scripts/chat-processor.js';

globalThis.window = {};
globalThis.Hooks = { once() {}, on() {} };
globalThis.Handlebars = { registerHelper() {} };
await import('../scripts/main.js');
const Main = window.ACDTalkingActors;
const menuSource = await readFile(new URL('../scripts/libs/context-menu.min.js', import.meta.url), 'utf8');
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const selectedHTML = 'The <strong>creature</strong> stares.<br>Then it speaks.';
const spokenText = 'The creature stares.\nThen it speaks.';

function journalFixture(t, { enabled = true } = {}) {
    const dom = new JSDOM(`<!doctype html><body>
        <nav id="sidebar"><a id="journal-link" href="#journal">Open journal</a></nav>
        <section class="journal-entry-pages"><article class="journal-page-content">
            <p id="passage">${selectedHTML}</p>
        </article></section>
    </body>`, { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.DOMParser = dom.window.DOMParser;
    dom.window.eval(`${menuSource}\nwindow.ContextMenuNT = ContextMenuNT;`);
    globalThis.ContextMenuNT = dom.window.ContextMenuNT;

    const settings = new Map([
        ['enableContextMenuOnSelection', enabled],
        ['allow-users', true],
        ['narrating-actor', 'narrator'],
        ['postSpokenTextToChat', true]
    ]);
    const actors = [{ _id: 'narrator', name: 'Narrator' }, { _id: 'actor', name: 'Current Actor' }];
    globalThis.game = {
        user: { id: 'gm', isGM: true },
        settings: { get: (_, key) => settings.get(key), register() {} },
        i18n: { localize: key => key },
        data: { release: { generation: 14 } },
        modules: new Map(),
        actors: {
            get: id => actors.find(actor => actor._id === id),
            find: predicate => actors.find(predicate)
        }
    };
    globalThis.CONST = { CHAT_MESSAGE_STYLES: { IC: 1, OOC: 2 } };
    const spoken = [], posted = [], commands = [], notifications = [];
    globalThis.ChatMessage = {
        getSpeaker: () => ({ actor: 'actor' }),
        create: async data => {
            posted.push(data);
            return { update: async () => {} };
        }
    };
    const connector = {
        getVoiceIdFromActor: actor => `${actor._id}-voice`,
        getVoiceSettingsFromActor: () => ({}),
        textToSpeech: async (voice, actor, text) => {
            spoken.push({ voice, actor: actor._id, text });
            return 'history-id';
        }
    };
    Main.instance = null;
    const main = new Main();
    main.logger = logger;
    main.ttsConnector = connector;
    main.chatProcessor = new ChatProcessor(connector, logger);
    globalThis.ui = {
        notifications: { error: message => notifications.push(message), warn: message => notifications.push(message) },
        chat: { processMessage: command => {
            commands.push(command);
            return main.chatProcessor.processChatMessage(ui.chat, command, {
                user: game.user.id, speaker: ChatMessage.getSpeaker()
            });
        } }
    };
    main.createJournalContextMenu();
    main.initializeJournalEntryContextMenu();

    const selectPassage = () => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('passage'));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    };
    const openMenu = async () => {
        const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
        document.querySelector('#passage strong').dispatchEvent(event);
        await new Promise(resolve => setTimeout(resolve, 5));
        return event;
    };
    return { main, settings, spoken, posted, commands, notifications, selectPassage, openMenu };
}

test('real journal selection and menu clicks speak through all four choices after focus clears selection', async t => {
    const fixture = journalFixture(t);
    const expected = [
        { command: 'narrate', voice: 'narrator-voice', actor: 'narrator', posts: 1 },
        { command: 'narrate-s', voice: 'narrator-voice', actor: 'narrator', posts: 1 },
        { command: 'talk', voice: 'actor-voice', actor: 'actor', posts: 2 },
        { command: 'talk-s', voice: 'actor-voice', actor: 'actor', posts: 2 }
    ];
    for (const [index, choice] of expected.entries()) {
        fixture.selectPassage();
        const event = await fixture.openMenu();
        assert.equal(event.defaultPrevented, true);
        assert.equal(fixture.main.contextMenu.isOpen(), true);
        assert.equal(fixture.main.journalSelection, selectedHTML);
        window.getSelection().removeAllRanges();
        const menuLabel = document.querySelectorAll('.context-menu-default-text')[index];
        menuLabel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(fixture.commands[index], `/${choice.command} ${selectedHTML}`);
        assert.deepEqual(fixture.spoken[index], { voice: choice.voice, actor: choice.actor, text: spokenText });
        assert.equal(fixture.posted.length, choice.posts);
        assert.equal(fixture.main.contextMenu.isOpen(), false);
    }
    assert.equal(fixture.posted[0].style, CONST.CHAT_MESSAGE_STYLES.OOC);
    assert.equal(fixture.posted[1].style, CONST.CHAT_MESSAGE_STYLES.IC);
    assert.equal(fixture.posted[0].content, `<span class="acd-ta-talked">${selectedHTML}</span>`);
    assert.equal(fixture.posted[1].content, `<span class="acd-ta-talked">${selectedHTML}</span>`);
    assert.deepEqual(fixture.notifications, []);
});

test('journal context menu leaves normal sidebar navigation and unselected content alone', async t => {
    const fixture = journalFixture(t);
    const event = await fixture.openMenu();
    assert.equal(event.defaultPrevented, false);
    assert.equal(fixture.main.contextMenu.isOpen(), false);
    let clicked = 0;
    const link = document.getElementById('journal-link');
    link.addEventListener('click', () => { clicked++; });
    fixture.selectPassage();
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    assert.equal(clicked, 1);
    assert.equal(click.defaultPrevented, false);
    const context = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    link.dispatchEvent(context);
    assert.equal(context.defaultPrevented, false);
    assert.equal(fixture.main.contextMenu.isOpen(), false);
    assert.deepEqual(fixture.commands, []);
    assert.deepEqual(fixture.spoken, []);
});

test('choosing Narrator without a configured narrator reports why speech cannot play', async t => {
    const fixture = journalFixture(t);
    fixture.settings.set('narrating-actor', '');
    fixture.selectPassage();
    await fixture.openMenu();
    window.getSelection().removeAllRanges();
    document.querySelector('.context-menu-default-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fixture.commands, [`/narrate ${selectedHTML}`]);
    assert.deepEqual(fixture.spoken, []);
    assert.ok(fixture.notifications.some(message => /narrator|voice/i.test(message)), 'Explain the missing narrator or voice instead of silently producing no audio');
});
