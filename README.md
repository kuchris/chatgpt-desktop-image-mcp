# codeximg

Generate images with **ChatGPT's image generator, from a script or an agent**, by
driving the already-logged-in Codex desktop app over the Chrome DevTools Protocol.

- **No API key.**
- **No Codex quota.** The app has a `Chat` / `Work` mode switch. `Work` runs the
  Codex agent against your Codex allowance; `Chat` is plain ChatGPT. `generate.mjs`
  **refuses to run** unless the app reports `current mode: ChatGPT`.
- Real PNGs land on disk.

## Why not the Images API?

Because you already pay for ChatGPT, and API image credits are metered separately.

## Why not automate chatgpt.com in Chrome?

That works too, but it needs a dedicated Chrome profile plus a one-time login, and
since Chrome 136 `--remote-debugging-port` is ignored on the default profile
([background](https://developer.chrome.com/blog/remote-debugging-port)). The desktop
app is already logged in, so there is nothing to set up.

## How it works

```
generate.mjs
   │  ws://127.0.0.1:9222
   ▼
Codex desktop app (Electron / Chromium 154)
   └── target: app://-/index.html        ← the ChatGPT UI
        ├── 1. guard: button[aria-label^="Switch mode"] must say "current mode: ChatGPT"
        ├── 2. click [aria-label="New chat"]      ← Temporary chats cannot generate images
        ├── 3. focus div.ProseMirror[role="textbox"], Input.insertText(prompt)
        ├── 4. click button[aria-label="Send"]    ← Enter as fallback
        ├── 5. wait for img[alt^="Generated image"]
        └── 6. capture bytes via Network.responseReceived + Network.getResponseBody
   ▼
out/chatgpt-<timestamp>.png
```

Step 6 exists because the rendered image `src` is a `blob:` URL, which cannot be
fetched from page context. Intercepting the network response is the reliable path.

## Requirements

| | |
|---|---|
| OS | Windows |
| App | OpenAI **Codex** desktop app (MSIX package `OpenAI.Codex`) |
| Node | 22+ (uses the global `WebSocket`) |
| Shell | Windows PowerShell 5.1 (built into Windows) — only to launch the app |

## Usage

### 1. Start the app with CDP enabled

```powershell
powershell -File launch-app.ps1
# -> ActivateApplication -> HRESULT 0x00000000, pid 33904
# -> CDP is up on port 9222 (Chrome/154.0.8037.57)
```

This closes any running instance first (Electron's single-instance lock would
otherwise make the new process exit before the port binds).

### 2. Generate

```bash
node generate.mjs "a single solid red circle centered on a plain white background"
# -> RESULT_IMAGE=C:\...\out\chatgpt-2026-09-29T04-20-11.png
```

Environment knobs: `OUT_DIR` (default `./out`), `TIMEOUT` (default 180000 ms),
`CDP_PORT` (default 9222).

## Layout

| Path | Purpose |
|---|---|
| `cdp.mjs` | Dependency-free CDP client: `attach`, `connect`, `evaluate`, `waitFor` |
| `generate.mjs` | The generation flow, including the Codex-quota guard |
| `launch-app.ps1` | Starts the app via AUMID with `--remote-debugging-port` |
| `recon/*.mjs` | Read-only reconnaissance tools used to reverse the UI |

`recon/` is kept because it is how you re-derive the selectors after a ChatGPT UI
update: `targets.mjs` fingerprints every CDP target, `inspect.mjs` dumps the composer
and button surfaces, `findnew.mjs` locates the new-chat control.

## Gotchas discovered the hard way

| Symptom | Cause / fix |
|---|---|
| `IApplicationActivationManager` returns `E_ACCESSDENIED` | Process is at Low integrity. Packaged-app COM activation needs Medium. |
| `Cannot convert __ComObject to IApplicationActivationManager` | PowerShell will not cast the returned RCW to a `[ComImport]` interface inline. Make the call inside a C# helper (`launch-app.ps1` does). |
| App starts but is not logged in | You launched `ChatGPT.exe` by path, losing package identity and the virtualised `APPDATA`. Always go through the AUMID. |
| CDP port never opens | An instance was already running. Close it first. |
| Message sends, but no image ever appears | You were in a **Temporary chat** — those do not support image generation. |
| In-page `fetch(img.src)` fails | `src` is a `blob:` URL. Use the CDP Network domain instead. |
| `Runtime.evaluate` on the wrong target | There are several: the main window is the one whose URL is exactly `app://-/index.html`, not `?initialRoute=/avatar-overlay`. |

## Security

While the debug port is open, any local process can fully control that app. It binds
to `127.0.0.1` only, and the app must be relaunched with a special flag to open it at
all. Close the app when you are done.

Automating the app may conflict with OpenAI's terms depending on your use. This is
built for your own account, at human-ish rates. For production or commercial volume,
use the official Images API.
