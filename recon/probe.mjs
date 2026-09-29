// Read-only reconnaissance of the ChatGPT (Codex desktop) page over CDP.
import { attach, evaluate } from '../cdp.mjs';

const cdp = await attach('index.html');
console.log('attached to:', cdp.target.url);
console.log('');

const info = await evaluate(cdp, () => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];

  const describe = (e) => ({
    tag: e.tagName,
    id: e.id || undefined,
    cls: (e.className || '').toString().slice(0, 90) || undefined,
    aria: e.getAttribute('aria-label') || undefined,
    testid: e.getAttribute('data-testid') || undefined,
    placeholder: e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || undefined,
    text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 70) || undefined,
    rect: (() => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })(),
  });

  const buttons = qa('button');
  const byLabel = (re) =>
    buttons.filter((b) => re.test(b.getAttribute('aria-label') || '') || re.test(b.getAttribute('data-testid') || '')).map(describe);

  return {
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },

    contentEditables: qa('[contenteditable="true"]').map(describe),
    textareas: qa('textarea').map(describe),
    textboxRoles: qa('[role="textbox"]').map(describe),

    sendButtons: byLabel(/send/i),
    newChatButtons: byLabel(/new chat|new-chat|compose/i),
    tempChatButtons: byLabel(/temporary|temp chat/i),
    imageButtons: byLabel(/image|create image/i),
    modelButtons: byLabel(/model/i),

    generatedImages: qa('img')
      .filter((i) => /generated image/i.test(i.alt || ''))
      .map((i) => ({ alt: i.alt, src: i.src.slice(0, 140), w: i.naturalWidth, h: i.naturalHeight })),

    totalImgCount: qa('img').length,
    totalButtonCount: buttons.length,
    totalSvgCount: qa('svg').length,

    // does the app expose its own API surface?
    hasFetch: typeof fetch === 'function',
    cookieLen: document.cookie.length,
  };
});

console.log(JSON.stringify(info, null, 2));
cdp.close();
