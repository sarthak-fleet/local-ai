import { createServer } from 'http';
import { URL } from 'url';
import { spawn } from 'child_process';

// ── CLI Tool Registry ─────────────────────────────────────────────
// Each entry describes how to talk to a specific CLI tool.
//   command        — the binary name
//   buildArgs      — fn(model, systemPrompt) → string[]
//   inputMode      — 'stdin' | 'arg'  (how the prompt is sent)
//   embedSystemPrompt — if true, system prompt is prepended to the prompt text
//   parseStream    — fn(jsonLine, emit) to extract text; null = plain text mode

const CLI_TOOLS = {
  claude: {
    command: 'claude',
    buildArgs: (model, systemPrompt) => {
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      if (model) args.push('--model', model);
      if (systemPrompt) args.push('--system-prompt', systemPrompt);
      return args;
    },
    inputMode: 'stdin',
    embedSystemPrompt: false,
    supportsImages: false,
    parseStream: (line, emit) => {
      const json = JSON.parse(line);
      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text' && block.text) emit(block.text);
        }
        return;
      }
      if (json.type === 'content_block_delta' && json.delta?.text) {
        emit(json.delta.text);
      }
    },
  },

  codex: {
    // codex exec --json outputs JSONL with item.completed events
    command: 'codex',
    buildArgs: (model) => {
      const args = ['exec', '--json'];
      if (model) args.push('--model', model);
      return args;
    },
    inputMode: 'stdin',
    embedSystemPrompt: true,
    supportsImages: true,
    // For each image path, append: -i <path>
    appendImageArgs: (args, imagePaths) => {
      for (const p of imagePaths) args.push('-i', p);
    },
    parseStream: (line, emit) => {
      const json = JSON.parse(line);
      if (json.type === 'item.completed' && json.item?.type === 'agent_message' && json.item.text) {
        emit(json.item.text);
      }
    },
  },

  gemini: {
    // gemini CLI outputs plain text to stdout, no JSON streaming
    command: 'gemini',
    buildArgs: (model) => {
      const args = [];
      if (model) args.push('--model', model);
      return args;
    },
    inputMode: 'arg',
    embedSystemPrompt: true,
    supportsImages: false,
    parseStream: null, // plain text mode — no JSON parsing
  },
};

// Normalize content to { text, imagePaths }. Accepts:
//   - string  → { text: <string>, imagePaths: [] }
//   - array of { type: 'text', text } | { type: 'image', image_path } parts
function normalizeContent(content) {
  if (typeof content === 'string') return { text: content, imagePaths: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ''), imagePaths: [] };

  const textParts = [];
  const imagePaths = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text);
    } else if (part.type === 'image' && typeof part.image_path === 'string') {
      imagePaths.push(part.image_path);
    }
  }
  return { text: textParts.join('\n'), imagePaths };
}

// ── Minimal router + response helpers ─────────────────────────────
// A thin shim over Node's http so route handlers stay declarative.
// `res` is augmented with the small subset of the Express API we used:
//   res.status(code)         — set status, chainable
//   res.json(obj)            — send JSON body
//   res.setHeader / write / end / flushHeaders — native or shimmed.

const routes = []; // { method, path, handler }

function route(method, path, handler) {
  routes.push({ method, path, handler });
}

const api = {
  get: (path, handler) => route('GET', path, handler),
  post: (path, handler) => route('POST', path, handler),
  put: (path, handler) => route('PUT', path, handler),
  delete: (path, handler) => route('DELETE', path, handler),
};

function findRoute(method, pathname) {
  // Match either the bare path (/health) or the /api-prefixed path (/api/health).
  for (const r of routes) {
    if (r.method !== method) continue;
    if (pathname === r.path || pathname === `/api${r.path}`) return r;
  }
  return null;
}

const localStore = {
  progress: new Map(),
  notes: new Map(),
  chats: new Map(),
};

function localUserId(_req) {
  return 'local-dev-user';
}

function scopedKey(req, problemId) {
  return `${localUserId(req)}:${problemId}`;
}

// ── Routes ────────────────────────────────────────────────────────

api.get('/health', (_req, res) => {
  res.json({ status: 'ok', providers: Object.keys(CLI_TOOLS) });
});

api.get('/auth/verify', (_req, res) => {
  res.status(401).json({ error: 'Unauthorized' });
});

api.post('/auth/logout', (_req, res) => {
  res.json({ success: true });
});

api.get('/progress', (req, res) => {
  const prefix = `${localUserId(req)}:`;
  const progress = {};
  for (const [key, value] of localStore.progress.entries()) {
    if (key.startsWith(prefix)) progress[key.slice(prefix.length)] = value;
  }
  res.json({ progress });
});

api.put('/progress', (req, res) => {
  const { problemId, data } = req.body ?? {};
  if (!problemId || !data) {
    return res.status(400).json({ error: 'problemId and data required' });
  }
  localStore.progress.set(scopedKey(req, problemId), {
    status: data.status || 'unseen',
    code: data.code || undefined,
    language: data.language || 'typescript',
    bookmarked: Boolean(data.bookmarked),
    lastAttempted: data.lastAttempted || undefined,
    ease: data.ease ?? 2.5,
    interval: data.interval ?? 0,
    repetitions: data.repetitions ?? 0,
    nextReview: data.nextReview || undefined,
    lastReview: data.lastReview || undefined,
  });
  res.json({ success: true });
});

api.get('/notes', (req, res) => {
  const problemId = req.query.problemId;
  if (!problemId) return res.status(400).json({ error: 'problemId required' });
  res.json({ notes: localStore.notes.get(scopedKey(req, problemId)) ?? '' });
});

api.post('/notes', (req, res) => {
  const { problemId, notes } = req.body ?? {};
  if (!problemId || notes === undefined) {
    return res.status(400).json({ error: 'problemId and notes required' });
  }
  localStore.notes.set(scopedKey(req, problemId), String(notes));
  res.json({ success: true });
});

api.get('/chats', (req, res) => {
  const problemId = req.query.problemId;
  if (!problemId) return res.status(400).json({ error: 'problemId required' });
  res.json({ messages: localStore.chats.get(scopedKey(req, problemId)) ?? [] });
});

api.post('/chats', (req, res) => {
  const { problemId, messages } = req.body ?? {};
  if (!problemId || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'problemId and messages required' });
  }
  localStore.chats.set(scopedKey(req, problemId), messages);
  res.json({ success: true });
});

api.delete('/chats', (req, res) => {
  const problemId = req.query.problemId;
  if (!problemId) return res.status(400).json({ error: 'problemId required' });
  localStore.chats.delete(scopedKey(req, problemId));
  res.json({ success: true });
});

// POST /chat — { provider|tool, model?, messages, systemPrompt? }
api.post('/chat', (req, res) => {
  const { provider, tool, model, messages, systemPrompt } = req.body;
  const providerName = provider || tool || 'claude';

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const cliTool = CLI_TOOLS[providerName];
  if (!cliTool) {
    return res.status(400).json({
      error: `Unknown provider: ${providerName}`,
      available: Object.keys(CLI_TOOLS),
    });
  }

  // Normalize each message's content and collect any image paths for CLIs that support them.
  const allImagePaths = [];
  const normalizedMessages = messages.map((m) => {
    const { text, imagePaths } = normalizeContent(m.content);
    if (imagePaths.length && cliTool.supportsImages) {
      allImagePaths.push(...imagePaths);
    }
    return { role: m.role, text };
  });

  // Build prompt — embed system prompt for tools that don't have a dedicated flag
  let prompt = normalizedMessages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n\n');

  if (cliTool.embedSystemPrompt && systemPrompt) {
    prompt = `System instructions: ${systemPrompt}\n\n${prompt}`;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const args = cliTool.buildArgs(model, systemPrompt);
  if (cliTool.appendImageArgs && allImagePaths.length) {
    cliTool.appendImageArgs(args, allImagePaths);
  }
  if (cliTool.inputMode === 'arg') args.push('-p', prompt);

  const proc = spawn(cliTool.command, args, {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (cliTool.inputMode === 'stdin') {
    proc.stdin.write(prompt);
    proc.stdin.end();
  }

  let buffer = '';
  let textSent = false;
  const isPlainText = !cliTool.parseStream;

  proc.stdout.on('data', (data) => {
    if (isPlainText) {
      // Plain text mode — forward stdout chunks directly
      const text = data.toString();
      if (text) {
        textSent = true;
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
      return;
    }

    // JSON streaming mode
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        cliTool.parseStream(line, (text) => {
          textSent = true;
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        });
      } catch {
        // Non-JSON line — emit as plain text if it doesn't look like JSON
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
          textSent = true;
          res.write(`data: ${JSON.stringify({ text: trimmed + '\n' })}\n\n`);
        }
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[${providerName} stderr]`, msg);
  });

  proc.on('close', (code) => {
    // Flush remaining buffer
    if (buffer.trim()) {
      if (isPlainText) {
        res.write(`data: ${JSON.stringify({ text: buffer.trim() })}\n\n`);
      } else {
        try {
          cliTool.parseStream(buffer, (text) => {
            textSent = true;
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          });
        } catch {
          if (!textSent) {
            res.write(`data: ${JSON.stringify({ text: buffer.trim() })}\n\n`);
          }
        }
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
    if (code !== 0) console.error(`[${providerName}] exited with code ${code}`);
  });

  proc.on('error', (err) => {
    console.error(`[${providerName} spawn error]`, err.message);
    res.write(`data: ${JSON.stringify({ error: `Failed to start ${providerName} CLI. Is it installed?` })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  res.on('close', () => {
    if (!proc.killed) proc.kill('SIGTERM');
  });
});

// ── Request body parsing (replaces express.json({ limit: '1mb' })) ─

const BODY_LIMIT = 1024 * 1024; // 1mb

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const method = req.method;
    // Only parse a body for methods that carry one; mirror express.json behavior
    // of yielding an empty object when there's nothing to parse.
    if (method === 'GET' || method === 'HEAD') return resolve({});

    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('request entity too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ── Response augmentation (Express-compatible subset) ─────────────

function augmentResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    const body = JSON.stringify(obj);
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(body);
    return res;
  };
  // express's res.flushHeaders → http's res.flushHeaders (already present);
  // provide a no-op fallback just in case.
  if (typeof res.flushHeaders !== 'function') res.flushHeaders = () => {};
  return res;
}

// ── CORS (replaces cors() with default permissive config) ─────────

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,HEAD,PUT,PATCH,POST,DELETE'
  );
  const reqHeaders = req.headers['access-control-request-headers'];
  if (reqHeaders) res.setHeader('Access-Control-Allow-Headers', reqHeaders);
}

// ── Server ────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3456;

const server = createServer(async (req, res) => {
  augmentResponse(res);
  applyCors(req, res);

  // CORS preflight — mirror cors() default (204, no body).
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Content-Length', '0');
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Expose query params as a plain object (req.query parity for our use).
  req.query = Object.fromEntries(url.searchParams.entries());

  const matched = findRoute(req.method, pathname);
  if (!matched) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    req.body = await readJsonBody(req);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return;
  }

  try {
    matched.handler(req, res);
  } catch (err) {
    console.error('[handler error]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    else if (!res.writableEnded) res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n  local-ai running on http://localhost:${PORT}`);
  console.log(`  Providers: ${Object.keys(CLI_TOOLS).join(', ')}`);
  console.log(`  Health: http://localhost:${PORT}/health\n`);
});
