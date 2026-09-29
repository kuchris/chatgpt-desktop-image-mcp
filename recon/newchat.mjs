// Start a fresh regular ChatGPT chat, then report the resulting state.
import { getTargets, connect, evaluate, sleep } from '../cdp.mjs';

const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
const cdp = await connect(t.webSocketDebuggerUrl);

const snap = () =>
  evaluate(cdp, () => ({
    href: location.href,
    messages: document.querySelectorAll('[data-message-author-role]').length,
    composer: (document.querySelector('[contenteditable="true"]')?.innerText || '').trim().slice(0, 40),
    hasSend: !!document.querySelector('[data-testid="send-button"], button[aria-label="Send"]'),
    tempBanner: /temporary/i.test(document.body.innerText.slice(0, 4000)),
  }));

console.log('before:', JSON.stringify(await snap()));

const clicked = await evaluate(cdp, () => {
  const btns = [...document.querySelectorAll('[aria-label="New chat"]')];
  const info = btns.map((b) => {
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  // prefer a header-area button (top of the viewport)
  const target = btns.find((b) => b.getBoundingClientRect().top < 120) || btns[0];
  if (!target) return { ok: false, info };
  target.click();
  return { ok: true, info };
});
console.log('click:', JSON.stringify(clicked, null, 2));

await sleep(2500);
console.log('after :', JSON.stringify(await snap(), null, 2));

cdp.close();
