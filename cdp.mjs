// Minimal Chrome DevTools Protocol client — no dependencies.
// Node 22+ (global WebSocket + fetch).

const DEFAULT_PORT = Number(process.env.CDP_PORT || 9222);

export async function getTargets(port = DEFAULT_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`GET /json/list -> ${res.status}`);
  return res.json();
}

/**
 * Connect to a page target.
 * @param {(t:any)=>boolean|string} match  predicate, or a substring matched against t.url
 */
export async function attach(match = 'index.html', port = DEFAULT_PORT) {
  const targets = (await getTargets(port)).filter((t) => t.type === 'page');
  const pred = typeof match === 'function' ? match : (t) => t.url.includes(match);
  const target = targets.find(pred);
  if (!target) {
    throw new Error(
      `no page target matching ${match}. saw:\n` +
        targets.map((t) => `  ${t.type} ${t.url}`).join('\n'),
    );
  }
  const cdp = await connect(target.webSocketDebuggerUrl);
  cdp.target = target;
  return cdp;
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`ws connect failed: ${wsUrl}`)), {
      once: true,
    });
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) for (const fn of listeners) fn(msg);
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  const cdp = {
    send,
    ws,
    target: null,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
  cdp.evaluate = (fnOrExpr) => evaluate(cdp, fnOrExpr);
  return cdp;
}

/** Evaluate a function (serialized) or a raw expression string in the page. */
export async function evaluate(cdp, fnOrExpr, ...args) {
  const expression =
    typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
      : String(fnOrExpr);

  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(d.exception?.description || d.text || 'evaluate threw');
  }
  return res.result?.value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns something truthy, or throw after `timeout`. */
export async function waitFor(fn, { timeout = 180_000, interval = 1000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
}
