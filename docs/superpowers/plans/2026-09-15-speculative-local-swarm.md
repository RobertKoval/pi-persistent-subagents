# Speculative Local Swarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an asynchronous, isolated, execution-verified local coding swarm beneath the always-present frontier Pi agent.

**Architecture:** Keep the existing persistent-worker extension unchanged and add a second package extension entry point. The new extension owns a `SwarmManager` that composes the existing `WorkerPool` with Git snapshot/worktree isolation, bounded scheduling, runtime verification, compact collection, cancellation and safe apply.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Pi 0.85.x extension API, existing `WorkerPool`, Git CLI, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-15-speculative-local-swarm-design.md`

## Global Constraints

- Frontier model always remains the parent/user-facing Pi agent.
- Public repository: never commit runtime prompts, source snapshots, credentials, environment contents or private filesystem data.
- Existing six persistent-worker tools must remain backward compatible.
- Offline tests must make no model calls.
- Candidate completion must not independently wake the frontier.
- No production code without a failing test first.

---

### Task 1: Git snapshot/worktree primitives

**Files:**
- Create: `src/swarm-git.ts`
- Test: `test/swarm-git.test.ts`

**Interfaces:**
- Produces `createWorkspaceSnapshot(cwd, storageRoot)`, `createCandidateWorktree(snapshot, candidateId)`, `captureCandidate(snapshot, worktree)`, `removeCandidateWorktree(snapshot, worktree)`, and `applyCandidatePatch(parentCwd, patchPath)`.

- [ ] Write tests proving dirty tracked/staged/untracked files are captured without modifying parent HEAD/index/worktree.
- [ ] Run the new test and verify RED because `src/swarm-git.ts` does not exist.
- [ ] Implement synthetic-index snapshot creation with fixed local author metadata and detached worktrees.
- [ ] Add patch capture and cleanup.
- [ ] Add safe patch applicability/apply behavior.
- [ ] Run `npm test -- test/swarm-git.test.ts` and verify GREEN.

### Task 2: Swarm scheduling and evidence model

**Files:**
- Create: `src/swarm-types.ts`
- Create: `src/swarm-manager.ts`
- Test: `test/swarm-manager.test.ts`

**Interfaces:**
- Consumes existing `WorkerPool` lifecycle APIs.
- Produces `SwarmManager.start/status/collect/cancel/apply/cleanup` and compact job/candidate snapshots.

- [ ] Write a fake `WorkerPool`-backed behavioral test for asynchronous start, `maxActive`, queue draining, candidate settlement, verified early stop, compact collection and cancellation.
- [ ] Verify RED because manager/types do not exist.
- [ ] Implement immutable job/candidate state types and strategy generation.
- [ ] Implement scheduler with separate `maxCandidates` and `maxActive`.
- [ ] On worker settle, capture runtime diff, run acceptance commands, rank evidence, close worker/worktree and schedule/cancel as appropriate.
- [ ] Ensure `start()` resolves after workers are launched/queued rather than after completion.
- [ ] Run focused tests and verify GREEN.

### Task 3: Pi extension surface

**Files:**
- Create: `src/swarm-extension.ts`
- Modify: `package.json`
- Test: `test/swarm-extension-contract.test.ts`

**Interfaces:**
- Produces one LLM-facing tool `swarm` with actions `start|status|collect|cancel|apply` and command `/pswarms`.

- [ ] Write extension contract tests with a fake Pi API and verify RED.
- [ ] Register the second extension entry in `package.json`.
- [ ] Build a session-scoped `WorkerPool` for swarm candidates using the same model/provider selection logic and account-selection seeding as existing workers.
- [ ] Suppress registration at child depth so leaf workers cannot recursively spawn swarms.
- [ ] Keep worker settlement internal; expose only job-level tool responses.
- [ ] Add session-shutdown cleanup.
- [ ] Run focused extension tests and verify GREEN.

### Task 4: Public documentation and handoff

**Files:**
- Modify: `README.md`
- Create: `docs/swarm.md`
- Modify: `docs/configuration.md` only if configuration surface changes.

- [ ] Document the frontier-always-present mental model, tool examples, Git requirements, isolation/security boundary and known V1 limitations.
- [ ] Explicitly document that worktrees isolate repository state but are not security sandboxes.
- [ ] Document current lack of canonical prompt-root/cross-testing/PDR as measured follow-up work, not hidden TODOs.

### Task 5: Verification

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run test:e2e` if the existing no-model-call E2E is available in CI.
- [ ] Inspect CI on `feat/speculative-local-swarm` and fix all regressions.
- [ ] Compare branch against `main` and review for accidental public/private data exposure.
