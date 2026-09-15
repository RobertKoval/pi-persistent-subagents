# Speculative local coding swarm

The optional `swarm` tool is a speculative compute layer beneath the **existing frontier Pi agent**. It does not replace, route around, or demote the main model. The frontier agent remains the user-facing orchestrator and decides when local parallel work is worth launching, when to collect it, and whether to apply or rewrite a candidate.

The intended use case is saving frontier effort on repository exploration and executable-verifiable coding work by spending cheap/local inference in parallel.

## Mental model

```text
frontier Pi agent
      │
      ├─ swarm(start) ────────────────┐
      │                              │
      ├─ continues independent work  │
      │                              ▼
      │                      local candidates
      │                      c1  c2  c3 ...
      │                         │
      │                      verifier
      │                         │
      └─ swarm(collect) ◄────────────┘
             │
             ├─ inspect/rewrite
             └─ optional swarm(apply)
```

A swarm candidate is deliberately different from a persistent worker. Persistent workers are long-lived actors whose conversation and process can be reused. Swarm candidates are fresh, isolated, one-shot attempts designed to diversify search.

## Configure a local worker model

The extension deliberately refuses to silently fall back to the main/default model for `swarm start`. Configure a `local-swarm` role or pass an explicit `model` on each start.

Example project config:

```json
{
  "maxAgents": 6,
  "roles": {
    "local-swarm": {
      "provider": "your-local-provider",
      "model": "your-local-model",
      "thinking": "low"
    }
  }
}
```

Use exact provider/model identifiers available in your Pi installation. Role selection follows the same rules as persistent workers.

## Tool actions

The model receives one high-level tool, `swarm`, rather than a large set of orchestration primitives.

### `start`

Starts a job asynchronously. Repository snapshot preparation, worker inference and verification continue after the tool call returns.

Important fields:

- `task`: coding/investigation task for the local candidates.
- `max_candidates`: logical search width. Default 6, maximum 32.
- `max_active`: maximum simultaneously active candidates. Default `min(3, max_candidates)` and additionally clamped to `maxAgents`.
- `min_completed`: minimum completed candidates before a verified result may trigger early stopping. Default 2 when possible.
- `candidate_timeout_ms`: wall-clock limit for one local candidate. Default 300000 ms, maximum 3600000 ms. A timed-out candidate is rejected and its slot is backfilled.
- `acceptance_commands`: shell commands the runtime executes independently after a candidate settles.
- `role`, `provider`, `model`, `thinking`: worker selection overrides.

Example intent:

```text
swarm start
  task: "Find and fix the cache invalidation bug after module rename"
  max_candidates: 8
  max_active: 3
  candidate_timeout_ms: 180000
  acceptance_commands:
    - "npm test -- cache"
```

`max_candidates` and `max_active` are intentionally separate. Eight possible strategies do not imply eight simultaneous decode streams.

### `status`

Returns job-level counts only: state, active, queued, completed, cancelled and verified candidates. It does not expose worker trajectories.

### `collect`

Returns the best completed candidate(s), default `top_k=1`, including:

- candidate status;
- compact final summary;
- changed file names;
- patch artifact path;
- acceptance command, pass/fail and exit code.

Verifier stdout/stderr and raw worker trajectories are intentionally excluded from the model-visible collection result.

Candidate states have evidence semantics:

- `verified`: repository changed and every configured acceptance command exited zero;
- `partial`: repository changed, but no acceptance commands were supplied or not all verification evidence is sufficient;
- `rejected`: no useful repository change, candidate capture/verification failed, the worker crashed, or its wall-clock budget expired.

`verified` means the configured executable checks passed. It is evidence for the frontier agent, not a claim that a patch is universally correct.

### `apply`

Explicitly applies a captured `verified` or `partial` candidate to the current parent working tree after `git apply --check`. Rejected candidates are not eligible. If the parent has drifted so the patch cannot apply cleanly, nothing is applied and the frontier receives the failure.

### `cancel`

Cancels queued candidates and closes active worker processes without waiting for them to finish their current reasoning.

## Repository snapshot semantics

The swarm may be started while the frontier agent has a dirty working tree. The runtime creates a synthetic Git commit using a temporary index:

```text
HEAD
 + staged changes
 + unstaged tracked changes
 + untracked non-ignored files
 = immutable delegated snapshot
```

The user's branch, `HEAD`, index and working tree are not changed by snapshot creation.

Each candidate receives a detached Git worktree from that synthetic commit. Candidate edits therefore do not race on the same files. After settlement the runtime snapshots the candidate tree and creates a binary Git diff artifact; it does not rely on the model to commit or accurately report its changes.

Git must be available on `PATH`, and the working directory must be inside a Git repository.

## Scheduling, failures, and early stopping

The scheduler fills at most `max_active` candidate slots. When one settles, crashes, or times out, a queued strategy backfills the slot. A task-level candidate timeout prevents a looping weak model from occupying local capacity indefinitely.

After at least `min_completed` candidates have completed, the first verified pool result can stop remaining queued work and cancel running stragglers.

The manager also handles two races common with fast local workers:

- a worker may settle before `spawnAgent()` returns; the returned terminal snapshot is recovered instead of losing the completion;
- a live child may crash without `agent_settled`; `WorkerPool` crash updates reject the candidate and free its slot.

The initial strategy pool intentionally varies search priors: execution-first, static flow, test-first, minimal patch, boundary analysis, alternative root cause, regression focus and dependency-boundary analysis. This aims to reduce correlated failures compared with identical sampling prompts.

## Isolation and security boundary

**Git worktrees are correctness isolation, not a security sandbox.**

A local swarm worker still runs as the same OS user as Pi. Unless the surrounding runtime restricts it, it can use the network and can read/write paths outside its worktree through tools such as `bash`. Do not use the V1 worktree mode as a containment mechanism for untrusted models or repositories.

Container/namespace execution with a canonical `/workspace`, explicit mounts, network policy and resource limits is a follow-up hardening step.

## Frontier-context discipline

Individual candidate settlement is internal to the swarm manager. It does not send one completion notification per local worker to the frontier agent.

The frontier normally sees only:

1. the small result of `swarm start`;
2. optional compact `status` calls;
3. one compact `collect` result at the natural dependency point.

This keeps failed local reasoning, terminal output and redundant candidate text out of the frontier context.

## Metrics

Local swarm worker calls use the existing `persistent-subagents/metrics.sqlite` recorder when `metricsWorkers` is enabled. Provider/model attribution, input/output/cache usage, timings, concurrency and the other existing worker metrics therefore remain available through `/pmetrics`.

The current vertical slice does **not** yet add first-class historical `swarm_job_id`, candidate strategy, early-stop reason, or accepted/rejected/apply outcome dimensions to the metrics schema. Those are follow-up instrumentation rather than inferred from prompts or tool arguments.

## Storage

Runtime swarm state lives under the Pi agent directory, beneath:

```text
persistent-subagents/swarms/
```

Synthetic commits are unreferenced Git objects; candidate worktrees are removed after capture. Patch artifacts are retained locally for collection/apply and are not uploaded by this package.

The repository itself is public, but runtime prompts, source snapshots, worker transcripts and local artifact contents are not committed by the extension.

## V1 limitations

The first vertical slice intentionally does not yet implement:

- cross-candidate test generation/execution;
- independent test-only workers;
- Parallel-Distill-Refine fallback;
- learned task routing or learned early stopping;
- canonical model-visible worktree paths for maximum prefix-cache reuse;
- container/namespace sandboxing;
- automatic full-suite discovery;
- three-way merge/conflict resolution when applying a patch;
- swarm-specific historical job/candidate dimensions in the metrics dashboard;
- a single aggregate process budget shared between persistent workers and swarm workers.

The existing `maxAgents` limit is enforced inside the swarm worker pool, but the persistent-worker pool is separate, so the current process-wide total can exceed `maxAgents` when both systems are active. Size the setting conservatively until a shared capacity broker is added.

These limitations are kept explicit so later work can be measured against the working V1 rather than hidden behind partially implemented abstractions.

## What to measure next

The useful production metrics are not only local pass rate. Measure:

- frontier input/output tokens and turns with and without swarm delegation;
- wall-clock time to a useful/verified result;
- local candidate count actually started versus cancelled before start;
- crash/timeout rate by local model and strategy;
- local aggregate throughput at different `max_active` values;
- percentage of candidates applied unchanged, rewritten by frontier, or used only as evidence;
- frontier quota lifetime on the real work distribution.

Use these measurements before raising concurrency or implementing learned allocation.
