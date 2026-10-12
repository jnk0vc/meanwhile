# Meanwhile privacy policy

Last updated: 2026-10-12

Meanwhile is a Claude Code mod that pairs you with another waiting developer for an anonymous one-on-one chat while Claude is working. This page describes what the mod and its matching server handle. It is published by the author of Meanwhile ([jnk0vc](https://github.com/jnk0vc)). Questions and requests go to [GitHub issues](https://github.com/jnk0vc/meanwhile/issues).

The same handling is described in Japanese in the README, under [安全とプライバシー](README.md#安全とプライバシー).

## What stays on your machine

- Meanwhile is off until you run `/meanwhile` and accept the consent screen. The on/off state and your consent are kept in Claude Code's plugin store on your machine.
- The mod sends only text you address to the other person: what you type in the band's input field (desktop app), or a prompt you type yourself that starts with `>> `. Prompts, code, tool input and output, file paths and repository names are never sent.
- Before sending, text that looks like an API key, token, private key or email address is held back.
- Conversations are not saved. They disappear when you leave, on your machine and everywhere else.
- Messages from the other person never enter Claude's context. Translation is a one-off request to Claude Haiku made by Claude Code on your side (`$.model.complete`), with no tools, no history and no `CLAUDE.md`, billed to your own Claude usage.

## What the other person receives

- The messages you send (up to 200 characters each), signed with a key made fresh for each session.
- Your public IP address, because the two of you connect directly (WebRTC). Addresses inside your local network are removed from the connection information.
- The language you use, so that each side knows whether to translate.

Everyone is shown as "Someone". No name, account or install ID is shared.

## What the STUN servers receive

To find your public address, the mod's helper process asks STUN servers (`stun.l.google.com:19302` and `stun.cloudflare.com:3478`). They see your IP address. No message content goes to them.

## What the matching server receives

The matching server (`wss://meanwhile.jank0vic.com`, run on Cloudflare Workers and Durable Objects) pairs two people and passes connection information between them. Conversation text does not go through it; it receives messages only when you attach them to a report. IP addresses are not stored as they are: they are turned into salted hashes first.

| What it receives | What it is used for | How long it is kept |
| --- | --- | --- |
| Connection information (SDP and ICE candidates) | Passed to the person you are matched with | Not kept |
| A room record (both public keys and IP hashes) | Checking that a report comes from someone in that room | One hour from the match |
| Signed messages attached to a report (up to 20) | Checking by signature that the reported person really sent them | Not kept: discarded once verified |
| Report records (the reported IP hash and the reporter's IP hash) | Telling whether three different people reported the same person | 24 hours from the first report |
| IP hashes and public keys that are temporarily banned | Leaving them out of matching | 24 hours |

Cloudflare Workers Logs is turned on, so every request leaves a record in the operator's Cloudflare account, with details such as the URL and headers. When a match is made, only the fact that it was made is recorded (no public keys or IP hashes). These records can include IP addresses and are deleted after 3 or 7 days, depending on the Cloudflare plan. Messages sent with a report (the request body) are not in these records.

What the server receives is used only for the purposes in the table above. Workers Logs records are used only to investigate failures and to count matches.

If you set the mod's `server` option to a server you run yourself, that server's operator handles this information instead.

## Changes

Changes to this policy are made in this file, and its history is public in the repository.
