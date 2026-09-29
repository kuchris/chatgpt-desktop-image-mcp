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

**Claude Code.** The `claude` CLI is often not on `PATH` — when Claude Code ships
inside the Claude desktop app it lives under a versioned path that changes on update:

```powershell
& "$env:APPDATA\Claude\claude-code\<version>\claude.exe" mcp add -s user codeximg -- node C:/path/to/codeximg/mcp-server.mjs
```

That writes `mcpServers` into `~/.claude.json`.

**Claude Desktop.** It is an MSIX package, so its config is *not* at
`%APPDATA%\Claude\` — it is virtualised:

```
%LOCALAPPDATA%\Packages\Claude_<publisherid>\LocalCache\Roaming\Claude\claude_desktop_config.json
```

Add the server there and restart the app:

```json
{
  "mcpServers": {
    "codeximg": {
      "command": "node",
      "args": ["C:/path/to/codeximg/mcp-server.mjs"]
    }
  }
}
```

Use absolute paths, with forward slashes. Then ask the agent for an image: it calls
`generate_image` and gets the PNG back.

Before wiring anything up, it is worth running `node smoke-test.mjs` once — it proves
the whole chain without touching your client config.

## MCP tools

| Tool | Arguments | Notes |
|---|---|---|
| `generate_image` | `prompt` (required), `filename`, `output_dir`, `thread` | 15–60 s. Calls are serialized, because they share one browser window. Returns the path, the dimensions, and the image itself. |
| `image_status` | — | Read-only. Reports whether the port is open, whether the app is in Chat mode, whether the composer is present, and which conversation is open. |

### `thread`: new vs reuse

| | `new` (default) | `reuse` |
|---|---|---|
| Conversation | a fresh one on every call | the one this tool last used |
| Sees earlier generations | no | yes — "make it purple" works |
| Sidebar rows created | one per call | one, total |

`reuse` is what lets an agent iterate on its own output. It is *verified*, not guessed:
the id of the open conversation is read from the composer before and after navigating,
and the call refuses to post if it did not land where it asked to.

```bash
node generate.mjs --reuse "make it purple instead"   # iterate
node generate.mjs "a red bicycle"                    # fresh conversation (default)
node generate.mjs --focus                            # just open the saved one
```

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
| A saved conversation cannot be found again | The sidebar holds **two unrelated row families** — `[data-sidebar-chatgpt-conversation-key]` (a ChatGPT conversation) and `[data-app-action-sidebar-thread-row]` (an app-local thread) — and the composer id lives in a *different namespace* than either (`local-chatgpt:<uuid>` vs `chatgpt:conversation:<uuid>`). Only the **title** joins them, and rows render lazily, so you have to scroll the sidebar while looking. |
| Posting into the wrong conversation | Never trust a title match on its own. `reuse` re-reads the composer's conversation id after navigating, and refuses if it does not match what was requested. |

## Security

While the debug port is open, any local process can fully control that app. It binds
to `127.0.0.1` only, and the app must be relaunched with a special flag to open it at
all. Close the app when you are done.

Automating the app may conflict with OpenAI's terms depending on your use. This is
built for your own account, at human-ish rates. For production or commercial volume,
use the official Images API.
