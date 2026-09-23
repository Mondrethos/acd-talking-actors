import { localize, speechText } from "./libs/functions.js";

// Boxed prose, including common adventure and imported-journal read-aloud markup.
const BLOCK_SELECTOR = 'blockquote, .narrative, .read-aloud, .read-aloud-text, .readaloud, .adventure-read-aloud-text, .ddb-blockquote';
const UNREADABLE_SELECTOR = '[contenteditable]:not([contenteditable="false"]), .secret:not(.revealed), [hidden]';
const OMIT_SELECTOR = 'button, .acd-ta-journal-narrate, .journal-header, .ddbimporter-to-chat, .ddbimporter-read-aloud, .secret:not(.revealed), [hidden], script, style';

/** Read only the chosen passage, without its sharing controls or hidden GM notes. */
export function journalBlockContent(block) {
    const copy = block.cloneNode(true);
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
        const content = journalBlockContent(block);
        if (!speechText(content)) return;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        try {
            await this.module.chatProcessor.narrateJournalBlock(content);
        } catch (error) {
            this.module.logger.error('Journal narration failed:', error);
            ui.notifications.error(`Talking Actors: ${error.message}`);
        } finally {
            button.disabled = false;
            button.removeAttribute('aria-busy');
        }
    }
}
