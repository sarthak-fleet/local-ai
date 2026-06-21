# local-ai — PROJECT STATUS

Last updated: 2026-06-20

## Why/What

**Out-of-fleet sandbox** — not part of the fleet product surface or fleet-wide sweeps (per fleet `AGENTS.md`). local-ai is a lightweight local helper server that wraps already-authenticated CLI tools (Claude Code, Codex, Gemini CLI) behind a small HTTP/SSE API so local apps can stream model responses without managing provider API keys.

Intentionally local-only: no hosted multi-tenant service, no user accounts, no billing, no remote persistence.

## Dependencies

| Layer | Choice |
|-------|--------|
| Runtime | Node.js (ESM) |
| Server | Express-style HTTP in `index.mjs` (`createServer`) |
| Providers | Claude, Codex, Gemini via `CLI_TOOLS` registry |
| Transport | Server-Sent Events (SSE) streaming |
| Default port | `3456` (`PORT` env override) |

**Quick start:** `npm install && npm start` → http://localhost:3456

**Routes (dual aliases):**
- `POST /chat` and `POST /api/chat` — stream conversation
- `GET /health` and `GET /api/health` — provider list + status

**Consumer integration:**
- Direct `fetch` from frontend
- Vite dev proxy: `server.proxy['/api'] → http://localhost:3456`
- Git submodule: `git submodule add … server` (used by `swe-interview-prep`)

```
HTTP POST /chat { provider, model, messages, systemPrompt }
        │
        ▼
CLI_TOOLS registry (claude | codex | gemini)
        │
        ├── buildArgs(model, systemPrompt)
        ├── inputMode: stdin | arg
        ├── embedSystemPrompt: true|false
        └── parseStream: JSON line parser | null (plain text)
        │
        ▼
spawn(child_process) ──► SSE stream to client
        data: {"text":"..."}
        data: [DONE]
```

**Message normalization:** `content` accepts string or array of `{type: text|image}` parts. Image parts forwarded only to providers that support headless image input (today: `codex` via `-i FILE`; `claude` and `gemini` drop images, use text only).

**Provider streaming modes:**
| Provider | Streaming | System prompt |
|----------|-------------|---------------|
| claude | JSON (`stream-json`) | `--system-prompt` flag |
| codex | JSON (`exec --json`) | embedded in prompt text |
| gemini | plain text | embedded in prompt text |

**Extensibility:** add new provider by appending entry to `CLI_TOOLS` in `index.mjs` with `command`, `buildArgs`, `inputMode`, `embedSystemPrompt`, `parseStream`.

| Concern | Detail |
|---------|--------|
| Prerequisites | User must have claude/codex/gemini CLIs installed and already authenticated |
| Start | `npm start` from repo root |
| Port | `PORT=3456` default; change if collision with other local services |
| Submodule | `git submodule update --init` in consumer repos; `cd server && npm install` |
| Security | Bind to localhost only in dev; do not deploy this server to public internet as-is |
| Out-of-fleet | Exclude from fleet-wide audits, perf sweeps, and standardization passes |
| License | MIT — safe to submodule into fleet dev projects |

## Timeline

| Phase | Milestone |
|-------|-----------|
| Core server | HTTP/SSE chat endpoint, dual route aliases, provider spawn + stream handling |
| Provider adapters | Claude (stream-json), Codex (exec --json + image paths), Gemini (plain text) |
| Message handling | Multipart content normalization, system prompt embedding vs flag injection |
| Documentation | README API schema, Vite proxy pattern, submodule setup |
| Fleet usage (informal) | swe-interview-prep documents local-ai on `:3456` as dev AI bridge |
| Learning track | `docs/learning/new-things.md` stub for CLI bridging and SSE topics |

## Products

| Surface | Role |
|---------|------|
| Chat API | `POST /chat` or `/api/chat` — SSE streaming from CLI providers |
| Health API | `GET /health` or `/api/health` — provider list + status |
| Dev bridge | Zero-key local development for fleet apps (primarily swe-interview-prep) |

## Features (shipped)

### Core server
- Express-compatible HTTP server exposing chat and health endpoints at both `/chat` and `/api/chat` (and `/health` / `/api/health`) for proxy-friendly routing.
- POST `/chat` accepts `provider`/`tool`, optional `model`, `messages[]`, optional `systemPrompt`.
- Server-Sent Events response stream with incremental `{"text":"..."}` chunks and `[DONE]` terminator.
- Graceful provider spawn error handling; stdin/arg input modes per provider.
- `PORT` environment variable (default 3456).

### Provider adapters
- **Claude:** `claude -p --output-format stream-json --verbose`; optional `--model`, `--system-prompt`; parses assistant and content_block_delta events.
- **Codex:** `codex exec --json`; embeds system prompt in conversation; supports image paths via `-i FILE` appendArgs hook.
- **Gemini:** plain-text stdout mode; embeds system prompt; no image forwarding.

### Message and content handling
- `normalizeContent()` unifies string and multipart content arrays.
- Image path extraction for codex multimodal input.
- System prompt embedding vs flag-based injection per provider contract.

### Documentation
- README: quick start, API schema, provider notes, submodule setup, Vite proxy example, frontend fetch snippet.
- `docs/learning/new-things.md` stub for fancy-tech learning track (CLI bridging, SSE streaming topics).
- MIT license.

### Fleet usage (informal)
- `swe-interview-prep` documents local-ai on `:3456` as dev AI bridge (submodule at `server/`).
- Vite proxy pattern documented for zero-key local development.

## Todo / Planned / Deferred / Blocked

### Planned
1. **API stability** — keep surface small and backward-compatible for fleet tools that depend on the zero-key bridge; avoid breaking `/chat` schema without version bump.
2. **Provider health detail** — add per-provider reachability checks to `/health` only when callers need better routing or debugging (today: list only).
3. **Fleet dependency map** — document which fleet projects import or submodule local-ai so changes do not break hidden integrations (swe-interview-prep confirmed; audit others on touch).
4. **Packaging decision** — decide whether local-ai remains a standalone helper repo or becomes a reusable Foundry helper package (no migration until a consumer asks).

### Deferred
- Hosted multi-tenant service behavior — intentionally local only.
- Paid provider orchestration — deferred to `free-ai` or provider-specific clients.
- User accounts, billing, API keys management, and remote persistence.
- Auth middleware on `/chat` — acceptable for localhost dev; consumers must not expose port publicly without a gateway.
- Additional providers beyond claude/codex/gemini unless a fleet project requests one.

### Blocked / Known gaps
- No authentication on endpoints — safe only on localhost; exposing `:3456` publicly would allow unauthenticated CLI invocation.
- Provider failures surface as stream errors — no structured error codes for clients yet.
- Image input asymmetry across providers is undocumented at runtime (clients must know codex-only image support).
- Fleet dependency list is incomplete — only swe-interview-prep formally documented; other repos may proxy informally.
- `server/` submodule in swe-interview-prep may carry local `node_modules` — verify not tracked (low-severity audit item in consumer repo).
