import { localize, speechText } from "./libs/functions.js";

// Boxed prose, including common adventure and imported-journal read-aloud markup.
const BLOCK_SELECTOR = 'blockquote, .narrative, .read-aloud, .read-aloud-text, .readaloud, .adventure-read-aloud-text, .ddb-blockquote';
const UNREADABLE_SELECTOR = '[contenteditable]:not([contenteditable="false"]), .secret:not(.revealed), [hidden]';
const OMIT_SELECTOR = 'button, .acd-ta-journal-narrate, .journal-header, .ddbimporter-to-chat, .ddbimporter-read-aloud, .secret:not(.revealed), [hidden], script, style';
// Ember's readaloud-chat button is inside its .block.readaloud passage.
const SHARE_SELECTOR = 'button.readaloud-chat, .ddbimporter-to-chat, [data-action="sendToChat"], [data-action="shareToChat"], [data-action="toChat"], [data-action="postToChat"], [data-action="send-to-chat"], [data-action="share-to-chat"]';
const QUOTE_ICON_SELECTOR = '.fa-comment-quote, .fa-message-quote, .fa-quote-right, [data-icon="comment-quote"], [data-icon="message-quote"], [data-icon="quote-right"]';
const CONTROL_SELECTOR = 'button, a, [role="button"], [data-action]';

/** Locate an existing passage action; the journal keeps ownership of its handler. */
function findShareControl(root) {
    const controls = [...root.querySelectorAll(SHARE_SELECTOR)];
    for (const element of root.querySelectorAll('[title], [aria-label], [data-tooltip]')) {
        const labels = ['title', 'aria-label', 'data-tooltip'].map(name =>
            (element.getAttribute(name) ?? '').replace(/[^a-z]/gi, '').toLowerCase());
        if (labels.some(label => /(?:send|share|post)tochat/.test(label))) {
            controls.push(element.closest(CONTROL_SELECTOR) ?? element);
        }
    }
    // Adventure modules also use quote icons without a standardized data-action.
    for (const icon of root.querySelectorAll(QUOTE_ICON_SELECTOR)) {
        controls.push(icon.closest(CONTROL_SELECTOR) ?? icon);
    }
    return controls.find(control => control !== root && root.contains(control)
        && !control.closest(`${UNREADABLE_SELECTOR}, .acd-ta-journal-narrate, :disabled, [aria-disabled="true"]`));
}

function passageShareControl(block) {
    const control = findShareControl(block);
    if (control) return control;
    // DDB Importer creates a sibling share control only while hovering its wrapper.
    // Do not search the whole journal: that could share a different passage.
    const wrapper = block.parentElement;
    if (!wrapper?.matches('.ddbimporter-image-container')) return null;
    const existing = findShareControl(wrapper);
    if (existing) return existing;
    const MouseEvent = block.ownerDocument.defaultView.MouseEvent;
    for (const type of ['mouseover', 'mouseenter']) {
        wrapper.dispatchEvent(new MouseEvent(type, { bubbles: type === 'mouseover' }));
        const control = findShareControl(wrapper);
        if (control) return control;
    }
    return null;
}

/** Read only the chosen passage, without its sharing controls or hidden GM notes. */
export function journalBlockContent(block) {
    const copy = block.cloneNode(true);
    findShareControl(copy)?.remove();
    copy.querySelectorAll(OMIT_SELECTOR).forEach(element => element.remove());
    copy.querySelectorAll('[data-action]:not(.content-link)').forEach(element => element.remove());
    copy.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    return copy.innerHTML.trim();
}

/** Add a separate narration action alongside a journal's existing sharing controls. */
export class JournalNarration {
    buttons = new WeakMap();

    constructor(module) {
        this.module = module;
    }

    inject(html) {
        if (!this.module.isModuleAccessible()) return;
        const root = html?.querySelectorAll ? html : html?.[0];
        if (!root?.querySelectorAll) return;
        const blocks = [...root.querySelectorAll(BLOCK_SELECTOR)];
        if (root.matches?.(BLOCK_SELECTOR)) blocks.unshift(root);
        for (const block of blocks) {
            if (block.closest(UNREADABLE_SELECTOR)) continue;
            // A read-aloud wrapper may itself contain a blockquote: give the whole box one action.
            if (block.parentElement?.closest(BLOCK_SELECTOR)) continue;
            if (this.buttons.get(block)?.parentNode) continue;
            if (!speechText(journalBlockContent(block))) continue;

            const button = block.ownerDocument.createElement('button');
            button.type = 'button';
            button.className = 'acd-ta-journal-narrate';
            button.title = localize('acd.ta.journal.postAndNarrate');
            button.setAttribute('aria-label', button.title);
            const icon = block.ownerDocument.createElement('i');
            icon.className = 'fas fa-volume-high';
            icon.setAttribute('aria-hidden', 'true');
            button.append(icon, block.ownerDocument.createTextNode(` ${button.title}`));
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                void this.activate(block, button);
            });
            // Keep D&D5e's last-child border decoration and native share control intact.
            block.after(button);
            this.buttons.set(block, button);
        }
    }

    async activate(block, button) {
        if (button.disabled || !this.module.isModuleAccessible() || block.closest(UNREADABLE_SELECTOR)) return;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        try {
            // Resolve at click time so controls installed by later render hooks are found.
            const shareControl = passageShareControl(block);
            if (!shareControl) throw new Error(localize('acd.ta.journal.noShareControl'));
            const content = journalBlockContent(block);
            if (!speechText(content)) return;
            await this.module.chatProcessor.narrateJournalBlock(content, () => {
                if (typeof shareControl.click === 'function') shareControl.click();
                else {
                    // Standalone Font Awesome SVG controls lack HTMLElement.click().
                    const MouseEvent = block.ownerDocument.defaultView.MouseEvent;
                    shareControl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                }
            });
        } catch (error) {
            this.module.logger.error('Journal narration failed:', error);
            ui.notifications.error(`Talking Actors: ${error.message}`);
        } finally {
            button.disabled = false;
            button.removeAttribute('aria-busy');
        }
    }
}
