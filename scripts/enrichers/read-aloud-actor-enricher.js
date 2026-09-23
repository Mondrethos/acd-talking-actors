import TalkingActorsConstants from "../constants.js";

/**
 * ReadAloudActorEnricher
 *
 * Enricher that processes custom "ReadAloud" inline tags of the form:
 *   @ReadAloud[narrator]{content}
 *
 * The enricher extracts the narrator and content, resolves a display name
 * for the narrator (if an actor ID is provided it will attempt to look up
 * the actor's name via game.actors), and renders a clickable template that
 * will invoke game.acdTalkingActors.readAloud(content, true, { narrator })
 * when clicked.
 */

export class ReadAloudActorEnricher {
    name;

    constructor() {
        this.name = 'ReadAloud';
    }

    label = "TA - Talking Actors - Read Aloud Actor";
    pattern = /@ReadAloud\[([^\]]+)\]\{([^}]+)\}/g;
    enricher = async (match, options) => {
        const narrator = match[1];
        const html = await foundry.applications.handlebars.renderTemplate(
            TalkingActorsConstants.PATHS.TEMPLATES + 'readaloud-table.hbs', {
                label: `TA - Talking Actors - Read Aloud for ${game.actors.get(narrator)?.name ?? narrator}`,
                mode: "actor",
                narrator,
                content: match[2],
            }
        );
        return $(html)[0];
    };
}
