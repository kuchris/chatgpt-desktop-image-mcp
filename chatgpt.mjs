// Core: reach the ChatGPT UI inside the Codex desktop app over CDP,
// generate one image, and return the bytes.
//
// Shared by the CLI (generate.mjs) and the MCP server (mcp-server.mjs).
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getTargets, connect, evaluate, sleep, waitFor } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MAIN_URL = 'app://-/index.html';
export const DEFAULT_PORT = Number(process.env.CDP_PORT || 9222);
export const DEFAULT_OUT_DIR = process.env.OUT_DIR || path.join(HERE, 'out');

const AUTOLAUNCH = process.env.CODEXIMG_AUTOLAUNCH !== '0';
const LAUNCHER = path.join(HERE, 'launch-app.ps1');
const LOCK_FILE = path.join(HERE, '.generate.lock');
const LOCK_STALE_MS = 10 * 60 * 1000;

const silent = () => {};

// ------------------------------------------------------------------ endpoint

export async function cdpVersion(port = DEFAULT_PORT, timeoutMs = 2500) {
  try {
    const ctrl = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function chatGptProcessRunning() {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/NH'], { windowsHide: true });
    } catch {
      return resolve(null); // unknown
    }
    let out = '';
    p.stdout?.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(/ChatGPT\.exe/i.test(out)));
  });
}

function runLauncher(port) {
  return new Promise((resolve) => {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const p = spawn(
      ps,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER, '-Port', String(port)],
      { windowsHide: true },
    );
    let err = '';
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ ok: false, err: String(e.message) }));
    p.on('close', (code) => resolve({ ok: code === 0, err }));
  });
}

/**
 * Make sure a CDP endpoint exists, launching the app if that is safe.
 *
 * Deliberately conservative: we only auto-launch when the app is NOT already
 * running. launch-app.ps1 force-closes any instance, so firing it while the
 * user has the app open would throw away their session.
 */
export async function ensureEndpoint({ port = DEFAULT_PORT, autolaunch = AUTOLAUNCH, log = silent } = {}) {
  if (await cdpVersion(port)) return { launched: false };

  const running = await chatGptProcessRunning();

  if (running) {
    throw new Error(
      `The ChatGPT app is running but without a debug port on ${port}.\n` +
        `Close it and run:  powershell -File "${LAUNCHER}"\n` +
        `(refusing to auto-restart it, because that would kill your open session)`,
    );
  }

  if (!autolaunch) {
    throw new Error(
      `No CDP endpoint on port ${port}, and auto-launch is disabled.\n` +
        `Run:  powershell -File "${LAUNCHER}"`,
    );
  }

  if (running === null) {
    throw new Error(`No CDP endpoint on port ${port} and the process check failed. Run: powershell -File "${LAUNCHER}"`);
  }

  log('app is not running — launching it with a debug port…');
  const { ok, err } = await runLauncher(port);
  if (!ok) throw new Error(`launcher failed: ${err.trim() || 'see launch-app.ps1 output'}`);

  await waitFor(() => cdpVersion(port), { timeout: 30_000, interval: 700, label: `CDP on ${port}` });
  log('CDP is up');
  return { launched: true };
}

export async function attachMain(port = DEFAULT_PORT) {
  const targets = (await getTargets(port)).filter((t) => t.type === 'page');
  const target = targets.find((t) => t.url === MAIN_URL);
  if (!target) {
    throw new Error(
      `main ChatGPT window not found on port ${port}. saw:\n` +
        targets.map((t) => `  ${t.url}`).join('\n'),
    );
  }
  return connect(target.webSocketDebuggerUrl);
}

/** Read-only status, safe to call any time. */
export async function probeStatus({ port = DEFAULT_PORT } = {}) {
  const version = await cdpVersion(port);
  if (!version) {
    const running = await chatGptProcessRunning();
    return {
      cdp: false,
      port,
      appRunning: running,
      hint: running
        ? 'App is running without a debug port — close it and run launch-app.ps1'
        : 'App is not running — generate_image will launch it',
    };
  }

  const cdp = await attachMain(port);
  try {
    const info = await evaluate(cdp, () => {
      const modeBtn = document.querySelector('button[aria-label^="Switch mode"]');
      const composer = document.querySelector('[contenteditable="true"][role="textbox"]');
      const modelBtn = document.querySelector('button[aria-label="Select ChatGPT model"]');
      return {
        mode: modeBtn?.getAttribute('aria-label') || null,
        composerReady: !!composer,
        model: (modelBtn?.innerText || '').trim() || null,
        inTemporaryChat: /temporary/i.test(document.body.innerText.slice(0, 4000)),
      };
    });
    return { cdp: true, port, browser: version.Browser, ...info, usable: /current mode: ChatGPT/i.test(info.mode || '') };
  } finally {
    cdp.close();
  }
}

// ------------------------------------------------------------------ locking

let tail = Promise.resolve();

/** Serialize work in-process (the UI is a single shared window). */
export function enqueue(fn) {
  const result = tail.then(fn);
  tail = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Serialize across processes too, in case several MCP clients are attached. */
export async function withLock(fn, { log = silent } = {}) {
  const started = Date.now();
  let handle = null;

  for (;;) {
    try {
      handle = await fs.open(LOCK_FILE, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const stat = await fs.stat(LOCK_FILE).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        log('stealing a stale lock');
        await fs.unlink(LOCK_FILE).catch(() => {});
        continue;
      }
      if (Date.now() - started > 15 * 60 * 1000) throw new Error('gave up waiting for .generate.lock');
      await sleep(1000);
    }
  }

  try {
    return await fn();
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(LOCK_FILE).catch(() => {});
  }
}

// ------------------------------------------------------------------ generate

export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Generate one image and write it to disk.
 * @returns {Promise<{path:string, bytes:number, width:number|null, height:number|null}>}
 */
export async function generateImage({
  prompt,
  outDir = DEFAULT_OUT_DIR,
  filename,
  port = DEFAULT_PORT,
  timeout = Number(process.env.TIMEOUT || 180_000),
  ensure = true,
  log = silent,
} = {}) {
  if (!prompt || !prompt.trim()) throw new Error('prompt is required');

  return enqueue(() =>
    withLock(async () => {
      if (ensure) await ensureEndpoint({ port, log });
      return withLockBody({ prompt: prompt.trim(), outDir, filename, port, timeout, log });
    }, { log }),
  );
}

async function withLockBody({ prompt, outDir, filename, port, timeout, log }) {
  const cdp = await attachMain(port);

  try {
    // --- capture any image response that flows past while we wait
    await cdp.send('Network.enable', { maxTotalBufferSize: 512 * 1024 * 1024 });
    const captured = [];
    cdp.on(async (msg) => {
      if (msg.method !== 'Network.responseReceived') return;
      const { requestId, response } = msg.params;
      const interesting =
        (response.mimeType || '').startsWith('image/') ||
        /estuary|oaiusercontent|backend-api\/files|^blob:/i.test(response.url);
      if (!interesting) return;
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId });
        const buf = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
        if (buf.length > 20_000) {
          captured.push({ url: response.url, mimeType: response.mimeType, buf });
          log(`captured ${buf.length} bytes (${response.mimeType})`);
        }
      } catch {
        /* body evicted — ignore */
      }
    });

    // --- hard guard: never run in Work mode (that is the Codex-quota mode)
    const mode = await evaluate(cdp, () => {
      const b = document.querySelector('button[aria-label^="Switch mode"]');
      return b?.getAttribute('aria-label') || null;
    });
    log('mode:', mode);
    if (!/current mode: ChatGPT/i.test(mode || '')) {
      throw new Error(
        `refusing to run: the app reports mode "${mode}", expected "current mode: ChatGPT". ` +
          `Work mode runs the Codex agent and consumes your Codex allowance.`,
      );
    }

    const beforeSrcs = await evaluate(cdp, () => [...document.querySelectorAll('img')].map((i) => i.src));

    // --- a fresh *regular* chat (temporary chats cannot generate images)
    await evaluate(cdp, () => {
      const btns = [...document.querySelectorAll('[aria-label="New chat"]')];
      const target = btns.find((b) => b.getBoundingClientRect().top < 120) || btns[0];
      target?.click();
    });
    await sleep(2500);

    const isTemp = () => evaluate(cdp, () => /temporary/i.test(document.body.innerText.slice(0, 4000)));
    if (await isTemp()) throw new Error('still in a temporary chat — image generation is unavailable there');

    // --- type the prompt into the ProseMirror composer
    const focused = await evaluate(cdp, () => {
      const e = document.querySelector('[contenteditable="true"][role="textbox"]');
      if (!e) return false;
      e.focus();
      return true;
    });
    if (!focused) throw new Error('composer not found');

    await cdp.send('Input.insertText', { text: prompt });
    await sleep(600);

    const composerText = () =>
      evaluate(cdp, () => (document.querySelector('[contenteditable="true"][role="textbox"]')?.innerText || '').trim());

    if (!(await composerText())) {
      log('insertText did not stick — falling back to execCommand');
      await evaluate(cdp, (p) => {
        const e = document.querySelector('[contenteditable="true"][role="textbox"]');
        e.focus();
        document.execCommand('insertText', false, p);
      }, prompt);
      await sleep(600);
    }
    if (!(await composerText())) throw new Error('could not get the prompt into the composer');

    // --- send
    const clicked = await evaluate(cdp, () => {
      const b = document.querySelector('[data-testid="send-button"], button[aria-label="Send"]');
      if (!b) return false;
      b.click();
      return true;
    });
    if (clicked) {
      log('clicked send');
    } else {
      log('no send button — pressing Enter');
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
    }
    await sleep(1200);
    if (await composerText()) throw new Error('the composer still has text — send did not go through');

    // --- wait for the image
    log('waiting for the image…');
    let found;
    try {
      found = await waitFor(
        async () => {
          const dom = await evaluate(
            cdp,
            (prev) =>
              [...document.querySelectorAll('img')]
                .filter((i) => !prev.includes(i.src))
                .filter((i) => /^Generated image/i.test(i.alt || ''))
                .map((i) => ({ alt: i.alt, src: i.src, nat: `${i.naturalWidth}x${i.naturalHeight}` })),
            beforeSrcs,
          );
          if (dom.some((d) => d.nat !== '0x0')) return { via: 'dom', dom };
          const big = captured.filter((c) => c.buf.length > 50_000);
          if (big.length) return { via: 'network', big: big.map((c) => ({ url: c.url, bytes: c.buf.length })) };
          return null;
        },
        { timeout, interval: 2000, label: 'image generation' },
      );
    } catch (e) {
      const tailText = await evaluate(cdp, () =>
        (document.body.innerText || '').replace(/\s+/g, ' ').slice(-400),
      ).catch(() => '');
      throw new Error(`${e.message}\nlast UI text: …${tailText}`);
    }
    log('image detected via', found.via);

    // --- materialise the bytes
    const pick = captured.filter((c) => c.buf.length > 50_000).sort((a, b) => b.buf.length - a.buf.length)[0];
    if (!pick) throw new Error('image appeared in the DOM but no image bytes were captured off the network');

    const buf = pick.buf;
    await fs.mkdir(outDir, { recursive: true });
    const stem = filename?.replace(/\.png$/i, '') || `chatgpt-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const file = path.join(outDir, `${stem}.png`);
    await fs.writeFile(file, buf);

    const dim = pngSize(buf);
    log(`saved ${file} (${buf.length} bytes)`);
    return { path: file, bytes: buf.length, width: dim?.width ?? null, height: dim?.height ?? null, buffer: buf };
  } finally {
    cdp.close();
  }
}
