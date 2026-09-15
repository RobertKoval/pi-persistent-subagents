# Speculative local swarm — implementation handoff

Branch: `feat/speculative-local-swarm`

This document is the implementation handoff for continuing the local coding-swarm work without repeating the original research or architecture exploration.

## Product invariant

The frontier model always remains the main, user-facing Pi agent and orchestrator.

The swarm is subordinate speculative compute. Its purpose is to move parallelizable repository exploration, patch search and executable verification onto cheap/local models while keeping the frontier context small and preserving frontier capacity for planning, synthesis and final judgment.

Do not redesign this into a local-first gateway or peer-to-peer multi-agent chat system unless the product requirement explicitly changes.

## What is implemented

### Pi surface

A second extension entry point, `src/swarm-extension.ts`, is loaded by the package alongside the existing persistent-worker extension.

It registers exactly one root-level LLM-facing tool:

```text
swarm(action = start | status | collect | cancel | apply)
```

and one human command:

```text
/pswarms
```

The swarm extension is not exposed at child depth, so local candidates cannot recursively create swarms.

`swarm start` refuses to silently use the frontier/default model. A `roles.local-swarm` profile or explicit model selection is required.

### Async orchestration

`src/swarm-manager.ts` implements:

- asynchronous `start()` — snapshot/model work continues after the tool result returns;
- separate logical width (`maxCandidates`) and active concurrency (`maxActive`);
- diversified candidate search strategies;
- queue backfill when candidates finish, crash or time out;
- early stop after `minCompleted` plus a verified result;
- cancellation of queued/running stragglers;
- compact collection, default top-1;
- explicit apply only for verified/partial candidates;
- fast-settlement recovery when a worker settles before `spawnAgent()` returns;
- crash recovery from `WorkerPool.onUpdate(... crashed ...)` even though no `agent_settled` is emitted;
- per-candidate task-level wall-clock timeout, default 300000 ms, configurable as `candidate_timeout_ms`;
- cleanup on session shutdown.

### Git state isolation

`src/swarm-git.ts` implements an immutable delegated snapshot using a temporary Git index:

```text
HEAD
+ staged changes
+ unstaged tracked changes
+ untracked non-ignored files
= synthetic snapshot commit
```

Creating the snapshot does not change the user's branch, HEAD, index or working tree.

Each candidate receives a detached Git worktree from that snapshot. The runtime captures candidate changes itself using a second temporary index and a binary Git diff; the model does not need to commit and model claims about changed files are not trusted.

`swarm apply` performs `git apply --check --binary` against the current parent workspace before applying. Parent drift/conflicts therefore fail without overwriting current work.

### Verification and ranking

Configured `acceptance_commands` run independently after candidate settlement.

Evidence semantics:

- `verified`: candidate changed the repository and every configured acceptance command exited 0;
- `partial`: candidate changed the repository but there is not enough hard verification evidence;
- `rejected`: no useful diff, verification/capture failed, worker crashed, or candidate timed out.

Ranking is deliberately simple in V1:

1. verified;
2. partial;
3. rejected;
4. fewer failed verification commands;
5. fewer changed files;
6. stable candidate id tie-break.

`collect` exposes only command/pass/exit-code verification information. Captured verifier stdout/stderr remains internal so it does not inflate frontier context.

### Metrics

Swarm workers are connected to the existing `MetricsAdapter` and shared `persistent-subagents/metrics.sqlite` store.

Existing worker telemetry therefore includes swarm worker provider/model attribution, token/cache usage, timings and concurrency when `metricsWorkers` is enabled.

First-class historical swarm dimensions such as `job_id`, candidate strategy, early-stop reason and apply outcome are not yet in the metrics schema.

### Offline end-to-end test

`test/swarm-extension-contract.test.ts` exercises the full path without a provider call:

```text
frontier tool call
→ synthetic dirty-repo snapshot
→ fake local Pi worker
→ isolated worktree edit
→ runtime acceptance verifier
→ compact collect
→ explicit apply
→ shared metrics database
```

The parent repository is asserted unchanged before explicit apply.

`test/fakes/fake-pi-rpc.mjs` has test-only support for an isolated file-write directive and realistic provider/model/API attribution for metrics tests.

## Important files

```text
src/swarm-extension.ts
src/swarm-manager.ts
src/swarm-git.ts

test/swarm-extension-contract.test.ts
test/swarm-manager.test.ts
test/swarm-git.test.ts

docs/swarm.md
docs/superpowers/specs/2026-09-15-speculative-local-swarm-design.md
docs/superpowers/plans/2026-09-15-speculative-local-swarm.md
```

The existing `src/pool.ts` was intentionally not turned into a swarm scheduler. `SwarmManager` composes `WorkerPool` instead, preserving persistent-worker semantics.

## Verified invariants

Tests cover:

- dirty tracked/staged/untracked parent state is snapshotted without parent mutation;
- candidate worktrees are isolated;
- uncommitted and untracked candidate edits are captured in the patch artifact;
- clean apply succeeds and conflicting parent drift is rejected;
- `start()` returns before snapshot preparation completes;
- active concurrency never needs to equal logical candidate width;
- a settled slot is backfilled from the queue;
- verified early stop cancels queued/running stragglers;
- a completion that arrives before `spawnAgent()` returns is recovered;
- a crashed child frees its slot and is recorded as rejected;
- a stuck child is closed after its candidate wall budget;
- no acceptance commands means no false `verified` claim;
- verifier stdout/stderr is excluded from `collect`;
- rejected candidates cannot be applied;
- explicit cancel closes active workers;
- child workers do not expose recursive swarm tools;
- offline full extension path includes metrics attribution.

Default CI still makes no model calls.

## Highest-value next work

Prioritize these roughly in this order, and measure each step on real local-model workloads before increasing complexity.

### 1. Shared capacity broker

The persistent-worker pool and swarm-worker pool currently enforce `maxAgents` independently. The process-wide total can therefore exceed the configured value when both systems are active.

Introduce a small shared capacity primitive rather than coupling the two orchestration layers. It should support reserved persistent slots and swarm leases.

### 2. Canonical candidate workspace path / container executor

Pi includes the absolute cwd in its system prompt. Different host worktree paths therefore reduce exact-prefix cache sharing between local candidates.

The preferred direction is a warm container/namespace executor where every candidate sees the repository as a stable path such as `/workspace`. This simultaneously enables:

- better prefix-cache reuse;
- explicit filesystem mounts;
- network policy;
- CPU/RAM limits;
- safer execution of weak/untrusted local models.

Do not call plain Git worktrees a security sandbox.

### 3. Independent test/evidence workers and cross-testing

Add a separate candidate type that is read-only for production code and produces reproducers/edge cases/regression tests.

Then run discriminative tests against surviving patch candidates after the cheap verification funnel. Avoid full O(N²) test execution by filtering candidates first.

This is the most direct implementation of the Fujitsu-style TTS@N insight from the design research.

### 4. Evidence-only / exploration mode

Current V1 is patch-oriented: a no-diff candidate is rejected even if its summary contains useful localization evidence.

Add an explicit `mode: patch | explore` rather than weakening patch correctness semantics. In `explore`, structured evidence without a diff should be a first-class collectable result that can reduce the frontier search space.

### 5. PDR refinement fallback

Only after first-wave data exists, add Parallel-Distill-Refine:

```text
first wave summaries/evidence
→ deterministic compact distillation
→ 2–4 fresh refinement candidates
```

Do not add free-form agent-to-agent debate.

### 6. Swarm-specific metrics

Add non-sensitive structural fields rather than scraping prompts:

- swarm job id;
- candidate id/strategy;
- requested/started/completed/cancelled counts;
- time to first result / first verified result;
- early-stop reason;
- timeout/crash rates;
- candidate applied unchanged / applied after frontier rewrite / evidence-only;
- local compute versus frontier token/turn reduction.

The main production KPI is frontier work avoided without correctness or latency regression, not local candidate pass rate by itself.

### 7. Adaptive allocation

After hundreds of real tasks, learn or calibrate:

```text
P(next local rollout changes the decision | current candidate pool)
```

Do not train a selector before enough project-specific data exists. Start with execution/pool features, not model self-confidence.

## Known V1 limitations

- no cross-candidate tests;
- no dedicated test-only workers;
- no PDR second wave;
- no evidence-only result mode;
- no canonical `/workspace` prefix optimization;
- no OS/container sandbox;
- no learned early stopping;
- no automatic repository test discovery;
- no semantic/three-way conflict resolution on apply;
- no job persistence across Pi extension reload/session restart;
- no shared global capacity broker across persistent and swarm pools;
- candidate verification commands have a fixed internal 120s command timeout;
- starting Pi from a repository subdirectory snapshots the whole repository and candidates run at worktree root; preserve/restore relative cwd in a future revision if this matters for a project.

## Local continuation workflow

Start from the feature branch:

```sh
git fetch origin
git switch feat/speculative-local-swarm
npm ci --ignore-scripts
npm test
npm run typecheck
npm run test:e2e
```

For live dogfooding, configure a real `local-swarm` role in `.pi/persistent-subagents.json`; do not commit personal provider identifiers, credentials, runtime artifacts or private prompts to this public repository.

Before changing architecture, read:

1. `docs/swarm.md`
2. `docs/superpowers/specs/2026-09-15-speculative-local-swarm-design.md`
3. this handoff
4. the current `src/swarm-manager.ts` tests

## Suggested prompt for the next agent

```text
Continue implementation on branch feat/speculative-local-swarm in RobertKoval/pi-persistent-subagents.

Read docs/swarm-handoff.md, docs/swarm.md and the speculative-local-swarm design/plan before modifying code. The frontier Pi model must always remain the main orchestrator; local models are subordinate speculative compute.

First run the complete offline test/typecheck/e2e suite. Then inspect the current implementation and choose the highest-value unfinished item from the handoff, starting with shared capacity/canonical workspace/cross-testing depending on the local hardware experiment we want to run. Preserve TDD, backward compatibility of existing persistent-worker tools, compact frontier context, public-repository privacy, and execution-based verification. Do not add multi-agent debate or silently route swarm work to the frontier model.
```
