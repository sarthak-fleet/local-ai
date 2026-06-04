# Project Status

Last updated: 2026-06-04

## Current Scope

local-ai is a lightweight local helper server for AI tools. It wraps already-authenticated CLI tools such as Claude Code, Codex, and Gemini CLI behind a small HTTP/SSE API so local apps can stream model responses without managing provider API keys.

## Done

- Express server exposes `/chat`, `/api/chat`, `/health`, and `/api/health`.
- Claude, Codex, and Gemini CLI providers are supported through configurable command adapters.
- Responses stream back to callers through Server-Sent Events.
- System prompts and message arrays are normalized across providers.
- README documents direct frontend use, Vite proxy setup, and submodule usage.

## Planned Next

1. Keep the API small and stable for local fleet tools that need a zero-key AI bridge.
2. Add provider health detail only when callers need better routing or debugging.
3. Document which fleet projects depend on local-ai so changes do not break hidden integrations.
4. Decide whether local-ai remains a standalone helper repo or becomes a reusable Foundry helper package.

## Deferred / Parked

- Hosted multi-tenant service behavior is deferred; this is intentionally local.
- Paid provider orchestration is deferred to free-ai or provider-specific clients.
- User accounts, billing, and remote persistence are out of scope.
