# Talking Actors — Mondrethos fork

This fork is maintained by **[Mondrethos](https://github.com/Mondrethos)** and is based on **[Acd-Jake's original Talking Actors module](https://github.com/acd-jake/acd-talking-actors)**. It includes fixes for long audio delivery and journal read-aloud controls.

![GitHub Release](https://img.shields.io/github/v/release/Mondrethos/acd-talking-actors?display_name=tag&style=for-the-badge&label=Latest%20Release)

![Latest Release Download Count](https://img.shields.io/github/downloads/Mondrethos/acd-talking-actors/latest/module.zip?color=2b82fc&label=LATEST%20VERSION%20DOWNLOADS&style=for-the-badge)

![Foundry Core Compatible Version](https://img.shields.io/badge/dynamic/json.svg?url=https%3A%2F%2Fgithub.com%2FMondrethos%2Facd-talking-actors%2Freleases%2Flatest%2Fdownload%2Fmodule.json&label=Foundry%20Version&query=$.compatibility.verified&colorB=orange&style=for-the-badge)

![GitHub all releases](https://img.shields.io/github/downloads/Mondrethos/acd-talking-actors/total?label=TOTAL%20DOWNLOADS&style=for-the-badge)

acd-talking-actors is a FoundryVTT module that brings immersive, AI-powered voice and sound features to your tabletop games. It enables actors and narrators to speak using customizable text-to-speech (TTS) integration, and provides tools for generating, managing, and replaying voice lines

## Features

- Assign and configure voices for actors using the Voice Settings dialog
- Use `/talk` chat command to make selected actors speak with their configured or overridden voice
- Optional integration with [Yendors Scene Actors](https://foundryvtt.com/packages/yendors-scene-actors) and [Conversation Hud](https://foundryvtt.com/packages/conversation-hud)
- A **Post to chat & narrate** button beneath journal read-aloud boxes: one click uses the journal's existing Send to Chat action and speaks the passage with the narrator voice
- Read-aloud support for selected journal text and inline tags, with flexible voice selection
- Token HUD button for entering and reading aloud custom text
- Option to suppress posting spoken text to chat
- API for third-party module integration
- Localized language support (English, German)
- Out-of-the-box support for the Elevenlabs TTS provider.
- Extensible architecture for additional TTS providers

## Installation

1. In Foundry's **Add-on Modules → Install Module**, paste this URL into **Manifest URL**:

   ```text
   https://github.com/Mondrethos/acd-talking-actors/releases/latest/download/module.json
   ```

   Use the release manifest above. GitHub `blob` links are HTML pages, and the source
   `module.json` contains placeholders that are filled when a release is packaged.
2. Optionally install a tts connector of your choice ( a connector for Elevenlabs is part of the package).
3. Enable both `acd-talking-actors` and your optional tts connector in your FoundryVTT game settings.
4. When using elevenlabs as the tts connector, configure your ElevenLabs API key in the module settings.
5. After updating, have the GM and all players reload Foundry so everyone uses the new audio transport.


## Journal narration

Configure a narrator actor and assign its voice. Open a journal and click **Post to
chat & narrate** beneath a boxed passage to activate its existing **Send to Chat**
control and narrate it to connected players. The journal creates its own chat
message, preserving its original formatting, header, date, and other metadata.
You do not need to select text.
The existing journal share controls and selected-text context menu remain available.

This button explicitly posts to chat even if automatic spoken-text posting is
disabled. Selected-text actions still respect their existing chat settings. The
button recognizes quote-shaped share controls, common Send to Chat actions, and
DDB Importer's hover controls on narrative boxes, blockquotes, and common imported
read-aloud blocks. A passage must have an existing sharing control; if none is
recognized, the button shows an error and you can still use selected-text narration.
The journal's native sharing action determines what appears in chat. Narration
reads only the chosen passage and omits unrevealed secret/hidden elements. Buttons
are unavailable inside the journal editor. Talking Actors leaves the native chat
message unchanged, including its existing controls.


## Credits

- Fork maintainer: [Mondrethos](https://github.com/Mondrethos)
- Original author: [Acd-Jake](https://github.com/acd-jake); [upstream repository](https://github.com/acd-jake/acd-talking-actors)
- Inspired by "Elevenlabs for Foundry" by Vexthecollector
- Powered by ElevenLabs

Original module listings (upstream):

[![Forge Installs](https://img.shields.io/badge/dynamic/json?label=Forge%20Installs&query=package.installs&suffix=%25&url=https%3A%2F%2Fforge-vtt.com%2Fapi%2Fbazaar%2Fpackage%2Facd-talking-actors&colorB=006400&style=for-the-badge)](https://forge-vtt.com/bazaar#package=acd-talking-actors)

[![Foundry Hub Endorsements](https://img.shields.io/endpoint?logoColor=white&url=https%3A%2F%2Fwww.foundryvtt-hub.com%2Fwp-json%2Fhubapi%2Fv1%2Fpackage%2Facd-talking-actors%2Fshield%2Fendorsements&style=for-the-badge)](https://www.foundryvtt-hub.com/package/acd-talking-actors/)

---

For documentation of the original module, see the [upstream GitHub Wiki](https://github.com/acd-jake/acd-talking-actors/wiki).
