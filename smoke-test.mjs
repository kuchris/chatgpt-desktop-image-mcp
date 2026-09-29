// Speaks MCP to mcp-server.mjs over stdio and prints what comes back.
//
//   node smoke-test.mjs              # handshake + tools/list + image_status
//   node smoke-test.mjs --generate   # ...and one real image generation
//
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
const GENERATE = process.argv.includes('--generate');

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
readline
  .createInterface({ input: child.stdout, crlfDelay: Infinity })
  .on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('!! non-JSON on stdout:', line.slice(0, 200));
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      console.log('<- (notification)', JSON.stringify(msg).slice(0, 160));
    }
  });

let nextId = 0;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 300_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const fail = (m) => {
  console.error('SMOKE TEST FAILED:', m);
  child.kill();
  process.exit(1);
};

// 1. handshake
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '1.0.0' },
});
if (init.error) fail(JSON.stringify(init.error));
console.log('initialize ok:', JSON.stringify(init.result));
notify('notifications/initialized');

// 2. tools/list
const list = await rpc('tools/list');
if (list.error) fail(JSON.stringify(list.error));
console.log('tools:', list.result.tools.map((t) => t.name).join(', '));
for (const t of list.result.tools) {
  if (!t.description || !t.inputSchema) fail(`tool ${t.name} is missing description/schema`);
}

// 3. image_status (read-only)
const status = await rpc('tools/call', { name: 'image_status', arguments: {} });
console.log('\nimage_status ->');
console.log(status.result.content[0].text);

// 4. optional real generation
if (GENERATE) {
  console.log('\ngenerate_image (this takes 15-60s) ->');
  const t0 = Date.now();
  const gen = await rpc('tools/call', {
    name: 'generate_image',
    arguments: { prompt: 'a single black triangle centered on a plain white background', filename: 'mcp-smoke' },
  });
  if (gen.error) fail(JSON.stringify(gen.error));
  if (gen.result.isError) fail('tool reported an error: ' + gen.result.content[0].text);
  for (const block of gen.result.content) {
    console.log('  block:', block.type === 'image' ? `image (${block.mimeType}, ${block.data.length} base64 chars)` : block.text);
  }
  console.log(`  elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

console.log('\nSMOKE TEST PASSED');
child.stdin.end();
await new Promise((r) => child.on('exit', r));
console.log('server exited cleanly');
