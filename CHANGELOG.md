# Changelog

## 0.4.1 — 2026-11-21

### Fixed

- `.pi/persistent-subagents.json` was read even when Pi had declined to trust the project (`--no-approve` or a saved "no"), so the folder could set roles, limits and other worker settings. It is now ignored with a warning, as Pi ignores its own project settings.

## 0.4.0 — 2026-11-21

Requires **Pi 1.6** or later in the 1.x line (tested with 1.6.0). Pi 0.85 is no longer supported.

### Fixed

- Spawning without a model failed on Pi 1.x, which refuses `--provider` without `--model`. An inherited provider is now paired with Pi's configured default model, or the parent's model.
- `interrupt` reported the aborted run as a finished result before the replacement ran. It is now superseded silently.
- `send_input` read the worker state and then chose prompt or steer, which could race a finishing run. It now sends one atomic Pi prompt and reports Pi's `disposition`.
- A `wait_agent` issued in parallel with `send_input` could return the previous result.
- A task or input consumed by an extension command left the worker `running` forever.
- An error from an attempt that Pi then retried successfully stuck to the result.
- Shutdown sent SIGKILL after 1.5 s, which could cut off Pi's OAuth refresh and revoke the shared sign-in. Workers now get stdin EOF and SIGTERM, with a 10 s grace.

### Added

- Footer status with the session's total cost: main + all workers, including closed, resumed and nested ones, from Pi's own session ledgers.
- `outcome` on results and notifications: `completed`, `error` or `aborted`.
- Context budget (`contextBudgetTokens`, `context_budget_tokens`): an idle worker above it is compacted before new input. `list_agents(verbose)` shows context usage.
- `reuse` hint; `one_shot` stops Pi's idle cache warming in that worker. `cacheRetention: long` per worker.
- Role `description`; `list_agents` lists roles, and an unknown role names the configured ones.
- `workerExtensions` and role `extensions` (global config only) to load extensions into workers.
- Worker identity environment: `PI_PERSISTENT_SUBAGENT_ID`, `_NAME`, `_ROLE`, `_REUSE` next to `_DEPTH`.
- An installed-Pi test suite against a local mock model, run in CI.

### Changed

- `shutdownGraceMs` defaults to 10000.
- Completion notifications name the outcome instead of `idle`.
