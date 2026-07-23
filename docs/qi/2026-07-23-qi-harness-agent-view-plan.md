# Qi Harness + Push Completions + Transcript Agent View

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship full-quality harness UX (A), Claude-style push completions (B), and transcript-replacing Agent View (C) with **no half-measures**.

**Issue:** https://github.com/crayonlu/qi/issues/14

**Architecture:**
- A = render/copy/lifecycle polish in `qi-workflow` UI + vendor tools (Markdown, todo subjects, goal wrap-up, subagent cards).
- B = flip completion delivery to `followUp` + `triggerTurn: true` (idempotent queue); demote `subagent_wait` to optional sync; rewrite prompts.
- C = add `viewingAgentId` view-mode that swaps the **main chat message source** (patch interactive-mode if needed); `/agents` becomes roster → Enter focuses transcript.

**Tech Stack:** Qi coding-agent extensions, `@earendil-works/pi-tui` (Text/Markdown/Container), Pi ExtensionAPI (`sendMessage`, `sendUserMessage`, session hooks), reference `ref/claude-code`.

## Global Constraints

- **No weakenings:** overlay-only Agent View is not acceptable as end state; wait-polling is not the primary coordination model.
- **No silent goal end:** `goal_complete` must yield a user-visible assistant wrap-up.
- **Markdown default** for model natural language in tool/result bodies; chrome stays plain.
- **Idempotent push:** one completion → at most one wake.
- **Tests:** every task ships focused `bun test` coverage under `packages/coding-agent/test/qi-workflow/` (and interactive-mode tests for C).
- **Reference:** `ref/claude-code` (`enqueueTaskNotification`, `viewingAgentTaskId`, teammate navigation) — behavior parity, not copy-paste license issues; keep Qi copyright headers.
- Fold existing WIP on panel surfaces / spinner / tree / footer colors into early tasks (already partially on `fix/overlay-input-gap`).

## File map

| Area | Primary files |
|------|----------------|
| Subagent render | `vendor/subagents/render.ts`, `subagents.ts`, `stateful.ts` |
| Todo copy | `vendor/todo/tool/response-envelope.ts` (+ tests) |
| Goal wrap-up | `runtime/goal-lifecycle.ts`, `vendor/goal/*`, prompts |
| Push completions | `vendor/subagents/stateful.ts` (`sendDetachedCompletion`), orchestration, prompts |
| Agent view / transcript | `ui/agent-view.ts`, new `ui/transcript-focus.ts`, `interactive-mode.ts` / extension UI hooks |
| Panel chrome (WIP) | `ui/layout.ts`, `ui/chrome.ts`, `ui/footer.ts`, `ui/work-board.ts` |

---

### Task 1: Land panel/surface + spinner/tree/footer polish (WIP baseline)

**Files:**
- Modify: `ui/layout.ts`, `ui/chrome.ts`, `ui/footer.ts`, `ui/work-board.ts`, `ui/status-color.ts`, `ui/agent-view.ts`, panel callers, `vendor/subagents/render.ts`, `vendor/subagents/subagents.ts`
- Test: `test/qi-workflow/panel-surface.test.ts`, `test/qi-workflow/tui.test.ts`, `packages/tui/test/overlay-input-chrome.test.ts`

**Produces:** Stable UI baseline (input chrome, animated spinner, tree rails, colored footer/board).

- [ ] **Step 1:** Ensure WIP compiles; run `bun test test/qi-workflow/panel-surface.test.ts test/qi-workflow/tui.test.ts test/qi-workflow/ui-parity.test.ts`
- [ ] **Step 2:** Fix any failures from footer theme resolve / status color expectations
- [ ] **Step 3:** Commit on branch `feat/qi-harness-agent-view` (or continue from overlay branch then rename)

---

### Task 2: Todo mutation copy includes subject

**Files:**
- Modify: `vendor/todo/tool/response-envelope.ts`
- Test: `test/qi-workflow/` (add `todo-envelope.test.ts` or extend existing)

**Produces:** `Updated #4 «Research …» (in_progress → completed)` (and create/delete already have subjects).

- [ ] **Step 1:** Write failing test: update op with subject → content includes subject
- [ ] **Step 2:** Change `formatContent` `update` branch to include `op.subject` or lookup from `state.tasks`
- [ ] **Step 3:** Pass tests; commit

---

### Task 3: Subagent card hierarchy + Markdown bodies (Phase A render)

**Files:**
- Modify: `vendor/subagents/render.ts`
- Test: add `test/qi-workflow/subagent-render.test.ts` (pure string/structure asserts where possible)

**Produces:**
- Collapsed parallel/chain: header + one line per agent (status icon + name + short preview), not full dump
- Expanded / final prose: `Markdown` component
- Tree rails already from Task 1

- [ ] **Step 1:** Snapshot/fixture test for collapsed parallel layout shape (header + N agent lines + optional fan-in + Done stats)
- [ ] **Step 2:** Refactor collapsed render paths to truncate previews to ~1 line; move long reports behind expand
- [ ] **Step 3:** Use `Markdown` for finalOutput / agent prose blocks
- [ ] **Step 4:** Pass tests; commit

---

### Task 4: Goal complete → user-visible wrap-up (Phase A)

**Files:**
- Modify: `runtime/goal-lifecycle.ts`, goal prompts, possibly `vendor/goal/runtime.ts`
- Test: goal lifecycle / domain tests

**Produces:** After successful `goal_complete`, session always gets an assistant-facing wrap-up (steer/followUp with `triggerTurn: true` **or** tool result that forces continued turn with summary instruction — prefer inject followUp summarizing evidence so UI shows a reply).

- [ ] **Step 1:** Reproduce current behavior in test (tool ends turn with no assistant text)
- [ ] **Step 2:** On `goal_complete` success, enqueue wrap-up: `sendUserMessage`/`sendMessage` with instruction to emit a short user-facing completion summary **or** append a synthetic assistant message if ExtensionAPI allows
- [ ] **Step 3:** Prompt: “calling goal_complete is not the end of the user conversation — always leave a visible summary”
- [ ] **Step 4:** Pass tests; commit

---

### Task 5: Markdown default for AI tool prose (Phase A sweep)

**Files:**
- Modify: tool `renderResult` paths under `qi-workflow/tools/register.ts`, ask/btw already Markdown; stateful spawn results; goal/plan tools where text is prose
- Test: smoke asserts Markdown used (or render output contains markdown-ish structure)

**Produces:** Consistent rule: prose → Markdown; ids/status chrome → Text.

- [ ] **Step 1:** Inventory renderResult returning plain Text for multi-line prose
- [ ] **Step 2:** Switch those to Markdown
- [ ] **Step 3:** Commit

---

### Task 6: Push completion wake (Phase B core)

**Files:**
- Modify: `vendor/subagents/stateful.ts` (`sendDetachedCompletion`), orchestration helpers
- Test: unit test around completion delivery options + idempotency set

**Produces:**
```ts
pi.sendMessage(payload, { deliverAs: "followUp", triggerTurn: true });
```
(or documented equivalent). Track `seenCompletionKeys` so re-delivery does not double-wake.

- [ ] **Step 1:** Failing test: completion delivery requests `triggerTurn: true` / followUp
- [ ] **Step 2:** Change `sendDetachedCompletion`; add idempotency key `agentId:turnId|endedAt`
- [ ] **Step 3:** If main turn active, queue until idle (use existing orchestration / `hasPendingRootMessages` patterns)
- [ ] **Step 4:** Pass tests; commit

---

### Task 7: Demote wait/messages polling in prompts + tool docs (Phase B)

**Files:**
- Modify: `vendor/subagents/subagents.ts`, `stateful.ts` tool descriptions, `orchestration.ts` copy, prompts
- Test: prompt/string fixtures if any

**Produces:** Primary path = spawn → work → push wake. `subagent_wait` = optional short sync (document timeout semantics). Empty `subagent_messages` is not success coordination.

- [ ] **Step 1:** Rewrite descriptions/guidelines
- [ ] **Step 2:** Commit

---

### Task 8: Transcript focus state machine (Phase C foundation)

**Files:**
- Create: `ui/transcript-focus.ts` (`viewingAgentId`, enter/exit helpers, subscribers)
- Modify: `vendor/subagents/agent-bridge.ts` as needed for message snapshots
- Test: `test/qi-workflow/transcript-focus.test.ts`

**Produces:** Pure state API mirroring Claude `viewingAgentTaskId` / `enterTeammateView` / `exitTeammateView`.

- [ ] **Step 1:** Tests for enter/exit/idempotent exit
- [ ] **Step 2:** Implement module
- [ ] **Step 3:** Commit

---

### Task 9: Interactive-mode message source swap (Phase C — no weakening)

**Files:**
- Modify: `modes/interactive/interactive-mode.ts` (and/or extension UI context) to support alternate message source when `viewingAgentId` set
- Possibly: extension hook / `ExtensionUIContext` method `setTranscriptSource`
- Test: interactive-mode / extension tests

**Produces:** Same Messages column renders subagent history when focused. **If API missing, add it in Qi fork — do not ship overlay-only.**

- [ ] **Step 1:** Spike: locate where chat children are built from session messages
- [ ] **Step 2:** Add `transcriptSource: "main" | { agentId }` plumbing
- [ ] **Step 3:** When source is agent, render from bridge/registry history (bootstrap from disk/session if needed)
- [ ] **Step 4:** Input routing: submissions go to viewed agent followUp when not main
- [ ] **Step 5:** Esc / exit restores main
- [ ] **Step 6:** Tests; commit

---

### Task 10: Wire `/agents` roster → focus transcript (Phase C UX)

**Files:**
- Modify: `ui/agent-view.ts`, commands register, footer/board focus chips
- Test: UI tests / integration smoke

**Produces:** Enter on roster row → `enterTranscriptFocus(id)` + close overlay; footer shows `@main`/`@agent`; Shift+↑↓ optional follow-up if time.

- [ ] **Step 1:** Enter focuses transcript (closes overlay)
- [ ] **Step 2:** Status/footer chip for current focus
- [ ] **Step 3:** Commit

---

### Task 11: End-to-end verification + release notes

**Files:**
- Test: full `bun test test/qi-workflow/`
- Manual checklist in issue #14

- [ ] **Step 1:** Run full qi-workflow tests + focused interactive tests
- [ ] **Step 2:** Manual: parallel subagent, goal_complete wrap-up, todo update copy, completion wake without wait, `/agents` Enter swaps chat
- [ ] **Step 3:** Open PR linking #14; no “temporary overlay fallback” language in PR body

---

## Execution order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11

Do not skip Task 9 for an overlay-only “done”. Do not leave Task 6 as `triggerTurn: false`.

## Out of scope (explicit)

- Claude `/agents` config wizard (agent definition CRUD)
- Multi-terminal session grid / tmux
- Changing upstream Pi publish cadence beyond Qi fork patches needed for Task 9
