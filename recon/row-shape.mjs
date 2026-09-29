// Given a sidebar title, print the element carrying that text and its ancestor
// chain with their data-* attributes. Explains why a row is not matchable.
//
//   node recon/row-shape.mjs "Green Square Image"
//
import { getTargets, connect, evaluate } from '../cdp.mjs';

const title = process.argv[2];
if (!title) {
  console.error('usage: node recon/row-shape.mjs "<exact text>"');
  process.exitCode = 1;
} else {
  const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
  if (!t) throw new Error('main window not found — is the app running with a debug port?');
  const cdp = await connect(t.webSocketDebuggerUrl);

  const out = await evaluate(
    cdp,
    (want) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

      const leaves = [...document.querySelectorAll('span, div, button, a')].filter(
        (el) => clean(el.innerText) === want,
      );

      const dumps = leaves.slice(0, 3).map((el) => {
        const chain = [];
        let node = el;
        for (let i = 0; i < 8 && node && node !== document.body; i++) {
          chain.push({
            tag: node.tagName,
            depth: i,
            dataAttrs: Object.fromEntries(
              [...(node.attributes || [])]
                .filter((a) => /^data-/.test(a.name))
                .map((a) => [a.name, String(a.value).slice(0, 60)]),
            ),
          });
          node = node.parentElement;
        }
        return { matchedTag: el.tagName, chain };
      });

      // how many rows exist per row-attribute type
      return {
        leavesFound: leaves.length,
        dumps,
        rowAttrCounts: {
          threadRow: document.querySelectorAll('[data-app-action-sidebar-thread-row]').length,
          threadId: document.querySelectorAll('[data-app-action-sidebar-thread-id]').length,
          threadTitle: document.querySelectorAll('[data-app-action-sidebar-thread-title]').length,
          chatgptKey: document.querySelectorAll('[data-sidebar-chatgpt-conversation-key]').length,
        },
        allThreadTitles: [...document.querySelectorAll('[data-app-action-sidebar-thread-title]')]
          .map((e) => e.getAttribute('data-app-action-sidebar-thread-title'))
          .slice(0, 20),
      };
    },
    title,
  );

  console.log(JSON.stringify(out, null, 2));
  cdp.close();
}
