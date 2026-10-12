# Meanwhile

A Claude Code mod that pairs you with another waiting developer for an anonymous one-on-one chat while Claude is working. The other person's messages appear in a band right above the prompt box. Messages in another language are translated by Claude Haiku on the receiver's side. When you are ready to go back, you send one last word and leave.

The full documentation (in Japanese) is the [repository README](https://github.com/jnk0vc/meanwhile#readme).

```
/plugin marketplace add jnk0vc/meanwhile
/plugin install meanwhile@meanwhile
```

Meanwhile is off until you run `/meanwhile` and accept the consent screen. `/meanwhile off` turns it off again.

## Privacy

See the [privacy policy](https://github.com/jnk0vc/meanwhile/blob/main/PRIVACY.md) for what the other person, the STUN servers and the matching server receive, and how long the server keeps it.

## What it sends, and where

The mod sends only text you address to the other person: what you type in the band's input field (desktop app), or a prompt you type yourself that starts with `>> ` (or the full-width `＞＞`). Prompts, code, tool input and output, file paths and repository names are never sent. Text that looks like an API key, token, private key or email address is held back before sending.

- **The mod's own network request.** The mod makes one kind of request, `$.http.fetch("http://localhost/", { socketPath })`. It goes over a Unix socket to the helper process below, on the same machine, with a token made for each launch. It carries the commands join, leave, send, final word, block, report and quit, and the text you send.
- **The helper process (sidecar)** connects to:
  - the matching server set in the `server` option (default `wss://meanwhile.jank0vic.com`) over WebSocket, to be paired and to pass connection information (SDP and ICE candidates), and `https://<server>/report` when you report someone;
  - the STUN servers `stun.l.google.com:19302` and `stun.cloudflare.com:3478`, to find your public address;
  - the person you are matched with, directly over a WebRTC data channel. Conversation text goes only here.
- **Translation** is a one-off `$.model.complete` request to `claude-haiku-5-5`, made by Claude Code with your own Claude usage, with no tools, no history and no `CLAUDE.md`.

### Command-like text in received messages

`hooks/safety.ts` contains patterns such as `| sh`, `curl`, `npx` and `iex`. They are used only to spot text in a message from the other person that looks like a shell command (or a long Base64 blob), so that the band shows "Looks like a command. Don't run it" under that message. The mod never runs any of them. Links in received messages are also shown broken up (`https[:]//example[.]com`) so that the terminal does not make them clickable.

### What it reads

- **Environment variables:** `LANGUAGE`, `LC_ALL`, `LC_MESSAGES` and `LANG` to choose your language; `TMPDIR` to place the control socket; `PATH` and `HOME` to find Node.js. None of these are sent anywhere.
- **Files and folders:** only to find Node.js. `$.fs.exists` checks each Node.js path listed under [Programs it runs](#programs-it-runs), and `$.fs.list` reads the folder names in `~/.nvm/versions/node` (the Node.js versions installed with nvm). No file contents are read, and none of this is sent anywhere.
- **The prompt box:** `$.prompt.read` is used only by the band's Reply button, to check whether the prompt already starts with `>> ` before adding it. The prompt's text is not sent.
- **Submitted prompts:** see `prompt.submit` below.

## Programs it runs

The mod runs these programs directly, by their argument vector, never through a shell:

| Command | Why |
| --- | --- |
| `/usr/bin/uname -s` | Tell whether this is macOS |
| `/usr/bin/defaults read -g AppleLanguages`, then `/usr/bin/defaults read -g AppleLocale` | On macOS only, read the system language when the `language` option is `auto` |
| `<node> --version` | Check that a Node.js it found is version 22 or later |
| `<node> <plugin folder>/sidecar/meanwhile-sidecar.mjs` | Start the helper process that handles WebRTC and the WebSocket to the matching server |

`<node>` is the first Node.js 22+ found, checked in this order (each path is checked to exist before it is run): each directory in `PATH`; `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`; then under `HOME`, the usual places of Volta, asdf, mise, nodenv, fnm and nvm.

The mod gives the helper process three environment variables: `MEANWHILE_SOCKET` (the path of the control socket), `MEANWHILE_SERVER` (the `server` option) and `MEANWHILE_TOKEN`. `MEANWHILE_TOKEN` is not one of your credentials and is not read from your environment or files. It is 32 random bytes that the mod makes with `crypto.getRandomValues` each time it starts the helper. The helper only compares it with the `x-meanwhile-token` header of requests on the control socket, so that no other process on the machine can drive the helper. It is never sent to the matching server, the STUN servers or the other person.

The helper process is the bundled build of the source in [`sidecar/`](https://github.com/jnk0vc/meanwhile/tree/main/sidecar) with its dependency [werift](https://github.com/shinyoshiaki/werift-webrtc). It is shipped as plain-text, minified JavaScript files under 256 KiB each (`sidecar/meanwhile-sidecar.mjs` and `sidecar/chunks/`), built by `npm run build` in the repository; the licenses of the bundled packages are in `sidecar/meanwhile-sidecar.mjs.LEGAL.txt`. It downloads and runs nothing else, and it ends when the mod is reloaded or Claude Code exits.

## Hooks, and what each one does

| Hook | What it does |
| --- | --- |
| `session.start` | Registers `/meanwhile` and picks your language. Passes the event on unchanged. |
| `prompt.submit` | For a prompt you typed yourself that starts with `>> ` or `＞＞`, sends the rest to the other person and drops the prompt, so Claude never sees it. Every other prompt passes on unchanged. |
| `turn.start`, `turn.complete` | Note when Claude starts and finishes working, to start looking for someone and to show that Claude is done. Both pass on unchanged. |
| `classic.Stop` | Reads only how many background tasks are still running, so a turn that waits for them still counts as work. Passes on unchanged. |
| `classic.PermissionRequest` | Decides nothing. It shows a line in the band saying Claude needs you, then always passes the request on unchanged with `next(e)`, so the permission decision stays with you. |
| `tool.call` (every tool) | Checks only whether the tool is `AskUserQuestion`, to show the same line. It always runs the tool with `next(e)` and returns its result unchanged. |
| `tool.call` on `mcp__meanwhile__preview` | Answers the mod's own development preview tool, which draws the band in sample states. The tool is registered only when a `dev.json` file is in the plugin folder, and the published plugin does not ship one. It stands in for no other tool. |
| `command.run` on `meanwhile` | Answers the mod's own `/meanwhile` command (`on`, `off`). |
| `ui.render` on `AbovePrompt` | Draws the band above the prompt box. When Meanwhile has nothing to show, the engine draws its own. |
| `session.end` | Tells the helper process to quit. |

## License

MIT
