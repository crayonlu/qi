# Third-party notices for Qi workflow

Qi ships selected MIT-licensed reference implementations inside the first-party
`qi-workflow` extension. They are not npm runtime dependencies of those packages.
Only **reachable** implementation modules are retained under `vendor/` (not a source archive).

## License summary

All adopted sources below are MIT. Full license texts are copied beside the
adopted code under `vendor/LICENSE.*.md`.

## Provenance (retained modules)

| Capability | Upstream | Retained vendor areas | Copyright |
|---|---|---|---|
| MCP | `pi-mcp-adapter` | server-manager, lifecycle, config, OAuth, elicitation/sampling handlers, utils | Copyright (c) 2026 Nico Bailon |
| Rewind | `pi-rewind` | `core.ts` checkpoint create/load/restore | Copyright (c) 2026 arpagon |
| Cleanup | `pi-cleanup` | scan helpers in `cleanup.ts` | Copyright (c) 2026 crayonlu |
| Processes | `pi-processes` | ProcessManager + utils/constants | MIT (LICENSE.pi-processes.md) |
| Goal | `pi-goal` | runtime, persistence, prompts, accounting, settings | Copyright (c) 2026 narumiruna |
| Plan | `pi-plan-mode` | completion-tool, state restore, thinking-level settings | Copyright (c) 2026 narumiruna |
| Subagents | `pi-subagents` | execution/runner/transports/stateful tool registration | Copyright (c) 2026 narumiruna |
| Todo | `rpiv-todo` | state reducer/store/task-graph + tool envelope | Copyright (c) 2026 juicesharp |
| Ask | `rpiv-ask-user-question` | validate-questionnaire + row-intent/types | Copyright (c) 2026 juicesharp |
| /btw | `pi-btw` / `rpiv-btw` | implementation not retained as files; Qi branch-clone runtime | juicesharp / narumiruna (LICENSE retained) |

## Intentionally excluded / pruned

- Upstream tests, README/CHANGELOG/docs, demos
- Package UI/panels/overlays replaced by Qi dashboard/footer/overlays
- Standalone extension command registration (Qi owns slash surface)
- Plan-mode tool-policy / bash lockdown
- MCP package panels, ui-server/ui-session, app-bridge, proxy-modes/direct-tools (not wired through Qi MCP manager)
- Subagent package config UI (Qi owns configuration UX)
- Optional peers: `@juicesharp/rpiv-i18n`, `@mcp-ui/ext-apps`, `recheck`

## Runtime dependency rationale

`@modelcontextprotocol/sdk` **1.25.1** and `open` **10.2.0** support the retained MCP client transports and OAuth browser launch. No third-party Pi extension package is installed as a runtime dependency.
