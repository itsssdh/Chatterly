# Chatterly for the browser

The same Chatterly, running as a web page. It joins the Twitch channels you choose, reads chat, and — only where you
have switched sending on — posts varied, context-aware messages built by a local rules engine (no AI service, no paid
API). Every message is paced, limited and logged, and by default waits for your approval.

Everything stays in **your browser** (IndexedDB). There is no server of ours: the page talks straight to Twitch
(chat over WebSocket, `id.twitch.tv`, `api.twitch.tv`) and to 7TV (emote lists and images).

The desktop app is untouched in `../chatterly`; this folder is a separate copy adapted for the browser.

## Run it

The quickest way: **double-click `Chatterly.command`** (or run `npm run launch`). It installs and builds on first use,
serves the app at **http://127.0.0.1:4173** and opens it in Dia (or your default browser). Leave that window open while you
use Chatterly; closing it only stops the server, never your data.

Or by hand:

```sh
npm install
npm run build
npm start          # serves the built app at http://127.0.0.1:4173
```

Works in Chromium browsers: Dia, Chrome, Edge, Brave, Arc. `npm run dev` gives a live-reload dev server on port 5173.
The page must be served over http(s); opening `dist/index.html` from disk won't work (browsers don't run module workers or
IndexedDB from `file://`). Any static host works too — upload `dist/`.

**Always open it at the same address.** A browser keeps data per address, so `127.0.0.1:4173`, `localhost:4173` and `:5173`
each have their own settings and channels. The server refuses to start on another port for this reason. To move data
between addresses, use *Back up* / *Restore*.

**Install it as an app (optional).** In Chrome/Edge use the install icon in the address bar (*Install Chatterly*); it then
gets its own window and Dock icon. After the first visit the app also opens **without the server running** (the browser
keeps a copy of the files; a new build replaces it the next time the server is up).

## Publish on GitHub Pages (free)

Pages only serves the files; Chatterly still runs in the browser tab that has it open, so it posts only while a tab is open.

1. On github.com create a new **public** repository (Pages is free for public repos), e.g. `chatterly`. Don't add a README there.
2. In this folder:
   ```sh
   git init -b main
   git add .
   git commit -m "Chatterly for the browser"
   git remote add origin https://github.com/<you>/chatterly.git
   git push -u origin main
   ```
3. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions.** The included workflow
   (`.github/workflows/pages.yml`) type-checks, tests, builds and publishes; the address appears in the Actions run
   (`https://<you>.github.io/chatterly/`).
4. Open that address and use it like the local version (install it as an app if you like). Its data is separate from
   `127.0.0.1:4173`: use *Back up* there and *Restore* here to bring your settings over.

**Keep the address private to Chatterly.** A browser stores data per *origin* (`<you>.github.io`), not per repository.
Any other page you publish under the same `<you>.github.io` could read Chatterly's storage, including the stored login.
Use an account or organisation that hosts only Chatterly, or a custom domain just for it. The repository is public, but
it contains no secrets: your Twitch Client ID is typed into the page and stays in your browser.

## Logging in to Twitch

Twitch needs a **Client ID** for any app that talks to it. It is free, public and not a secret:

1. Register an application at <https://dev.twitch.tv/console/apps>. Redirect URL `http://localhost`, category *Chat Bot*,
   client type *Public*.
2. Paste the Client ID in **Settings → Account** and press *Log in with Twitch*.
3. A Twitch tab opens at `twitch.tv/activate` with the code filled in. Approve it there.

No password or secret is ever entered into Chatterly. The login uses Twitch's device-code flow and is renewed
automatically; it lasts as long as you use it at least once every 30 days. *Log out* revokes it.

## What carries over from the desktop app

All of it that a web page can do: per-channel switches (Enabled / Allow sending / Only when live), approval or auto
mode (saved), personalities and emote density, 7TV emotes with animated previews, laugh-emote list, greetings and custom
mentions, per-channel blocked words, hard safety limits plus every pacing value editable, live chat view, activity
feed, sent history, theme, and the safety rules (nothing is sent to a channel unless you enabled it; automation always
starts stopped; one message per reaction; no overlay emotes).

## What is different in a browser

| Desktop app | Browser version |
| --- | --- |
| Menu bar icon with play/pause and last sent messages | **Mini** button: the same panel, and *Pop out* (Chrome/Edge) puts it in a small always-on-top window. The tab title shows ▶ / ⏸ and waiting approvals (setting *Tab status*). |
| Login stored in the macOS Keychain | Encrypted with a non-extractable WebCrypto key kept in IndexedDB. This protects the stored copy (exports, disk, other sites); it cannot protect against code running on this same page, so only host a build you trust. |
| Open at login | Not possible for a web page (removed). |
| Log / data folders | *Download log*, *Back up* / *Restore* (JSON, never contains your login; a restore always leaves sending off for every channel), *Erase everything*. |
| ⌘ shortcuts | Alt+1/2/3 pages, Alt+\ sidebar, Alt+Enter start, Alt+P pause/resume, Alt+. stop. |
| Pauses when the Mac sleeps | Pauses when the engine notices it was frozen (sleep, long suspend). |
| One instance per data folder | One tab: a second tab shows "already open" until the first closes. |
| Quitting stops everything | Closing the tab stops everything, so the browser asks first while Chatterly is running. |

The engine runs in a Web Worker, so pacing stays accurate in a background tab. Browsers can still freeze or discard
tabs (Memory Saver, battery saver, sleep). For a long session keep the tab open and exempt it from tab discarding.

## Safety

Unchanged: no fake viewers, no account rotation, no evading Twitch's limits (20 messages / 30 s, 1 / s per channel,
slow mode, bans are always respected), nothing posted to a channel you haven't explicitly allowed. See the desktop README
for the full list and for advice on how many channels are reasonable.

## Tested, and not

- `npm test` (178 tests: engine, pacing, IRC against a mock Twitch server, storage, login, emotes) and `npm run typecheck`, `npm run lint`.
- Driven in Chromium: startup, worker engine, real 7TV emote loading and animated images, anonymous live chat reading from a real channel, channel lookup, settings, backup/restore, theme, shortcuts, the single-tab lock, encrypted storage round-trip, and the Twitch device-code request (Twitch answers the browser's request; a made-up Client ID is rejected with a clear message).
- **Also checked:** a fresh profile, installability (valid manifest, active service worker), opening with the server stopped (data intact, every page loads), data kept after reloads, the pop-out panel's content in a separate window, and the close-confirmation while running.
- **Not testable without a Twitch account here:** completing a login, sending a message, the pre-filled code on the activate page (relies on Twitch's `activate?public=true&device-code=` link), the native always-on-top frame of *Pop out* (only its content was checked), Dia itself (tested in the same Chromium engine, not in Dia), Firefox and Safari. The pre-opened login tab can be blocked by a strict pop-up blocker; the Account page then shows the code and an *Open Twitch* button.
