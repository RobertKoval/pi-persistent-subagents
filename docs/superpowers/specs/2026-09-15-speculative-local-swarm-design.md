# Speculative Local Swarm Design

## Goal

Add a speculative local-compute layer beneath the always-present frontier Pi agent. The frontier remains the sole user-facing orchestrator. Local workers explore, patch, test and return compact verified evidence without flooding the frontier context.

## Core invariants

- The frontier model always remains the parent Pi agent.
- `swarm start` is asynchronous and returns a job id quickly.
- Candidate workers are fresh one-shot attempts, not persistent conversational actors.
- Candidate workspaces are isolated from one another and from the parent workspace.
- The parent workspace may be dirty; the delegated snapshot must include tracked, staged and untracked non-ignored files without mutating the user's index or branch.
- Worker completion must not wake the frontier one-by-one.
- Runtime facts (diffs, command exit codes, changed files) outrank model claims.
- `collect` returns compact decision-relevant evidence, not raw trajectories.
- Applying a candidate is explicit and must detect parent drift/conflicts.
- Logical candidate width and active inference concurrency are separate controls.

## V1 architecture

A second Pi extension entry point in this package registers one `swarm` tool and `/pswarms`. It owns a `SwarmManager` built on the existing `WorkerPool`, while keeping the existing persistent-worker extension unchanged.

`SwarmManager` owns job state, candidate scheduling, worker-to-candidate mapping, worktree lifecycle, patch capture, acceptance-command verification, early stopping, compact collection and cleanup.

`swarm(start)` accepts a task, optional role/provider/model/thinking, candidate count, active concurrency and acceptance commands. It creates a synthetic Git snapshot of the current dirty repository and starts up to `max_active` candidates with structurally different search strategies. More candidates remain queued.

Each candidate runs in a detached Git worktree from the synthetic snapshot. On settle, the runtime snapshots the candidate tree, captures a binary diff, runs acceptance commands, assigns a simple evidence status, removes the worker/worktree, and schedules the next queued candidate unless a verified winner permits early stop.

`swarm(status)` returns counts only. `swarm(collect)` returns the best candidate plus compact evidence and artifact paths. `swarm(cancel)` terminates remaining work. `swarm(apply)` performs a checked three-way apply against the current parent workspace and refuses unresolved conflicts.

## V1 verification

Hard evidence:
1. Candidate patch can be captured from Git.
2. Every configured acceptance command exits zero.

Ranking:
1. verified candidates before partial/rejected;
2. fewer failed commands;
3. smaller patch as a deterministic tie-breaker.

Cross-agent tests, independent test workers, PDR refinement and learned stopping are follow-up phases after the vertical slice is measured on real workloads.

## Cache and prompt discipline

Worker prompts share a common prefix and place strategy-specific instructions last. Candidate identifiers and random filesystem paths are not intentionally inserted into the task prompt. Worktree paths still differ in Pi's system prompt in V1; canonical prompt-root/container execution is a follow-up optimization.

## Public-repository constraint

The repository is public. No prompts, source snippets, credentials, environment values, user filesystem paths outside existing behavior, or private task artifacts are committed. Runtime artifacts remain local under the Pi agent directory.

## Success criteria

- Existing persistent-subagent behavior remains backward compatible.
- Offline tests make no model calls.
- A dirty repository can be snapshotted without changing branch/index/worktree contents.
- Candidate worktrees are isolated.
- Candidate completions are internal to the swarm extension.
- Concurrency is bounded and queued candidates are cancelled on a verified early stop.
- Compact collection does not expose raw worker transcripts unless explicitly requested in a future diagnostic mode.
- Cleanup is deterministic on cancellation and session shutdown.
