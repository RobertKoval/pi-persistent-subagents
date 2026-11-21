# Configuration

Configuration is optional. The defaults allow six persistent workers, one generation of children, and no idle expiry.

Files are loaded in this order:

1. `<PI_CODING_AGENT_DIR or ~/.pi/agent>/persistent-subagents/config.json`
2. `<project>/.pi/persistent-subagents.json`

Project settings override global settings, but only in a project Pi trusts (`ctx.isProjectTrusted()`). Pi needs no trust decision for a bare `.pi` folder that holds only this file, so it applies there; after an explicit decline (`--no-approve`, or a saved "no" in `trust.json`) the project file is ignored with a warning, so a cloned repository or a target folder cannot configure workers. Role maps merge by role name. An invalid file is rejected as a whole with a warning; valid settings from the other level remain in effect.

| Setting | Default | Meaning |
| --- | --- | --- |
| `metricsWorkers` | `true` | Record this extension’s workers in shared local SQLite. |
| `metricsMain` | `false` | Also record the main Pi agent. Independent of worker tracking. |
| `maxAgents` | `6` | Maximum live workers, including idle workers. |
| `maxDepth` | `1` | Maximum worker generation. Root is depth 0. |
| `idleTtlMs` | `0` | Auto-close after this idle duration; 0 disables expiry. |
| `startupTimeoutMs` | `15000` | Deadline for the child RPC handshake. |
| `commandTimeoutMs` | `30000` | Deadline for a command acknowledgement, not task completion. |
| `shutdownGraceMs` | `10000` | Grace after stdin EOF and SIGTERM before SIGKILL. Pi finishes shutdown work such as an OAuth token refresh first; killing it mid-refresh can revoke the shared sign-in. |
| `compactionTimeoutMs` | `600000` | Deadline for one context-budget compaction. Large contexts take much longer than a command acknowledgement. |
| `workerExtensions` | `[]` | Extra Pi extensions (`-e`) for every worker. **Global config only.** Absolute paths or `builtin:<name>`. |
| `contextBudgetTokens` | none | Soft context budget for workers; see [Context budget](#context-budget). `32768`–`10000000`. |
| `reuse` | none | Default reuse expectation: `one_shot`, `likely_soon` or `long_lived`; see [Reuse and cache retention](#reuse-and-cache-retention). |
| `cacheRetention` | none | `long` or `default`; see [Reuse and cache retention](#reuse-and-cache-retention). |
| `notifyOnSettled` | `true` | Deliver completion messages to the parent. |
| `notificationMaxChars` | `4000` | Deprecated; accepted for existing configurations but unused by short notifications. |
| `inheritParentProvider` | `true` | Use the parent's provider unless overridden. |
| `inheritParentModel` | `false` | Use an explicit/role model; absent one, pair the provider with Pi's default model (see [Selection](#selection)). Set true to inherit the parent model. |
| `inheritParentThinking` | `true` | Inherit the parent's thinking level unless overridden. |
| `roles` | `{}` | Named profiles: `provider`, `model`, `thinking`, `description`, `extensions` (global config only), `contextBudgetTokens`, `reuse`, `cacheRetention`. |

## Selection

Tool arguments override role settings, which override inherited parent values. With an explicit provider, model IDs are treated as provider-owned strings, including slashes: for example `provider: "openrouter", model: "@preset/glm53"` or `model: "z-ai/glm-5"`.

Pi 1.x refuses to start with `--provider` but no `--model`. When the provider is inherited (or chosen by a role) and no model is selected, the worker gets Pi's configured default model if `defaultProvider` in Pi settings is that provider, and otherwise the parent's own model. A provider that matches neither, with no model, fails the spawn with a message instead of starting a worker that cannot run.

An exact model ID in the selected provider's catalog takes precedence over interpreting a slash as a provider separator. A redundant matching provider prefix is removed only when the suffix is a known model or preset. Without an explicit provider, recognized `provider/model` shorthand remains available. For an unambiguous route, supply the provider separately. No alternate model is selected on failure. `cwd` defaults to the parent's current directory.

Use exact models from `pi --list-models`. The example in the README assumes those models are available to your account; other providers and models can be configured the same way.

## Roles

Roles are listed by `list_agents` (name, description, model), so the model can see which roles exist before it calls `spawn_agent`. An unknown role fails with the list of configured roles. Give each role a `description` that says when to use it:

```json
{
  "roles": {
    "advisor": { "model": "gpt-6.2-astra", "thinking": "high", "description": "Second opinion on a plan; does not edit files" },
    "explorer": { "model": "gpt-5.6-luna", "thinking": "low", "reuse": "one_shot", "description": "Cheap read-only search" }
  }
}
```

Precedence for the worker policy fields is: `spawn_agent` argument, then role, then project config, then global config.

## Context budget

`contextBudgetTokens` (config or role) or `context_budget_tokens` (`spawn_agent`) is a soft budget below the model's native window, for example 250k on a 1M model. Before new input reaches an **idle** worker, the pool reads Pi's `get_session_stats.contextUsage`; when the current context exceeds the budget, it runs Pi's `compact` on that worker first, then delivers the input. This is the same boundary at which Pi itself checks compaction before a new prompt. The `send_input` result reports `budget_compaction` with tokens before and after, or the reason compaction failed; the input is delivered either way.

Limits, by design:

- A running worker is never compacted: Pi's `compact` aborts the active run. Within one long run, only Pi's native threshold (window minus `compaction.reserveTokens`) applies. Pi 1.6 has no worker-scoped compaction setting, so mid-run enforcement needs Pi support.
- A budget at or above the native window changes nothing; Pi's own policy is already stricter.
- Unknown context usage (right after a compaction) skips the check.
- An idle worker that never gets new input is never compacted, so a finished one-shot worker costs nothing extra.

`list_agents(verbose: true)` shows `context`: current tokens, budget, native window and remaining headroom for live workers.

## Reuse and cache retention

The parent knows whether it will call a worker again; Pi's cache warmer in the worker does not.

- `reuse: "one_shot"` stops Pi's idle prompt-cache warming in that worker (`cache_warming_decision` → `stop`), so no refresh is paid for a cache nobody will read. `likely_soon` and `long_lived` leave the decision to Pi's cost-aware warmer. There is exactly one warmer: Pi's.
- `cacheRetention: "long"` sets `PI_CACHE_RETENTION=long` for that worker, so Pi requests extended provider caching where the provider supports it (for example Anthropic's 1-hour TTL, which costs more to write). `"default"` removes an inherited `PI_CACHE_RETENTION`; leaving it unset keeps the inherited environment. Retention applies from the worker's first request; it cannot extend entries already written.

The `one_shot` hook runs inside the worker, so it needs this extension loaded there: true for a `pi install`ed package; with `pi -e .` add the checkout to `workerExtensions`. Both values persist and apply again on `resume_agent`.

## Worker extensions

`workerExtensions` (all workers) and role `extensions` add `-e <path>` to the worker's Pi command, for project tools a worker needs, such as a domain extension the parent was started with via `-e`; Pi does not pass CLI extensions to child processes. They are accepted **only from the global config**: a project file is repository content, and naming code for workers to run from it would bypass Pi's project trust. A project file that sets them is rejected as a whole with a warning. Paths must be absolute or `builtin:<name>`. Do not list an extension that is already installed as a Pi package, or the worker loads it twice. Resumed workers relaunch with the extensions they were started with.

## Worker identity

A worker process can read who it is from its environment. Values from an enclosing worker never leak into a nested one.

| Variable | Value |
| --- | --- |
| `PI_PERSISTENT_SUBAGENT_DEPTH` | Worker generation, `1` for direct workers; absent or `0` in the root session. |
| `PI_PERSISTENT_SUBAGENT_ID` | Worker ID, as used by the tools. |
| `PI_PERSISTENT_SUBAGENT_NAME` | `name` from `spawn_agent`, when given. |
| `PI_PERSISTENT_SUBAGENT_ROLE` | Role name, when given. |
| `PI_PERSISTENT_SUBAGENT_REUSE` | Reuse expectation, when given. |

## Accounts

Credentials are never put in worker arguments or registry fields. Children inherit the Pi agent directory and environment, and load installed account/provider extensions normally.

For pi-accounts 0.51, the extension copies only its version-1 named selection metadata into a new worker session. Authentication stays with pi-accounts. A change in the parent affects subsequently spawned workers; an existing worker, including after resume, retains its own session selection. Other account extensions need separate compatibility validation.

## Depth and notifications

`maxDepth: 1` allows the manager to spawn workers and hides this extension's lifecycle tools at child depth. Raising the limit does not install the extension into child Pi instances; install it as a Pi package or list it in `workerExtensions` if you want nested teams.

Completion messages contain worker IDs, result IDs and status, without output, task text or usage. While the manager is busy, the extension retains pending completions locally instead of inserting follow-ups into Pi’s queue. Once the manager is idle, unread, unannounced completions produce one batched wake-up. A result returned by wait_agent is removed from pending delivery, so an obsolete event cannot wake the manager again. The manager can retrieve the result with `wait_agent` when needed. Set `notifyOnSettled: false` if you prefer explicit polling. Keeping `idleTtlMs: 0` avoids losing process continuity between related tasks.

## Metrics

Use `/pmetrics` for the local dashboard and independent tracking switches. See [usage, capacity methods, privacy and coverage](metrics.md).

### OpenRouter app attribution

New OpenRouter workers inherit the parent's `HTTP-Referer` and app title
(`X-OpenRouter-Title`, or legacy `X-Title`). Existing worker headers take precedence.
Only these app fields are copied; authentication and other request headers are not.
The parent model's configured headers are available immediately. Attribution added
by request hooks becomes available after the parent's OpenRouter response headers
arrive. If the parent has no attribution, none is invented. Already-running worker
processes retain their startup values. This does not change account selection.
