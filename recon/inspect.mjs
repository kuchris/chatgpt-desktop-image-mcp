// Detailed reconnaissance of the MAIN ChatGPT window.
import { getTargets, connect, evaluate } from '../cdp.mjs';

const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
if (!t) throw new Error('main window target not found');
const cdp = await connect(t.webSocketDebuggerUrl);
console.log('target:', t.id, t.url, '\n');

const info = await evaluate(cdp, () => {
  const qa = (s) => [...document.querySelectorAll(s)];
  const rect = (e) => {
    const r = e.getBoundingClientRect();
    return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  };
  const desc = (e) => ({
    tag: e.tagName,
    aria: e.getAttribute('aria-label') || undefined,
    testid: e.getAttribute('data-testid') || undefined,
    role: e.getAttribute('role') || undefined,
    text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 60) || undefined,
    rect: rect(e),
  });

  const buttons = qa('button');
  const match = (re) =>
    buttons
      .filter((b) => re.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '')))
      .map(desc);

  const composer = document.querySelector('[contenteditable="true"]');

  return {
    composer: composer ? { ...desc(composer), cls: (composer.className || '').slice(0, 80) } : null,

    sendish: match(/send|submit/i),
    stopish: match(/stop/i),
    tempChat: match(/temporary/i),
    newChat: match(/new chat|compose/i),
    modeSwitch: match(/switch mode|current mode|mode/i),
    createImage: match(/create image|image gen|generate image/i),
    modelPicker: match(/model/i),
    attach: match(/attach|upload|add files|plus/i),

    // things whose visible text mentions image
    textMentionsImage: qa('button, div[role="button"], [role="menuitem"]')
      .filter((e) => /create image|ç”Ÿæˆåœ–ç‰‡|ç”Ÿæˆå›¾åƒ/i.test(e.innerText || ''))
      .slice(0, 8)
      .map(desc),

    // any tool/skill chip near composer
    composerRegion: composer
      ? qa('button')
          .filter((b) => {
            const r = b.getBoundingClientRect();
            const c = composer.getBoundingClientRect();
            return r.top > c.top - 200 && r.bottom < c.bottom + 120 && r.width > 0;
          })
          .slice(0, 20)
          .map(desc)
      : [],

    generatedImgs: qa('img')
      .filter((i) => /generated|image/i.test(i.alt || ''))
      .slice(0, 5)
      .map((i) => ({ alt: i.alt, src: i.src.slice(0, 120), nat: `${i.naturalWidth}x${i.naturalHeight}` })),

    // network surface available to us
    hasServiceWorker: !!navigator.serviceWorker,
    origin: location.origin,
  };
});

console.log(JSON.stringify(info, null, 2));
cdp.close();
