// Click a sidebar conversation row by title — to move the app off a conversation
// so the navigation path can be exercised. Shares the matcher with the core.
//
//   node recon/open-thread.mjs "Green Square Image"
//
import { getTargets, connect, evaluate, sleep } from '../cdp.mjs';
import { clickSidebarRowByTitle } from '../chatgpt.mjs';

const title = process.argv[2];
if (!title) {
  console.error('usage: node recon/open-thread.mjs "<exact sidebar title>"');
  process.exitCode = 1;
} else {
  const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
  if (!t) throw new Error('main window not found — is the app running with a debug port?');
  const cdp = await connect(t.webSocketDebuggerUrl);

  const current = () =>
    evaluate(cdp, () => {
      const el = document.querySelector(
        '[data-above-composer-conversation-id], [data-map-composer-conversation]',
      );
      const raw =
        el?.getAttribute('data-above-composer-conversation-id') ||
        el?.getAttribute('data-map-composer-conversation') ||
        '';
      const m = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      return { id: m ? m[0] : null, title: document.title };
    });

  console.log('before:', JSON.stringify(await current()));

  const geom = await evaluate(cdp, () => {
    const s = document.querySelector('[data-app-action-sidebar-scroll]');
    return s ? { max: s.scrollHeight - s.clientHeight, step: s.clientHeight } : { max: 0, step: 800 };
  });

  const stepSize = Math.max(300, geom.step - 100);
  let clicked = null;
  for (let top = 0; top <= geom.max + stepSize && !clicked; top += stepSize) {
    await evaluate(cdp, (y) => {
      const s = document.querySelector('[data-app-action-sidebar-scroll]');
      if (s) s.scrollTop = y;
    }, top);
    await sleep(400);
    clicked = await clickSidebarRowByTitle(cdp, title);
  }

  console.log('clicked:', clicked ? `"${clicked}"` : 'NOT FOUND');
  await sleep(2500);
  console.log('after :', JSON.stringify(await current()));
  cdp.close();
}
