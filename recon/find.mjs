// The workhorse for re-deriving selectors after a ChatGPT UI update.
//
//   node recon/find.mjs text  "<regex>"        elements whose text matches
//   node recon/find.mjs id    "<substring>"    elements with an attribute containing it
//   node recon/find.mjs shape "<exact text>"   that element, plus its ancestor chain
//
import { getTargets, connect, evaluate } from '../cdp.mjs';

const [mode, arg] = process.argv.slice(2);
const MODES = ['text', 'id', 'shape'];

if (!MODES.includes(mode) || !arg) {
  console.error('usage: node recon/find.mjs <text|id|shape> "<value>"');
  process.exitCode = 1;
} else {
  const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
  if (!t) throw new Error('main window not found — is the app running with a debug port?');
  const cdp = await connect(t.webSocketDebuggerUrl);

  const out = await evaluate(
    cdp,
    (m, value) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return `x=${Math.round(r.x)} y=${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      };

      if (m === 'text') {
        const re = new RegExp(value, 'i');
        const hits = [];
        for (const el of document.querySelectorAll('span, div, button, a, li, [role="listitem"]')) {
          const txt = clean(el.innerText);
          if (!txt || txt.length > 120 || !re.test(txt)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if ([...el.children].some((c) => re.test(clean(c.innerText)))) continue; // innermost only
          hits.push({ tag: el.tagName, aria: clean(el.getAttribute('aria-label')) || undefined, rect: rect(el), text: txt.slice(0, 90) });
        }
        return { mode: m, value, documentTitle: document.title, totalHits: hits.length, hits: hits.slice(0, 30) };
      }

      if (m === 'id') {
        const hits = [];
        for (const el of document.querySelectorAll('*')) {
          for (const a of el.attributes || []) {
            if (!String(a.value).includes(value)) continue;
            hits.push({ tag: el.tagName, attr: a.name, value: String(a.value).slice(0, 80), rect: rect(el), text: clean(el.innerText).slice(0, 50) });
          }
        }
        return { mode: m, value, documentTitle: document.title, totalHits: hits.length, hits: hits.slice(0, 25) };
      }

      // shape
      const leaves = [...document.querySelectorAll('span, div, button, a')].filter(
        (el) => clean(el.innerText) === value,
      );
      return {
        mode: m,
        value,
        documentTitle: document.title,
        leavesFound: leaves.length,
        dumps: leaves.slice(0, 3).map((el) => {
          const chain = [];
          let node = el;
          for (let i = 0; i < 8 && node && node !== document.body; i++) {
            chain.push({
              depth: i,
              tag: node.tagName,
              dataAttrs: Object.fromEntries(
                [...(node.attributes || [])]
                  .filter((a) => /^data-/.test(a.name))
                  .map((a) => [a.name, String(a.value).slice(0, 60)]),
              ),
            });
            node = node.parentElement;
          }
          return { matchedTag: el.tagName, chain };
        }),
      };
    },
    mode,
    arg,
  );

  console.log(JSON.stringify(out, null, 2));
  cdp.close();
}
