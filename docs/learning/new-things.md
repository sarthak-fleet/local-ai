# New things to learn — local-ai

Node + Express 5 bridge that spawns AI CLIs and tunnels their output as SSE — touches Express 5 release changes, SSE mechanics, child_process framing, and per-provider streaming formats.

---

## Express 5 Router + async error propagation
- What: Express 5 (released 2024) promotes `Router` to first-class import and auto-propagates async handler rejections without `next(err)` wrappers.
- Why here: TBD
- Source: https://expressjs.com/en/guide/migrating-5.html

## SSE — `flushHeaders()` before first `write()`
- What: `res.flushHeaders()` sends HTTP headers immediately so the browser opens the event stream before any data arrives; without it, Node's response buffer holds the connection until it fills.
- Why here: TBD
- Gotcha (from code): `index.mjs:194` calls `res.flushHeaders()` right after setting the three SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`), then `spawn()` at line 199 — reversing the order silently delays all events.
- Sources: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events; https://nodejs.org/api/http.html#responseflushheaders (Node.js HTTP docs — canonical `flushHeaders` reference)

## Per-provider SSE framing (JSONL vs plain text)
- What: Claude Code emits structured JSONL (`--output-format stream-json`), Codex emits `item.completed` agent events, Gemini emits raw plain text — each needs a different parse strategy.
- Why here: TBD
- Gotcha (from code): `parseStream: null` (`index.mjs:66`) is the sentinel for Gemini plain-text mode; `isPlainText` (`line 211`) bypasses the `\n`-split JSONL loop entirely and forwards stdout chunks directly. Claude's JSONL shape is `{type:'assistant', message:{content:[{type:'text',text}]}}` or `{type:'content_block_delta', delta:{text}}` (`lines 26-33`); Codex shape is `{type:'item.completed', item:{type:'agent_message', text}}` (`line 50`).
- Source: https://code.claude.com/docs/en/cli-reference (covers `--output-format stream-json` and streaming event types)

## child_process `spawn` — stdin vs arg input modes
- What: Some CLIs read the prompt from stdin (Claude, Codex); others require it as a positional argument (Gemini `-p <prompt>`). `spawn` with `stdio: ['pipe','pipe','pipe']` covers both cases.
- Why here: TBD
- Gotcha (from code): Gemini's `inputMode: 'arg'` (`index.mjs:64`) causes the prompt to be appended as `-p <prompt>` in `args` (`line 197`) before `spawn`; the `if (cliTool.inputMode === 'stdin')` guard at `line 204` means `proc.stdin` is never written for Gemini. Writing to a non-stdin process hangs or errors.
- Source: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options

## Subprocess cleanup via `res.on('close')` + SIGTERM
- What: When the SSE client disconnects, Node fires `res.on('close')`; sending SIGTERM there prevents orphaned CLI processes from running indefinitely.
- Why here: TBD
- Gotcha (from code): `index.mjs:282-284` — the guard `if (!proc.killed) proc.kill('SIGTERM')` is required because `proc.on('close')` at `line 252` calls `res.end()` first; if the process already exited normally the `!proc.killed` check prevents sending a signal to a dead PID.
- Source: https://nodejs.org/api/child_process.html#subprocesskillsignal

## JSONL line-buffering over a stream
- What: `stdout` data events don't align with newlines; the code accumulates a `buffer` string, splits on `\n`, keeps the last incomplete fragment, and processes complete lines only.
- Why here: TBD
- Gotcha (from code): `index.mjs:225-228` — `const lines = buffer.split('\n'); buffer = lines.pop() || ''` — `pop()` removes and retains the trailing incomplete fragment (which may be `''` after a terminating newline). Forgetting the `|| ''` can turn `undefined` into the string `"undefined"` corrupting the next JSON parse.
- Source: https://nodejs.org/api/stream.html#readable-streams

## SSE backpressure (absent here — worth knowing)
- What: `res.write()` returns `false` when the internal TCP buffer is full; ignoring it can OOM the server on slow clients. Express does not auto-pause the upstream source.
- Why here: TBD
- Source: https://nodejs.org/en/learn/modules/backpressuring-in-streams (official Node.js learn guide; the old `/en/docs/guides/` URL returns 404)

## `embedSystemPrompt` — per-provider system-prompt injection strategy
- What: CLIs that lack a dedicated system-prompt flag (Codex, Gemini) require prepending the system prompt into the user prompt text; CLIs with a flag (Claude's `--system-prompt`) must not double-inject it.
- Why here: TBD
- Gotcha (from code): `index.mjs:187-189` — the `embedSystemPrompt` flag gates the prepend; `buildArgs` for Claude (`line 19`) already handles `--system-prompt` so `embedSystemPrompt: false` (`line 23`) prevents duplication. Getting this backwards sends the system prompt twice to Claude or not at all to Gemini.
- Source: https://code.claude.com/docs/en/cli-reference (Claude `--system-prompt` flag); https://nodejs.org/api/child_process.html#child_processspawncommand-args-options (arg injection pattern)

## `spawn` error event vs `close` event — failure surface
- What: `proc.on('error')` fires when the binary cannot be found or executed at all; `proc.on('close', code)` fires when it runs and exits. Both must be handled — `error` without a handler throws an uncaught exception that crashes the server.
- Why here: TBD
- Gotcha (from code): `index.mjs:275-280` — the `error` handler writes a JSON error SSE frame and ends the response, preventing a half-open connection; if `close` fires after `error`, `res.end()` has already been called so the second call is a no-op.
- Source: https://nodejs.org/api/child_process.html#event-error

## Express 5 dual-mount routing (`/` and `/api`)
- What: The same `Router` instance is mounted at two prefixes so the server works both standalone and behind a Vite `/api` proxy without code duplication.
- Why here: TBD
- Source: https://expressjs.com/en/5x/api.html#router
