# codeximg

Give any agent **ChatGPT's image generator** as an MCP tool, by driving the
already-signed-in Codex desktop app over the Chrome DevTools Protocol.

- **No API key.**
- **No Codex quota.** The app has a `Chat` / `Work` mode switch. `Work` runs the
  Codex agent against your Codex allowance; `Chat` is plain ChatGPT. This project
  **refuses to run** unless the app reports `current mode: ChatGPT`.
- Real PNGs land on disk, and the image comes back in the tool result.

## Why not the Images API?

Because you already pay for ChatGPT, and API image credits are metered separately.

## Why not automate chatgpt.com in Chrome?

That works too, but it needs a dedicated Chrome profile plus a one-time login, and
since Chrome 136 `--remote-debugging-port` is ignored on the default profile
([background](https://developer.chrome.com/blog/remote-debugging-port)). The desktop
app is already logged in, so there is nothing to set up.

## Quick start

```powershell
# 1. start the app with a debug port (closes any running instance first)
powershell -File launch-app.ps1

# 2. check the bridge is usable
node generate.mjs --status

# 3. generate
node generate.mjs "a single solid red circle on a plain white background" -o ./out -n circle
```

### Register the MCP server

Claude Code:

```bash
claude mcp add -s user codeximg -- node C:/Users/you/Desktop/git/codeximg/mcp-server.mjs
```

Claude Desktop / Cursor — add to the MCP config:

```json
{
  "mcpServers": {
    "codeximg": {
      "command": "node",
      "args": ["C:/Users/you/Desktop/git/codeximg/mcp-server.mjs"]
    }
  }
}
```

Then ask the agent for an image. It calls `generate_image` and gets the PNG back.

## MCP tools

| Tool | Arguments | Notes |
|---|---|---|
| `generate_image` | `prompt` (required), `filename`, `output_dir` | 15–60 s. Calls are serialized, because they share one browser window. Returns the path, the dimensions, and the image itself. |
| `image_status` | — | Read-only. Reports whether the port is open, whether the app is in Chat mode, and whether the composer is present. |

## How it works

```
mcp-server.mjs / generate.mjs
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

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OUT_DIR` | `./out` | Default output directory |
| `CDP_PORT` | `9222` | DevTools port |
| `TIMEOUT` | `180000` | ms to wait for an image |
| `CODEXIMG_AUTOLAUNCH` | `1` | Set to `0` to never auto-start the app |
| `CODEXIMG_RETURN_IMAGE` | `1` | Set to `0` to return only the file path, not the image bytes |

### Auto-launch behaviour

The MCP server starts the app for you, but only when it is **not already running**.
`launch-app.ps1` force-closes any instance, so firing it at a running app would throw
away your session. If the app is running without a debug port, `generate_image`
fails with instructions instead of killing it.

## Layout

| Path | Purpose |
|---|---|
| `mcp-server.mjs` | MCP stdio server |
| `chatgpt.mjs` | Core: endpoint handling, mode guard, generation, locking |
| `generate.mjs` | CLI wrapper |
| `cdp.mjs` | Dependency-free CDP client: `attach`, `connect`, `evaluate`, `waitFor` |
| `launch-app.ps1` | Starts the app via AUMID with `--remote-debugging-port` |
| `smoke-test.mjs` | Speaks MCP to the server; `--generate` also does a real run |
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
| `Runtime.evaluate` on the wrong target | There are several. The main window is the one whose URL is exactly `app://-/index.html`, not `?initialRoute=/avatar-overlay`. |
| libuv assertion (`async.c`) on shutdown | Calling `process.exit()` while stdio handles are still closing. Let the event loop drain instead. |

## Security

While the debug port is open, any local process can fully control that app. It binds
to `127.0.0.1` only, and the app must be relaunched with a special flag to open it at
all. Close the app when you are done.

Automating the app may conflict with OpenAI's terms depending on your use. This is
built for your own account, at human-ish rates. For production or commercial volume,
use the official Images API.
