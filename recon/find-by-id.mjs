// Finds every element carrying an attribute whose value contains the given uuid.
// Used to work out how conversation rows are actually addressed.
//
//   node recon/find-by-id.mjs <uuid> [<uuid> ...]
//
import { getTargets, connect, evaluate } from '../cdp.mjs';

const uuids = process.argv.slice(2);
if (uuids.length === 0) {
  console.error('usage: node recon/find-by-id.mjs <uuid> [...]');
  process.exitCode = 1;
} else {
  const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
  if (!t) throw new Error('main window not found — is the app running with a debug port?');
  const cdp = await connect(t.webSocketDebuggerUrl);

  const out = await evaluate(cdp, (wanted) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const found = {};

    // The sidebar only renders the rows near its scroll position, so a freshly
    // created conversation (which sits at the top of Recents) is simply absent
    // from the DOM until we scroll up there.
    const scroller = document.querySelector('[data-app-action-sidebar-scroll]');
    if (scroller) scroller.scrollTop = 0;

    for (const want of wanted) {
      const hits = [];
      for (const el of document.querySelectorAll('*')) {
        for (const a of el.attributes || []) {
          if (!String(a.value).includes(want)) continue;
          const r = el.getBoundingClientRect();
          hits.push({
            tag: el.tagName,
            attr: a.name,
            value: String(a.value).slice(0, 80),
            x: Math.round(r.x),
            y: Math.round(r.y),
            title: clean(el.innerText).slice(0, 50),
          });
        }
      }
      found[want] = { count: hits.length, hits: hits.slice(0, 12) };
    }

    // What do sidebar rows look like right now?
    const rowAttrs = new Map();
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.attributes || []) {
        if (/^data-(sidebar|app-action-sidebar|codex-tab)/.test(a.name) && !rowAttrs.has(a.name)) {
          rowAttrs.set(a.name, String(a.value).slice(0, 70));
        }
      }
    }

    return { found, sidebarAttrNames: [...rowAttrs.entries()].map(([n, v]) => `${n} = ${v}`) };
  }, uuids);

  console.log(JSON.stringify(out, null, 2));
  cdp.close();
}
