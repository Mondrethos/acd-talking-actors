import TalkingActorsConstants from "../constants.js";

/**
 * ReadAloudEnricher
 *
 * Enricher that processes custom "ReadAloud" inline tags of the form:
 *   @ReadAloud{content}
 *
 * The enricher extracts the content, and invokes game.acdTalkingActors.readAloudCurrentActor(content)
 * when clicked.
 */
export class ReadAloudEnricher {
    name;

    constructor() {
        this.name = 'ReadAloud';
    }

    label = "TA - Talking Actors - Read Aloud";
    pattern = /@ReadAloud\{([^}]+)\}/g;
    enricher = async (match, options) => {
        const narrator = undefined;
        const html = await foundry.applications.handlebars.renderTemplate(
            TalkingActorsConstants.PATHS.TEMPLATES + 'readaloud-table.hbs', {
                label: this.label,
                mode: "current",
                narrator,
                content: match[1],
            }
        );
        return $(html)[0];
    };
}
