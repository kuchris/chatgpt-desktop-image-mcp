// Finds every element whose text matches a regex, so you can locate sidebar
// conversation entries / message bubbles that a plain selector misses.
//
//   node recon/find-text.mjs "triangle|red circle"
//
import { getTargets, connect, evaluate } from '../cdp.mjs';

const needle = process.argv[2];
if (!needle) {
  console.error('usage: node recon/find-text.mjs "<regex>"');
  process.exitCode = 1;
} else {
  const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
  if (!t) throw new Error('main window not found — is the app running with a debug port?');
  const cdp = await connect(t.webSocketDebuggerUrl);

  const info = await evaluate(
    cdp,
    (pattern) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const re = new RegExp(pattern, 'i');

      const hits = [];
      for (const el of document.querySelectorAll('button, a, li, [role="listitem"], [role="option"], span, div')) {
        const txt = clean(el.innerText);
        if (!txt || txt.length > 120) continue;
        if (!re.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        // keep the innermost match only
        if ([...el.children].some((c) => re.test(clean(c.innerText)))) continue;
        hits.push({
          tag: el.TagName || el.tagName,
          role: el.getAttribute('role') || undefined,
          aria: clean(el.getAttribute('aria-label')) || undefined,
          x: Math.round(r.x),
          y: Math.round(r.y),
          text: txt.slice(0, 90),
        });
      }

      return {
        documentTitle: document.title,
        totalHits: hits.length,
        hits: hits.slice(0, 30),
      };
    },
    needle,
  );

  console.log(JSON.stringify(info, null, 2));
  cdp.close();
}
