# Audio and journal fixes

Run the regression suite with Node.js 22 or newer:

```sh
npm ci
npm test
npm run test:socket
```

The unit suite covers large, out-of-order, duplicate, malformed, and expired audio
transfers; multiline commands; all four journal selection-menu actions; journal
inline tags; missing narrators; chat visibility; voice-name overrides; API errors;
and audio URL cleanup. Journal DOM tests exercise real selected ranges and all four
menu clicks, including a missing narrator. Speech uses plain text while chat keeps
journal formatting. Narrator lookup accepts actor ID, UUID, or exact name. API tests also cover restricted-key startup without the
unused subscription lookup, invalid credentials, detailed API errors, untouched
successful audio responses, and client/shared key precedence. Foundry globals are mocked.

The socket integration check opens a local server and two clients, relays a
2,500,017-byte recording under a 1 MB message limit, and checks every received byte
and that both clients remain connected. It does not call ElevenLabs.

The previous transport sent the entire recording in one socket event. The new
transport sends 32 KiB base64-encoded pieces, then plays the reassembled recording.
Each utterance is limited to 32 MiB, incomplete transfers expire after 60 seconds
without a packet, and all clients must reload after installing the update.

## Foundry v14 manual verification

These checks still need a running Foundry world and a second browser logged in as
a player. Automated tests do not verify real browser audio or a particular game
system's journal markup.

1. Configure a narrator actor and a different current actor with distinct voices.
   Enable the selection context menu and posting spoken text to chat.
2. Select several paragraphs in a journal, then right-click the selected text.
   Test each of the four controls separately:

   | Control | Expected voice | Chat message |
   | --- | --- | --- |
   | Read Aloud (Narrator) | Configured narrator | Yes |
   | Read Aloud (Narrator) without Chatmessage | Configured narrator | No |
   | Read Aloud (Actor) | Current chat speaker / selected token | Yes |
   | Read Aloud (Actor) without Chatmessage | Current chat speaker / selected token | No |

   The global post-to-chat setting can also suppress either “Yes” entry.
   Current-actor speech falls back to the narrator when no speaking actor resolves.
   The actor shown in a journal stat block is not automatically the current speaker.
3. Confirm both browsers hear the entire long passage without disconnecting.
   Repeat using the chat replay icon.
4. Try multiline `/talk`, `/talk-s`, `/narrate`, and `/narrate-s` commands. Silent
   variants should still speak but should never post, including without a voice.
5. Put multiple `@ReadAloud{Text}`, `@Narrate{Text}`, and
   `@ReadAloud[Actor Name]{Text}` tags on a page. Check each button individually,
   including text containing quotes or backticks. Braces delimit tag content.
6. Clear the narrator setting and confirm the menu does not throw a null-actor
   exception. Restore it and disable post-to-chat to check the global setting.

API and socket references:

- [Socket.IO message limits](https://socket.io/docs/v4/server-options/#maxhttpbuffersize)
- [Foundry v14 AudioHelper](https://foundryvtt.com/api/classes/foundry.audio.AudioHelper.html)


## Journal passage button

1. Open a journal with two separate narrative boxes or blockquotes that have native
   Send to Chat controls. Confirm each has one **Post to chat & narrate** button
   below it, including after a re-render.
2. Send the first passage with the journal's original share control, then with
   **Post to chat & narrate**, without selecting anything. Compare the messages:
   the content, fonts, textures, header, date format, and native controls should
   match. Each click produces exactly one native message. Only the narration
   button speaks, on the GM and player clients. The second box is not included.
3. Confirm native share controls still work separately, and all four selected-text
   context-menu choices retain their behavior.
4. Disable automatic chat posting, then use the new button: its explicit post-and-
   narrate action still posts. Silent selected-text choices still do not post.
5. Confirm narration skips unrevealed secret sections and hidden content, and
   buttons do not appear in the editable journal text. Chat content follows the
   journal's existing sharing behavior.
6. During generation, repeated clicks must not create duplicate messages or API
   calls. After a failed request, the button must re-enable and show the error.
7. Try DDB Importer passages whose sharing control only appears on hover. With
   no text selected, the narration button should still invoke that native control.
8. Try a passage without a native Send to Chat control: expect an explanatory
   error and no custom chat card or speech. Selected-text narration still works.

The DOM tests cover these interactions with Foundry and TTS services mocked. A
live-world check is still needed for adventure-specific journal markup and styling.
