// Locate the top-level "New chat" control (there are many per-project ones).
import { getTargets, connect, evaluate } from '../cdp.mjs';

const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
const cdp = await connect(t.webSocketDebuggerUrl);

const out = await evaluate(cdp, () => {
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return {
      rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      inViewport: r.top >= 0 && r.bottom <= innerHeight && r.width > 0 && r.height > 0,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
    };
  };

  const exactNewChat = [...document.querySelectorAll('[aria-label="New chat"]')].map((e) => ({
    tag: e.tagName,
    testid: e.getAttribute('data-testid') || undefined,
    cls: (e.className || '').toString().slice(0, 70),
    ...vis(e),
  }));

  // any button inside the top header strip
  const header = [...document.querySelectorAll('button')]
    .filter((b) => {
      const r = b.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= 120 && r.width > 0 && r.height > 0;
    })
    .map((b) => ({
      aria: b.getAttribute('aria-label') || undefined,
      testid: b.getAttribute('data-testid') || undefined,
      text: (b.innerText || '').replace(/\s+/g, ' ').slice(0, 30) || undefined,
      rect: vis(b).rect,
    }));

  // elements that look like the composer's sibling "new chat" entry
  const composer = document.querySelector('[contenteditable="true"]');
  const nearComposer = composer
    ? [...document.querySelectorAll('button')]
        .filter((b) => {
          const r = b.getBoundingClientRect();
          const c = composer.getBoundingClientRect();
          return Math.abs(r.top - c.top) < 60 && r.width > 0;
        })
        .map((b) => ({ aria: b.getAttribute('aria-label') || undefined, rect: vis(b).rect }))
    : [];

  return {
    viewport: `${innerWidth}x${innerHeight}`,
    exactNewChatCount: exactNewChat.length,
    exactNewChat,
    headerButtons: header,
    nearComposer,
  };
});

console.log(JSON.stringify(out, null, 2));
cdp.close();
