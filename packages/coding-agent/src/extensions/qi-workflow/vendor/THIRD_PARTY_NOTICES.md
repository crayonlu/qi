# Third-party notices for Qi workflow

Qi ships selected MIT-licensed reference implementations inside the first-party
`qi-workflow` extension. They are not npm runtime dependencies of those packages.

## License summary

All adopted sources below are MIT. Full license texts are copied beside the
adopted code under `vendor/LICENSE.*.md`.

## Provenance

| Capability | Upstream package | Local research path | Version / commit | Adopted areas | Copyright |
|---|---|---|---|---|---|
| Goal | `@narumitw/pi-goal` | `packages/research/pi-extensions/extensions/pi-goal` | package.json version in research tree | prompts, ownership/continuation patterns, tool validation | Copyright (c) 2026 narumiruna |
| Plan | `@narumitw/pi-plan-mode` | `.../pi-plan-mode` | research tree | completion/question/prompt/state patterns (not tool-policy) | Copyright (c) 2026 narumiruna |
| Task / Workflow | `@narumitw/pi-subagents` | `.../pi-subagents` | research tree | concurrency runner, in-process child session, limits | Copyright (c) 2026 narumiruna |
| Todo | `rpiv-todo` | `packages/research/rpiv-mono/packages/rpiv-todo` | research tree | task graph / replay / overlay ideas | Copyright (c) 2026 juicesharp |
| Structured question | `rpiv-ask-user-question` | `.../rpiv-ask-user-question` | research tree | questionnaire state + dialog | Copyright (c) 2026 juicesharp |
| /btw | `rpiv-btw` / `@narumitw/pi-btw` | `.../rpiv-btw`, `.../pi-btw` | research tree | side-turn context clone UI | Copyright (c) 2026 juicesharp / narumiruna |
| Jobs | `pi-processes` | `packages/research/pi-processes` | research tree | ProcessManager + utils | MIT (see LICENSE.pi-processes.md) |
| MCP | `pi-mcp-adapter` | `packages/research/pi-mcp-adapter` | 2.11.0 research tree | server manager, HTTP/SSE, OAuth, lifecycle, panel, proxy | Copyright (c) 2026 Nico Bailon |
| Rewind | `pi-rewind` | `packages/research/pi-rewind` | 0.5.0 research tree | checkpoint core + restore scopes | Copyright (c) 2026 arpagon |
| Cleanup | `pi-cleanup` | `packages/research/pi-cleanup` | research tree | scan categories + apply gate | Copyright (c) 2026 crayonlu |

## Intentionally excluded

- `pi-plan-mode` bash command classification and `setActiveTools` lockdown
- Generic permission / approval / sandbox frameworks
- User-local `~/.pi/agent` prompts, skills, MCP configs, model preferences, agent templates as bundled defaults
- nicobailon `pi-subagents` fleet/watchdog/intercom second runtime
- Full MCP adapter UI stream / elicitation browser server / metadata-cache package extras (Qi uses server-manager + lifecycle + OAuth + proxy tool call path)
- Standalone extension entrypoints (`index.ts` registerCommand wrappers) — Qi wires through first-party commands/tools instead

## Runtime dependency rationale

`@modelcontextprotocol/sdk` **1.25.1** is added to `@earendil-works/pi-coding-agent`
because the adopted MCP server manager uses the SDK client transports
(stdio, Streamable HTTP, SSE) and OAuth helpers. A minimal hand-rolled subset
would reimplement protocol negotiation and auth poorly; the pinned SDK is the
supported client surface from `pi-mcp-adapter` 2.11.0.

`open` **10.2.0** is added for MCP OAuth browser launch during interactive auth
flows (`mcp-auth-flow` / elicitation URL open). No third-party Pi extension
package is installed as a runtime dependency.
