# Third-party notices for Qi workflow

Qi ships selected MIT-licensed reference implementations inside the first-party
`qi-workflow` extension. They are not npm runtime dependencies of those packages.

## License summary

All adopted sources below are MIT. Full license texts are copied beside the
adopted code under `vendor/LICENSE.*.md`.

## Provenance

| Capability | Upstream package | Local research path | Version / commit | Adopted areas | Copyright |
|---|---|---|---|---|---|
| Goal | `@narumitw/pi-goal` | `packages/research/pi-extensions/extensions/pi-goal` | research tree | runtime, queue, persistence, prompts, accounting, commands | Copyright (c) 2026 narumiruna |
| Plan | `@narumitw/pi-plan-mode` | `.../pi-plan-mode` | research tree | completion/question/prompt/state/message-transform/settings | Copyright (c) 2026 narumiruna |
| Subagents | `@narumitw/pi-subagents` | `.../pi-subagents` | research tree | runner, execution, transports, stateful spawn, config UI | Copyright (c) 2026 narumiruna |
| Todo | `rpiv-todo` | `packages/research/rpiv-mono/packages/rpiv-todo` | research tree | state reducer/store/replay/task-graph, tool envelope, overlay | Copyright (c) 2026 juicesharp |
| Structured question | `rpiv-ask-user-question` | `.../rpiv-ask-user-question` | research tree | questionnaire reduce/session, validate, dialog views | Copyright (c) 2026 juicesharp |
| /btw | `rpiv-btw` / `@narumitw/pi-btw` | `.../rpiv-btw`, `.../pi-btw` | research tree | side-turn + overlay UI sources | Copyright (c) 2026 juicesharp / narumiruna |
| Jobs | `pi-processes` | `packages/research/pi-processes` | research tree | ProcessManager, tools/actions, hooks, utils | MIT (see LICENSE.pi-processes.md) |
| MCP | `pi-mcp-adapter` | `packages/research/pi-mcp-adapter` | 2.11.0 research tree | server-manager, lifecycle, OAuth, elicitation/sampling, direct-tools, proxy-modes, panels, ui-session/server, consent, metadata-cache | Copyright (c) 2026 Nico Bailon |
| Rewind | `pi-rewind` | `packages/research/pi-rewind` | 0.5.0 research tree | checkpoint core + restore scopes + UI | Copyright (c) 2026 arpagon |
| Cleanup | `pi-cleanup` | `packages/research/pi-cleanup` | research tree | scan categories + apply gate | Copyright (c) 2026 crayonlu |
| Shared config | `@juicesharp/rpiv-config` | `.../rpiv-config` | research tree | JSON config load helpers used by todo/ask | Copyright (c) 2026 juicesharp |

## Intentionally excluded

- Upstream package **test suites** (Qi adds focused integration tests only)
- `pi-plan-mode` bash command classification and `setActiveTools` lockdown
- Generic permission / approval / sandbox / vault frameworks
- User-local `~/.pi/agent` prompts, skills, MCP configs, model preferences, agent templates as bundled defaults
- nicobailon `pi-subagents` fleet/watchdog/intercom second runtime
- Optional npm peers not shipped: `@juicesharp/rpiv-i18n`, `@mcp-ui/ext-apps`, `recheck` (stubs: English fallback / no-op UI app-bridge)
- Standalone package `index.ts` CLI/bin entrypoints — Qi registers one built-in extension and thin adapters instead

## Runtime dependency rationale

`@modelcontextprotocol/sdk` **1.25.1** is added to `@earendil-works/pi-coding-agent`
because the adopted MCP server manager uses the SDK client transports
(stdio, Streamable HTTP, SSE) and OAuth helpers.

`open` **10.2.0** is added for MCP OAuth browser launch during interactive auth
flows. No third-party Pi extension package is installed as a runtime dependency.
