# How this was reverse-engineered

Everything in this repository was derived by talking to a running application, not
from documentation. There is no public documentation for any of it. These are the
findings worth keeping, roughly in the order they were discovered.

If you only read one section, read
[the quota boundary](#2-chat-mode-vs-work-mode-is-a-quota-boundary) — that is the
finding that makes this project possible at all.

---

## 1. The Codex desktop app is an Electron shell around the full ChatGPT UI

The Windows package is `OpenAI.Codex`, an MSIX from the Microsoft Store. Its
executable is named `ChatGPT.exe`, which is the first hint: this is not a
purpose-built agent UI bolted onto a chat window.

Inspecting the install directory (`C:\Program Files\WindowsApps\OpenAI.Codex_*`) makes
it unambiguous:

```
app/
├── ChatGPT.exe                 4.7 MB    ← the Electron host
├── chrome.dll                  327 MB    ← Chromium 154
├── resources/
│   ├── app.asar                482 MB    ← the whole UI
│   ├── owl-electron-app.json             ← {"runtimeName":"owl",
│   │                                        "packagedFrom":"…/electron/out/Codex-win32-x64"}
│   ├── codex.exe               321 MB    ← the actual coding agent, separate binary
```

`owl-electron-app.json` and the 482 MB `app.asar` confirm it is an Electron build of
OpenAI's internal `owl` shell, packaging Chromium 154 and a single-page app at
`app://-/index.html`.

That last detail is the useful part. **The chat surface is a normal web app reachable
over the Chrome DevTools Protocol.** If you start the process with
`--remote-debugging-port`, you get a scriptable DOM in which the user is already
signed in — no API key, no cookie extraction, no automation of a password form.

One trap when you first list targets: several windows exist, and the obvious one is a
decoy.

```
page   app://-/index.html?initialRoute=%2Favatar-overlay   ← 3 buttons, a floating avatar
page   app://-/index.html                                  ← 278 buttons, the real thing
webview  https://chatgpt.com/?source=codex-embedded-checkout   ← not the chat either
```

Match on the **exact** URL `app://-/index.html`, not a prefix.

## 2. Chat mode vs Work mode is a quota boundary

The composer carries a mode switch:

```html
<button aria-label="Switch mode, current mode: ChatGPT">ChatGPT</button>
```

and the composer itself has `Chat` / `Work` toggles. This is not cosmetic.
OpenAI's own help centre states that ChatGPT's file, image and voice limits are
**separate** from Codex's, with their own reset periods
([Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-codex-and-chatgpt-plan-usage-limits)).

So the same window offers two very different things:

| Mode | What runs | What it bills |
|---|---|---|
| **Chat** | plain ChatGPT | your ChatGPT message/image allowance |
| **Work** | the Codex agent, with filesystem access | your Codex allowance |

Generating an image in **Chat** mode is free of Codex usage; doing the same thing
through the `codex` CLI spends it. That distinction is the entire reason this project
exists rather than a two-line wrapper around `codex exec`.

It also means the mode is a **safety** boundary, not just a billing one: a stray
prompt in Work mode can start an agent that writes to your disk. This codebase
therefore refuses to run unless the switch reports `current mode: ChatGPT`:

```js
if (!/current mode: ChatGPT/i.test(mode)) {
  throw new Error('refusing to run: Work mode consumes your Codex allowance');
}
```

## 3. Launching a packaged Electron app *with arguments*

Electron only opens the DevTools port when the flag is on its command line at
startup. Three things make that awkward on Windows.

**You cannot just run the .exe.** Launching `ChatGPT.exe` by path strips its MSIX
package identity, which changes the virtualised `APPDATA`, which means the app looks
for its profile somewhere else — and the ChatGPT login is gone. It has to be started
through its AUMID:

```
OpenAI.Codex_2p2nqsd0c76g0!App          ← <PackageFamilyName>!<AppId>
```

read from `AppxManifest.xml` in the install directory.

**AUMID activation does not take arguments** — except through
`IApplicationActivationManager::ActivateApplication`, which is the only documented way
to hand a command line to a packaged app. Two traps in calling it:

```powershell
# PowerShell will not cast the returned RCW to a [ComImport] interface inline:
$mgr = [IApplicationActivationManager]$comObject   # fails
# -> Cannot convert the "System.__ComObject" value … to type "IApplicationActivationManager"
```

The fix is to make the call inside C# (`launch-app.ps1` does exactly this). And:

```
ActivateApplication -> HRESULT 0x80070005 (E_ACCESSDENIED)
```

means the calling process is at **Low** integrity. Packaged-app COM activation needs
Medium. A sandboxed shell will hit this every time.

**An existing instance blocks you.** Electron's single-instance lock makes a second
process exit before the port opens, so any running instance must be closed first.

The result is `launch-app.ps1`: close, activate via AUMID with the flag, poll for the
endpoint. On macOS the same Electron app exists and the problem largely disappears —
you can invoke the binary inside the bundle directly, and there is no package identity
to preserve.

## 4. Chromium's accessibility tree is not reliably available

Before reaching for CDP, driving the native UI Automation tree looks attractive: no
restart, no flags. It does not hold up.

A UIA walk of that window returned **3 elements** on the first call and **533** on the
second. Chromium builds its accessibility tree only when it detects a client that
wants it, and that activation is not reliably triggered by an arbitrary client.

From an external PowerShell UIA client it was worse — two descendants, forever:

```
attempt 1 : descendants = 2
…
attempt 12 : descendants = 2
```

even after forcing the renderer with `WM_GETOBJECT`/`OBJID_CLIENT`, and after adding
retries. The same script driving the same window through CDP has no such problem.

**Conclusion: UIA is a diagnostic aid, not an interface.** The window's element tree
is still useful for reconnaissance — it is how the mode switch, composer and
`Create image` affordance were first located — but the automation channel is CDP.

## 5. The sidebar has two id namespaces and no join between them

This is the subtlest thing in the codebase, and the first implementation got it wrong.

Making `thread: "reuse"` work means getting *back* to a specific conversation. The app
never changes its URL (`app://-/index.html` always, `history.state` always null), so
there is no route to navigate. What is left is the DOM, which offers:

| Attribute | Namespace | Example |
|---|---|---|
| `data-above-composer-conversation-id` | the **open** conversation | `local-chatgpt:2f9be8f6-…` |
| `data-map-composer-conversation` | the open conversation | `local-chatgpt:2f9be8f6-…` |
| `data-sidebar-chatgpt-conversation-key` | a sidebar row | `chatgpt:conversation:6abb3fb0-…` |
| `data-app-action-sidebar-thread-id` | a different sidebar row | `local:01a0e61c-…` |

Read those carefully, because three separate things are wrong with the naive approach:

1. **The prefixes vary.** Conversations created locally carry `local-`; ones that came
   from the server do not. `data-above-composer-conversation-id` can read
   `chatgpt:local-chatgpt:<uuid>` — double-prefixed.
2. **The ids do not match.** For the *same* conversation, the composer reported
   `local-chatgpt:2f9be8f6-…` while the sidebar row reported
   `chatgpt:conversation:6abb3fb0-…`. These are different identifiers from different
   services. Nothing links them.
3. **There are two unrelated row families.** Only some rows are ChatGPT conversations
   (19 of them at the time of measurement); others are app-local threads (66). A
   selector aimed at the wrong family returns nothing, silently.

The only field that joins them is the **title**, which `document.title` mirrors while
that conversation is open. Rows also render lazily, so a freshly created conversation
is simply absent from the DOM until the sidebar is scrolled to it — a lookup that
searches once at the current scroll position returns nothing and looks like a bug that
isn't there.

The resulting design is: **navigate by title, verify by id.** Click the row whose
title matches, then re-read the composer's conversation id and confirm it is the one
that was asked for. If it is not, abort rather than post — a title is not proof, and
posting a prompt into an unverified conversation means posting into someone's private
chat.

## 6. Smaller traps

**Temporary chats cannot generate images.** Pressing `Temporary chat` and sending a
perfectly ordinary image prompt produces a reply explaining the limitation. A new
*temporary* chat and a new *regular* chat look similar in the DOM, so the flow must
start a regular one and can only detect the temporary state from a text heuristic.

**The rendered image is a `blob:` URL.** By the time you can see
`img[alt^="Generated image"]`, `src` is `blob:app://-/…`, and fetching that from page
context fails (`TypeError: Failed to fetch`). The reliable route is the DevTools
Network domain: enable `Network`, keep `Network.getResponseBody` results for large
`image/*` responses, and write those bytes. The payload also arrives in two hops — a
preview, then the final render — so waiting for `naturalWidth` to settle matters.

**`process.exit()` during stdio teardown crashes Node on Windows.**

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

Exiting while a WebSocket or stdin handle is still closing aborts the process
(`0xC0000409`). An MCP server that does this looks like it crashes on every shutdown.
Setting `process.exitCode` and letting the event loop drain avoids it entirely.

**Chrome will not let you have a debug port on your normal profile.** Since Chrome 136,
`--remote-debugging-port` is ignored unless it is accompanied by a `--user-data-dir`
pointing at a non-default directory
([Chrome for Developers](https://developer.chrome.com/blog/remote-debugging-port)).
This is why automating `chatgpt.com` in a browser needs a dedicated profile and a
one-time login, and why the desktop app — already signed in — is the easier target.

---

## Re-deriving this after a UI update

The `recon/` directory holds the read-only tools used to work all of the above out.
They are kept because the selectors here are DOM-derived and will eventually rot.
Start with `targets.mjs`, then `attrs.mjs` — the attribute census is what
revealed the two id namespaces.
