// Census of the data-* attributes on the page — how you discover that the app
// addresses things the way it does. Optional regex filter.
//
//   node recon/attrs.mjs
//   node recon/attrs.mjs "thread|conversation"
//
import { getTargets, connect, evaluate } from '../cdp.mjs';

const filter = process.argv[2] || null;

const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
if (!t) throw new Error('main window not found — is the app running with a debug port?');
const cdp = await connect(t.webSocketDebuggerUrl);

const out = await evaluate(
  cdp,
  (re) => {
    const names = new Map(); // name -> { count, samples }
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.attributes || []) {
        if (!/^data-/.test(a.name)) continue;
        if (re && !new RegExp(re, 'i').test(a.name)) continue;
        const entry = names.get(a.name) || { count: 0, samples: [] };
        entry.count++;
        if (entry.samples.length < 3 && !entry.samples.includes(String(a.value).slice(0, 70))) {
          entry.samples.push(String(a.value).slice(0, 70));
        }
        names.set(a.name, entry);
      }
    }
    return {
      attributeCount: names.size,
      attributes: [...names.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, v]) => ({ name, elements: v.count, samples: v.samples })),
    };
  },
  filter,
);

console.log(JSON.stringify(out, null, 2));
cdp.close();
