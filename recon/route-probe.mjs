// Does opening a different conversation change the URL / history state?
// If yes, "reuse a specific thread" can be done by navigation instead of
// guessing at conversation titles.
import { getTargets, connect, evaluate, sleep } from '../cdp.mjs';

const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
if (!t) throw new Error('main window not found — is the app running with a debug port?');
const cdp = await connect(t.webSocketDebuggerUrl);

const readState = () =>
  evaluate(cdp, () => ({
    href: location.href,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    historyState: history.state ? JSON.stringify(history.state).slice(0, 200) : null,
    documentTitle: document.title,
    // any attribute anywhere that smells like a conversation id
    idAttrs: (() => {
      const out = new Set();
      for (const el of document.querySelectorAll('*')) {
        for (const a of el.attributes || []) {
          if (/conversation|thread|chat[_-]?id/i.test(a.name) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(a.value)) {
            out.add(`${a.name}=${String(a.value).slice(0, 60)}`);
            if (out.size > 6) return [...out];
          }
        }
      }
      return [...out];
    })(),
    localStorageKeys: Object.keys(localStorage).slice(0, 15),
  }));

console.log('--- before ---');
console.log(JSON.stringify(await readState(), null, 2));

// open a different conversation from the sidebar
const clicked = await evaluate(cdp, () => {
  const target = [...document.querySelectorAll('span')].find(
    (s) => (s.innerText || '').trim() === 'Create Red Circle Image',
  );
  if (!target) return null;
  const btn = target.closest('button') || target.parentElement;
  btn.click();
  return (target.innerText || '').trim();
});
console.log('\nclicked sidebar entry:', clicked);

await sleep(2500);

console.log('\n--- after ---');
console.log(JSON.stringify(await readState(), null, 2));

cdp.close();
