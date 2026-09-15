<div align="center">

![Pi Persistent Subagents](assets/banner.svg)

# Pi Persistent Subagents

**Spawn once. Keep the context. Work together.**

Long-lived worker agents for [Pi](https://github.com/earendil-works/pi), plus an optional speculative local coding swarm.<br>
Delegate a task, let the worker settle, then continue in the **same live process**.

[![CI](https://github.com/RobertKoval/pi-persistent-subagents/actions/workflows/ci.yml/badge.svg)](https://github.com/RobertKoval/pi-persistent-subagents/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-22c7a9)](LICENSE)
[![Pi 0.85.x](https://img.shields.io/badge/Pi-0.85.x-7c8aff)](https://github.com/earendil-works/pi)
[![Node ≥22.19](https://img.shields.io/badge/Node-%E2%89%A522.19-8bc34a)](package.json)

[Quick start](#quick-start) · [Persistent tools](#six-tools-one-workflow) · [Local swarm](#speculative-local-coding-swarm) · [Configuration](docs/configuration.md) · [How it works](docs/architecture.md)

</div>

## Why persistent workers?

A worker owns an ongoing workstream: a code area, an investigation, or a review. When it finishes a task, it becomes idle and stays available. Follow-up work keeps its PID, conversation, and eligible process-local provider state.

- **Continue without restarting.** Reuse a worker with `send_input`.
- **Steer work in flight.** Redirect, queue a follow-up, or interrupt.
- **See what is happening.** Get compact TOON status; request full results and token/cache diagnostics when needed.
- **Resume deliberately.** Close a worker and reopen its saved conversation later.
- **Keep ownership clear.** Workers exit when the parent shuts down; sessions remain resumable.

Persistent processes preserve cache *eligibility*. They do not guarantee cache hits or quota savings. [Understand the distinction →](docs/architecture.md#cache-and-usage)

## Quick start

Requires **Pi 0.85.x**, **Node.js 22.19+**, and Git for swarm workspace isolation. Authenticate your provider in Pi first.

```sh
pi install git:https://github.com/RobertKoval/pi-persistent-subagents
```

Start Pi, then ask:

> Create a persistent worker to review this module. When it finishes, ask the same worker to check the tests. Keep it available for follow-up questions.

Use `/pworkers` to see persistent workers. At the root depth the model receives the six persistent-worker tools below plus the high-level `swarm` tool.

To try a local checkout without installing globally:

```sh
git clone https://github.com/RobertKoval/pi-persistent-subagents.git
cd pi-persistent-subagents
npm ci --ignore-scripts
pi -e .
```

## Six tools, one workflow

| Tool | What it does |
| --- | --- |
| `spawn_agent` | Start a persistent worker with a task and optional role/model. |
| `send_input` | Continue an idle worker, steer a running one, queue work, or interrupt. |
| `wait_agent` | Wait for any/all selected workers. A timeout leaves them alive. |
| `list_agents` | Inspect worker states in a compact list; fetch results and diagnostics when needed. |
| `close_agent` | Stop the process and retain its conversation. |
| `resume_agent` | Start a new process on the saved conversation. |

```text
spawn_agent ── task ──▶ idle ── send_input ──▶ task ──▶ idle
                         ╰──────── same PID + session ─────╯

close_agent ──▶ saved session ── resume_agent ──▶ new PID
```

`send_input` modes: `auto` (default), `steer`, `follow_up`, `interrupt`.<br>
See [the tool reference](docs/tools.md) for parameters and lifecycle details.

## Speculative local coding swarm

The frontier Pi model remains the main orchestrator. The `swarm` tool lets it spend cheap/local inference on several isolated coding attempts while the frontier continues independent work, then collect only compact execution evidence and the best patch candidate.

Configure a cheap/local model explicitly so swarm work cannot silently fall back to your frontier model:

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

The single `swarm` tool has `start`, `status`, `collect`, `cancel`, and `apply` actions. `start` is asynchronous; `max_candidates` controls logical search width while `max_active` controls actual concurrent workers. Candidates run in detached Git worktrees from an immutable snapshot of the current dirty repository. Runtime diff capture and acceptance-command exit codes are treated as evidence instead of trusting model claims.

Without `acceptance_commands`, a changed candidate is `partial`, not `verified`. Applying a patch is always explicit, and rejected candidates cannot be applied through the tool.

Use `/pswarms` for a human-readable job view. [Architecture, safety boundary, examples and current limitations →](docs/swarm.md)

## Choose a small team

Save this as `.pi/persistent-subagents.json` in your project. Use model IDs available to your account:

```json
{
  "maxAgents": 3,
  "roles": {
    "coder": { "model": "gpt-5.6-luna", "thinking": "low" },
    "reviewer": { "model": "gpt-5.6-terra", "thinking": "medium" }
  }
}
```

Roles inherit the parent's provider unless overridden. With [pi-accounts](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-accounts) 0.51, new workers also inherit its session-local named selection without copying credentials. Existing and resumed workers keep their original selection.

[All settings and precedence →](docs/configuration.md)

## Local usage and capacity reports

Run `/pmetrics` for a local dashboard with per-project/day usage, observed stream throughput, task timings, concurrency and immutable API-equivalent cost estimates. Export JSON or CSV. Worker tracking defaults on; main-agent tracking defaults off; both have independent switches.

The shared SQLite database contains metrics only, without prompts, responses or tool arguments. [Measurement methods and limitations →](docs/metrics.md)

The current swarm vertical slice does not yet add swarm-specific historical job/candidate fields to this dashboard; see [swarm limitations](docs/swarm.md#v1-limitations).

## Practical boundaries

Persistent workers have the same OS permissions as Pi and share a working directory unless you override `cwd`. Coordinate edits to shared files.

Swarm candidates use separate Git worktrees, so their repository edits are isolated from one another. **A worktree is not a security sandbox:** local candidates still run with Pi's OS permissions and can access paths/network outside the worktree unless your environment restricts them.

By default, workers do not create another generation of this extension's workers. The depth limit applies to this extension; it does not disable unrelated installed tools. The swarm tool is root-only and is not exposed to its leaf workers. Sessions, results and swarm artifacts are local data—not automatically uploaded by this package.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run test:e2e
```

Default tests use fake RPC processes and make **no model calls**. The opt-in Pi smoke also makes no model call. Live tests exercise real providers and consume quota; see [testing](docs/testing.md).

Bug reports and focused contributions are welcome. [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
