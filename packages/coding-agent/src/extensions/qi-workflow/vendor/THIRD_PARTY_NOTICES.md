# Third-party notices for Qi workflow

Qi ships selected MIT-licensed reference implementations inside the first-party
`qi-workflow` extension. They are not npm runtime dependencies of those packages.
Only **reachable** implementation modules are retained under `vendor/` (not a source archive).

## License summary

All adopted sources below are MIT. Full license texts are copied beside the
adopted code under `vendor/LICENSE.*.md`.

## Provenance (retained modules)

| Capability | Upstream | Retained vendor / runtime | Copyright |
|---|---|---|---|
| MCP | `pi-mcp-adapter` | server-manager, lifecycle, config, OAuth, sampling/elicitation; Qi proxy tool + MCP panel | Copyright (c) 2026 Nico Bailon |
| Rewind | `pi-rewind` | core + `runtime/auto-rewind.ts` + rewind panel | Copyright (c) 2026 arpagon |
| Cleanup | `pi-cleanup` | scan helpers; Qi dry-run/apply + cleanup panel | Copyright (c) 2026 crayonlu |
| Processes | `pi-processes` | ProcessManager (start/list/output/logs/kill/write/clear) | MIT |
| Goal | `pi-goal` | GoalRuntime + accounting/persistence/prompts/settings/queue/commands | Copyright (c) 2026 narumiruna |
| Plan | `pi-plan-mode` | completion-tool + thinking-level settings loader | Copyright (c) 2026 narumiruna |
| Subagents | `pi-subagents` | execution/runner/transports/stateful registration | Copyright (c) 2026 narumiruna |
| Todo | `rpiv-todo` | reducer/store/task-graph/replay + tool envelope | Copyright (c) 2026 juicesharp |
| Ask | `rpiv-ask-user-question` | validate-questionnaire, types, format-answer, response-envelope, reconciler | Copyright (c) 2026 juicesharp |
| /btw | `rpiv-btw` | `runtime/btw-side-turn.ts` mature runtime; Qi owns overlay | Copyright (c) 2026 juicesharp |

## Intentionally excluded (product boundary)

### Non-UI
- Upstream tests, README/CHANGELOG/docs, demos
- Standalone package entrypoints as separate extensions
- **Plan tool-policy / bash lockdown** — soft plan prompt discipline only
- **Plan message-transform / proposed-plan protocol** — Qi structured plan + `plan_update` / `plan_mode_complete`
- **Plan `plan_mode_question` tool** — Qi uses `ask_user_question`
- **Plan `--plan` CLI flag** — replaced by `/plan <goal>`
- **Plan `defaultPlanTools` / `safeSubcommands` settings** — excluded with tool-policy lockdown
- **Goal cross-extension RPC** — Qi owns `/goal` + tools
- **MCP proxy describe/search, direct-tools, consent, metadata-cache, split auth-start/complete, logout** — Qi MCP manager + panel/auth/proxy call/resources
- **Process agent-turn alerts / logWatches** — poll/`wait` + dashboard
- Optional peers: `@juicesharp/rpiv-i18n`, `@mcp-ui/ext-apps`, `recheck`

### UI (Qi owns unified surfaces)
- **Package-local panels/overlays copied wholesale** — Qi uses one dashboard, one slash browser, one footer key (`qi`), one center-panel style (MCP/rewind/cleanup/dashboard), one bottom-overlay style (ask/btw)
- **Todo aboveEditor tree overlay / config collapse shortcut / completed-linger** — Qi board shows activeForm/blockedBy chips + `/todos` dashboard detail; collapse via `/board`
- **Ask multi-tab dialog, submit-picker review, side-by-side preview panes, RPC/ACP dialog-walker, ASK_USER_PROMPT_EVENT, package config guidance** — Qi sequential overlay with preview-on-focus, notes (`n`), progress `(i/n)`, collapse (`c`); headless strips tool
- **Plan package tool-selector UI / widgets / statusline-only chrome** — Qi board shows draft/ready/executing; `/plan finalize|ready` + ready menu; thinking-level via settings (not a separate panel)
- **Rewind Esc+Esc shortcut / dedicated statusline glyph** — Qi `/rewind` panel with preview/undo; fork/tree prompts when `hasUI`
- **MCP setup wizard, browser ui-server/app-bridge/glimpse, per-tool direct-toggle editor** — Qi `/mcp` panel with filter/auth/enable/disable/reconnect/inspect + empty config hints
- **Process `/ps` log dock / pin / live stream widget** — Qi `/jobs` dashboard: logs/cancel/clear-finished; agent uses `process` tool for stdin/wait
- **Subagent fleet overlay / Ctrl+Alt+F / watchdog slash surface** — Qi Task/Workflow dashboard + `subagent` tools
- **rpiv-btw banner/theme files** — Qi `/btw` bottom overlay with live pending + Esc abort

## Runtime dependency rationale

`@modelcontextprotocol/sdk` **1.25.1** and `open` **10.2.0** support the retained MCP client transports and OAuth browser launch. No third-party Pi extension package is installed as a runtime dependency.
