// Do sidebar conversation entries carry a stable id we can navigate back to?
import { getTargets, connect, evaluate } from '../cdp.mjs';

const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
if (!t) throw new Error('main window not found — is the app running with a debug port?');
const cdp = await connect(t.webSocketDebuggerUrl);

const out = await evaluate(cdp, () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const attrNames = new Map(); // name -> sample values
  const sidebarish = [];

  for (const el of document.querySelectorAll('*')) {
    const attrs = [...(el.attributes || [])];
    for (const a of attrs) {
      if (!/^data-/.test(a.name)) continue;
      if (!attrNames.has(a.name)) attrNames.set(a.name, new Set());
      const set = attrNames.get(a.name);
      if (set.size < 3) set.add(String(a.value).slice(0, 60));
    }
    // anything that looks like a conversation row
    const hasThreadMarker = attrs.some((a) => /thread|conversation/i.test(a.name));
    if (hasThreadMarker) {
      const r = el.getBoundingClientRect();
      sidebarish.push({
        tag: el.tagName,
        title: clean(el.innerText).slice(0, 60),
        x: Math.round(r.x),
        y: Math.round(r.y),
        attrs: Object.fromEntries(attrs.filter((a) => /thread|conversation/i.test(a.name)).map((a) => [a.name, String(a.value).slice(0, 70)])),
      });
    }
  }

  return {
    dataAttributes: [...attrNames.entries()]
      .filter(([n]) => /thread|conversation|sidebar|id/i.test(n))
      .map(([n, v]) => ({ name: n, samples: [...v] })),
    threadMarkedElements: sidebarish.slice(0, 14),
  };
});

console.log(JSON.stringify(out, null, 2));
cdp.close();
