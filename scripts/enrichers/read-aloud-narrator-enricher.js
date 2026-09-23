import TalkingActorsConstants from "../constants.js";

/**
 * ReadAloudNarratorEnricher
 *
 * Enricher that processes custom "ReadAloud" inline tags of the form:
 *   @Narrate{content}

 * The enricher extracts content, resolves the _id of the configured narrating actor, and
 * renders a clickable template that will invoke game.acdTalkingActors.readAloudNarrator(content)
 * when clicked.
 */

export class ReadAloudNarratorEnricher {
    name;

    constructor() {
        this.name = 'Narrate';
    }

    label = "TA - Talking Actors - Narrate";
    pattern = /@Narrate\{([^}]+)\}/g;
    enricher = async (match, options) => {
        const narrator = undefined;
        const html = await foundry.applications.handlebars.renderTemplate(
            TalkingActorsConstants.PATHS.TEMPLATES + 'readaloud-table.hbs', {
                label: this.label,
                mode: "narrator",
                narrator,
                content: match[1],
            }
        );
        return $(html)[0];
    };
}
