// Maps the sidebar: which sections exist, whether they are collapsed, and which
// conversation rows are actually rendered. Explains why a freshly created
// conversation can be absent from the DOM.
import { getTargets, connect, evaluate } from '../cdp.mjs';

const t = (await getTargets()).find((x) => x.type === 'page' && x.url === 'app://-/index.html');
if (!t) throw new Error('main window not found — is the app running with a debug port?');
const cdp = await connect(t.webSocketDebuggerUrl);

const out = await evaluate(cdp, () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const attr = (el, n) => el.getAttribute(n);

  const scroller = document.querySelector('[data-app-action-sidebar-scroll]');

  const headings = [...document.querySelectorAll('[data-app-action-sidebar-section-heading]')].map((el) => {
    const section = el.closest('[data-app-action-sidebar-section]') || el.parentElement;
    return {
      heading: attr(el, 'data-app-action-sidebar-section-heading'),
      collapsed: section ? attr(section, 'data-app-action-sidebar-section-collapsed') : null,
      sectionTitle: clean(section?.innerText).slice(0, 100),
    };
  });

  const rows = [...document.querySelectorAll('[data-app-action-sidebar-thread-row]')].map((el) => ({
    title: attr(el, 'data-app-action-sidebar-thread-title'),
    threadId: (attr(el, 'data-app-action-sidebar-thread-id') || '').slice(0, 40),
    chatgptKey: (attr(el, 'data-sidebar-chatgpt-conversation-key') || '').slice(0, 60),
    y: Math.round(el.getBoundingClientRect().y),
  }));

  return {
    scroller: scroller
      ? { scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }
      : null,
    headings,
    renderedRowCount: rows.length,
    rowsTop5: rows.slice(0, 5),
    rowsBottom3: rows.slice(-3),
    // how many rows carry a chatgpt conversation key at all
    rowsWithChatgptKey: rows.filter((r) => r.chatgptKey).length,
  };
});

console.log(JSON.stringify(out, null, 2));
cdp.close();
