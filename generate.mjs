// Drive the ChatGPT (Codex desktop) window over CDP to generate an image
// and save it as a PNG. No API key, no Codex quota — this is the Chat surface.
//
//   node generate.mjs "your prompt here"
//
import fs from 'node:fs/promises';
import path from 'node:path';
import { getTargets, connect, evaluate, sleep, waitFor } from './cdp.mjs';

const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), 'out');
const PROMPT =
  process.argv.slice(2).join(' ') ||
  'Create an image of a single red circle centered on a plain white background.';

const log = (...a) => console.log('[gen]', ...a);

// ---------------------------------------------------------------- attach
const target = (await getTargets()).find((t) => t.type === 'page' && t.url === 'app://-/index.html');
if (!target) throw new Error('main ChatGPT window not found on CDP');
const cdp = await connect(target.webSocketDebuggerUrl);
log('attached', target.id);

// ---------------------------------------------------------------- network capture
await cdp.send('Network.enable', { maxTotalBufferSize: 512 * 1024 * 1024 });
const captured = [];
cdp.on(async (msg) => {
  if (msg.method !== 'Network.responseReceived') return;
  const { requestId, response } = msg.params;
  const isImg =
    (response.mimeType || '').startsWith('image/') ||
    /estuary|oaiusercontent|backend-api\/files|blob/i.test(response.url);
  if (!isImg) return;
  try {
    const body = await cdp.send('Network.getResponseBody', { requestId });
    const buf = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
    if (buf.length > 20_000) {
      captured.push({ url: response.url, mimeType: response.mimeType, bytes: buf.length, buf });
      log(`captured network image: ${buf.length} bytes  ${response.mimeType}  ${response.url.slice(0, 90)}`);
    }
  } catch {
    /* body evicted or not available — ignore */
  }
});

// ---------------------------------------------------------------- safety: confirm Chat mode
const mode = await evaluate(cdp, () => {
  const b = document.querySelector('button[aria-label^="Switch mode"]');
  return b ? b.getAttribute('aria-label') : null;
});
log('mode:', mode);
if (!mode || !/current mode: ChatGPT/i.test(mode)) {
  throw new Error(`refusing to run: mode is "${mode}", expected "current mode: ChatGPT" (Work mode would burn Codex quota)`);
}

// ---------------------------------------------------------------- helpers
async function clickByAria(aria) {
  const ok = await evaluate(cdp, (a) => {
    const b = document.querySelector(`button[aria-label="${a}"]`);
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  }, aria);
  return ok;
}

const composerState = () =>
  evaluate(cdp, () => {
    const e = document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!e) return null;
    return {
      text: (e.innerText || '').trim(),
      aria: e.getAttribute('aria-label'),
      sendTestId: !!document.querySelector('[data-testid="send-button"]'),
    };
  });

// ---------------------------------------------------------------- temp chat
const beforeSrcs = await evaluate(cdp, () =>
  [...document.querySelectorAll('img')].map((i) => i.src),
);
log('images present before:', beforeSrcs.length);

const isTemp = () =>
  evaluate(cdp, () => /temporary/i.test(document.body.innerText.slice(0, 4000)));

if (await isTemp()) log('currently in a temporary chat — image generation is unavailable there, switching');

// Start a fresh REGULAR chat. Temporary chats do NOT support image generation.
const started = await evaluate(cdp, () => {
  const btns = [...document.querySelectorAll('[aria-label="New chat"]')];
  const target = btns.find((b) => b.getBoundingClientRect().top < 120) || btns[0];
  if (!target) return false;
  target.click();
  return true;
});
log('clicked "New chat":', started);
await sleep(2500);
if (await isTemp()) {
  throw new Error('still in a temporary chat — refusing to continue (image generation unavailable there)');
}
log('regular chat confirmed');

// ---------------------------------------------------------------- type prompt
const focused = await evaluate(cdp, () => {
  const e = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (!e) return false;
  e.focus();
  return document.activeElement === e || e.contains(document.activeElement);
});
log('composer focused:', focused);

await cdp.send('Input.insertText', { text: PROMPT });
await sleep(600);

let st = await composerState();
log('composer after insertText:', JSON.stringify(st));
if (!st || !st.text) {
  log('insertText did not stick — falling back to execCommand');
  await evaluate(cdp, (p) => {
    const e = document.querySelector('[contenteditable="true"][role="textbox"]');
    e.focus();
    document.execCommand('insertText', false, p);
  }, PROMPT);
  await sleep(600);
  st = await composerState();
  log('composer after execCommand:', JSON.stringify(st));
}
if (!st?.text) throw new Error('could not get text into the composer');

// ---------------------------------------------------------------- send
const sentViaButton = await evaluate(cdp, () => {
  const b = document.querySelector('[data-testid="send-button"], button[aria-label="Send"]');
  if (!b) return false;
  b.click();
  return true;
});
if (sentViaButton) {
  log('clicked send button');
} else {
  log('no send button — pressing Enter');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}
await sleep(1200);
log('composer after send:', JSON.stringify(await composerState()));

// ---------------------------------------------------------------- wait for the image
log('waiting for generated image…');
const result = await waitFor(
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
    if (dom.length && dom.some((d) => d.nat !== '0x0')) return { via: 'dom', images: dom };

    const big = captured.filter((c) => c.bytes > 50_000);
    if (big.length) return { via: 'network', images: big.map((c) => ({ url: c.url, bytes: c.bytes })) };
    return null;
  },
  { timeout: Number(process.env.TIMEOUT || 180_000), interval: 2000, label: 'image generation' },
);

log('image detected via', result.via);
console.log(JSON.stringify(result, null, 2));

// ---------------------------------------------------------------- save PNG
await fs.mkdir(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = path.join(OUT_DIR, `chatgpt-${stamp}`);

let saved = null;
if (result.via === 'network') {
  const pick = captured.filter((c) => c.bytes > 50_000).sort((a, b) => b.bytes - a.bytes)[0];
  await fs.writeFile(`${base}.png`, pick.buf);
  saved = `${base}.png`;
} else {
  // try in-page fetch of the signed URL
  const src = result.images[0].src;
  const dataUrl = await evaluate(cdp, async (u) => {
    try {
      const r = await fetch(u, { credentials: 'omit' });
      const b = await r.blob();
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(b);
      });
    } catch (e) {
      return 'ERR:' + e.message;
    }
  }, src);

  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    await fs.writeFile(`${base}.png`, Buffer.from(b64, 'base64'));
    saved = `${base}.png`;
  } else {
    log('in-page fetch failed:', dataUrl);
    const fallback = captured.filter((c) => c.bytes > 50_000).sort((a, b) => b.bytes - a.bytes)[0];
    if (fallback) {
      await fs.writeFile(`${base}.png`, fallback.buf);
      saved = `${base}.png`;
    }
  }
}

if (saved) {
  const stat = await fs.stat(saved);
  const head = (await fs.readFile(saved)).subarray(0, 8);
  log(`saved ${saved}  ${stat.size} bytes  magic=${head.toString('hex')}`);
  console.log('\nRESULT_IMAGE=' + saved);
} else {
  log('could not materialise the image bytes');
  process.exitCode = 2;
}

cdp.close();
