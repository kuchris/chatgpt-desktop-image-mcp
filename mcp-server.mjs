#!/usr/bin/env node
// MCP stdio server: exposes ChatGPT image generation to any MCP client
// (Claude Code, Claude Desktop, Cursor, ...).
//
//   claude mcp add -s user codeximg -- node /abs/path/to/mcp-server.mjs
//
// stdout is reserved for JSON-RPC. All logging goes to stderr.
import readline from 'node:readline';
import path from 'node:path';
import { generateImage, probeStatus } from './chatgpt.mjs';

const SERVER = { name: 'codeximg', version: '0.2.0' };
const FALLBACK_PROTOCOL = '2025-06-18';
const RETURN_IMAGE = process.env.CODEXIMG_RETURN_IMAGE !== '0';

const log = (...a) => process.stderr.write(`[codeximg] ${a.join(' ')}\n`);

const TOOLS = [
  {
    name: 'generate_image',
    description:
      'Generate an image with ChatGPT and save it as a PNG on disk. Returns the file path, ' +
      'the dimensions, and the image itself.\n\n' +
      'Use for any visual asset the user asks for: a picture, illustration, icon, logo, ' +
      'mockup or photo. Do not call it speculatively, and do not use it for diagrams or ' +
      'charts that text already conveys.\n\n' +
      'Not idempotent: the same prompt twice yields two different images and two files. ' +
      'Takes 15-60 seconds, and calls are serialized because they share one application ' +
      'window. Writes a new PNG every time, and overwrites an existing file if "filename" ' +
      'collides with one. With thread "new" it also adds a conversation to the user\'s ' +
      'ChatGPT sidebar.\n\n' +
      'It drives the already-signed-in Codex desktop app over the DevTools protocol, so it ' +
      'needs no API key and consumes no Codex agent quota. It refuses to run if the app is ' +
      'in Work mode, because that would spend Codex usage.',
    annotations: {
      title: 'Generate an image with ChatGPT',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Subject, style, palette, mood, composition. Be descriptive and specific. ' +
            'For transparency or text-in-image, say so explicitly in the prompt.',
        },
        filename: {
          type: 'string',
          description: 'Output file name without the .png extension. Defaults to chatgpt-<timestamp>.',
        },
        output_dir: {
          type: 'string',
          description:
            'Directory to write into. Prefer an absolute path, or a path relative to this server\'s ' +
            'working directory. Defaults to <codeximg>/out.',
        },
        thread: {
          type: 'string',
          enum: ['new', 'reuse'],
          description:
            '"new" (default) starts a fresh conversation: fully isolated, but each call adds a row ' +
            'to the user\'s sidebar and the model cannot see earlier generations. ' +
            '"reuse" posts into the conversation this tool last used, so you can iterate ' +
            '("same image but blue"). Use "reuse" when refining, "new" for a fresh subject.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'image_status',
    description:
      'Report whether image generation is usable right now: whether the debug port is open, ' +
      'whether the app is in Chat mode, whether the composer is present, and which ' +
      'conversation is currently open.\n\n' +
      'Call this to diagnose a generate_image failure, or before the first generation of a ' +
      'session, rather than guessing at the cause. Read-only, and safe to call at any time.',
    annotations: {
      title: 'Check image-generation status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ------------------------------------------------------------------ transport

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(name, args = {}) {
  if (name === 'generate_image') {
    const outDir = args.output_dir ? path.resolve(args.output_dir) : undefined;
    const r = await generateImage({
      prompt: args.prompt,
      outDir,
      filename: args.filename,
      thread: args.thread,
      log,
    });

    const content = [
      {
        type: 'text',
        text:
          `Generated image saved to:\n${r.path}\n` +
          `size: ${(r.bytes / 1024).toFixed(0)} KB` +
          (r.width ? `, ${r.width}x${r.height} px` : ''),
      },
    ];
    if (RETURN_IMAGE) {
      content.push({ type: 'image', data: r.buffer.toString('base64'), mimeType: 'image/png' });
    }
    return { content };
  }

  if (name === 'image_status') {
    const s = await probeStatus();
    return { content: [{ type: 'text', text: JSON.stringify(s, null, 2) }] };
  }

  throw new Error(`unknown tool: ${name}`);
}

async function handle(msg) {
  const { id, method, params } = msg;

  // notifications carry no id and get no response
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('client initialized');
    return;
  }

  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion || FALLBACK_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER,
        });

      case 'ping':
        return reply(id, {});

      case 'tools/list':
        return reply(id, { tools: TOOLS });

      // This server exposes no resources or prompts, but registry indexers
      // introspect all three list methods regardless of what was declared, and
      // Glama's sandbox pipeline is one of them. An empty list is friendlier
      // there than -32601.
      case 'resources/list':
        return reply(id, { resources: [] });

      case 'resources/templates/list':
        return reply(id, { resourceTemplates: [] });

      case 'prompts/list':
        return reply(id, { prompts: [] });

      case 'tools/call': {
        const name = params?.name;
        try {
          const result = await callTool(name, params?.arguments || {});
          return reply(id, result);
        } catch (e) {
          // tool failures are results, not protocol errors, so the model can read them
          return reply(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
        }
      }

      default:
        return replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    replyError(id, -32603, `internal error: ${e.message}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let inflight = Promise.resolve();

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    log(`dropping malformed line: ${text.slice(0, 120)}`);
    return;
  }
  // keep messages ordered, and never let one rejection kill the loop
  inflight = inflight.then(() => handle(msg)).catch((e) => log(`handler error: ${e.message}`));
});

rl.on('close', async () => {
  log('stdin closed, exiting');
  try {
    await inflight;
  } catch {
    /* already logged by the handler */
  }
  // Deliberately no process.exit() here: on Windows that can trip a libuv
  // assertion (async.c) while the stdio handles are still closing. With no
  // handles left the event loop drains and the process exits anyway.
});

log(`ready (${SERVER.name} ${SERVER.version}, protocol ${FALLBACK_PROTOCOL})`);
