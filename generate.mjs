#!/usr/bin/env node
// CLI wrapper around the shared core.
//
//   node generate.mjs "a red circle on white"
//   node generate.mjs --out ./public --name hero "a red circle on white"
//   node generate.mjs --status
//
// Note: never call process.exit() here. The CDP client closes a WebSocket on the
// way out, and exiting while that handle is still closing trips a libuv assertion
// on Windows (async.c). Setting process.exitCode and letting the event loop drain
// exits just as reliably.
import path from 'node:path';
import { generateImage, probeStatus, focusConversation } from './chatgpt.mjs';

const HELP = `codeximg — generate images with ChatGPT via the Codex desktop app

usage:
  node generate.mjs "prompt"              generate in a NEW conversation (default)
  node generate.mjs --reuse "prompt"      generate in the conversation last used,
                                          so the model can iterate on its own output
  node generate.mjs --status              report whether the bridge is usable
  node generate.mjs --focus               open the saved conversation, generate nothing
  node generate.mjs -o <dir> -n <name> "prompt"

env:
  OUT_DIR                 default output directory (default: ./out)
  CDP_PORT                default 9222
  TIMEOUT                 ms to wait for an image (default 180000)
  CODEXIMG_AUTOLAUNCH=0   never auto-start the app
  CODEXIMG_RETURN_IMAGE=0 (MCP only) return the path, not the image bytes`;

const argv = process.argv.slice(2);
const opts = { outDir: undefined, filename: undefined };
const rest = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out' || a === '-o') opts.outDir = path.resolve(argv[++i]);
  else if (a === '--name' || a === '-n') opts.filename = argv[++i];
  else if (a === '--reuse') opts.thread = 'reuse';
  else if (a === '--new') opts.thread = 'new';
  else if (a === '--thread') opts.thread = argv[++i];
  else if (a === '--status') opts.status = true;
  else if (a === '--focus') opts.focus = true;
  else if (a === '--help' || a === '-h') opts.help = true;
  else rest.push(a);
}

const log = (...a) => console.log('[codeximg]', ...a);

if (opts.help) {
  console.log(HELP);
  process.exitCode = 0;
} else if (opts.status) {
  const s = await probeStatus();
  console.log(JSON.stringify(s, null, 2));
  process.exitCode = s.usable ? 0 : 1;
} else if (opts.focus) {
  const r = await focusConversation({ log });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
} else {
  const prompt = rest.join(' ').trim();
  if (!prompt) {
    console.log(HELP);
    process.exitCode = 1;
  } else {
    try {
      const r = await generateImage({ prompt, ...opts, log });
      console.log('');
      console.log(`RESULT_IMAGE=${r.path}`);
      console.log(`bytes=${r.bytes} dimensions=${r.width}x${r.height}`);
    } catch (e) {
      console.error(`\n[codeximg] FAILED: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
