// Fingerprint every CDP page target so we can find the real chat window.
import { getTargets, connect, evaluate } from '../cdp.mjs';

const targets = await getTargets();
console.log(`total targets: ${targets.length}\n`);

for (const t of targets) {
  if (t.type !== 'page') {
    console.log(`[${t.type}] ${t.url}\n`);
    continue;
  }
  let fp;
  try {
    const cdp = await connect(t.webSocketDebuggerUrl);
    fp = await evaluate(cdp, () => ({
      title: document.title,
      href: location.href,
      viewport: `${innerWidth}x${innerHeight}`,
      buttons: document.querySelectorAll('button').length,
      composer: (() => {
        const e = document.querySelector('[contenteditable="true"]');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return `${e.getAttribute('aria-label') || '?'} @ ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      })(),
      sidebarChats: document.querySelectorAll('nav a, [role="listitem"]').length,
      imgs: document.querySelectorAll('img').length,
      bodyHead: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
    }));
    cdp.close();
  } catch (e) {
    fp = { error: String(e.message || e) };
  }
  console.log('â”€'.repeat(80));
  console.log(`id   : ${t.id}`);
  console.log(`url  : ${t.url}`);
  console.log(`fp   : ${JSON.stringify(fp, null, 2)}`);
  console.log('');
}
