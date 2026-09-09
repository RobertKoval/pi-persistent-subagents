# Configuration

Configuration is optional. The defaults allow six persistent workers, one generation of children, and no idle expiry.

Files are loaded in this order:

1. `<PI_CODING_AGENT_DIR or ~/.pi/agent>/persistent-subagents/config.json`
2. `<project>/.pi/persistent-subagents.json`

Project settings override global settings. Role maps merge by role name. An invalid file is rejected as a whole with a warning; valid settings from the other level remain in effect.

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxAgents` | `6` | Maximum live workers, including idle workers. |
| `maxDepth` | `1` | Maximum worker generation. Root is depth 0. |
| `idleTtlMs` | `0` | Auto-close after this idle duration; 0 disables expiry. |
| `startupTimeoutMs` | `15000` | Deadline for the child RPC handshake. |
| `commandTimeoutMs` | `30000` | Deadline for a command acknowledgement, not task completion. |
| `shutdownGraceMs` | `1500` | Grace before forced process termination. |
| `notifyOnSettled` | `true` | Deliver completion messages to the parent. |
| `notificationMaxChars` | `4000` | Deprecated; accepted for existing configurations but unused by short notifications. |
| `inheritParentProvider` | `true` | Use the parent's provider unless overridden. |
| `inheritParentModel` | `false` | Use an explicit/role model; absent one, let child Pi select its default. Set true to inherit the parent model. |
| `inheritParentThinking` | `true` | Inherit the parent's thinking level unless overridden. |
| `roles` | `{}` | Named provider/model/thinking profiles. |

## Selection

Tool arguments override role settings, which override inherited parent values. With an explicit provider, model IDs are treated as provider-owned strings, including slashes: for example `provider: "openrouter", model: "@preset/glm53"` or `model: "z-ai/glm-5"`.

An exact model ID in the selected provider's catalog takes precedence over interpreting a slash as a provider separator. A redundant matching provider prefix is removed only when the suffix is a known model or preset. Without an explicit provider, recognized `provider/model` shorthand remains available. For an unambiguous route, supply the provider separately. No alternate model is selected on failure. `cwd` defaults to the parent's current directory.

Use exact models from `pi --list-models`. The example in the README assumes those models are available to your account; other providers and models can be configured the same way.

## Accounts

Credentials are never put in worker arguments or registry fields. Children inherit the Pi agent directory and environment, and load installed account/provider extensions normally.

For pi-accounts 0.51, the extension copies only its version-1 named selection metadata into a new worker session. Authentication stays with pi-accounts. A change in the parent affects subsequently spawned workers; an existing worker, including after resume, retains its own session selection. Other account extensions need separate compatibility validation.

## Depth and notifications

`maxDepth: 1` allows the manager to spawn workers and hides this extension's lifecycle tools at child depth. Raising the limit does not install the extension into child Pi instances; ensure child extension discovery is configured if you want nested teams.

Completion messages contain worker IDs, result IDs and status, without output, task text or usage. While the manager is busy, the extension retains pending completions locally instead of inserting follow-ups into Pi’s queue. Once the manager is idle, unread, unannounced completions produce one batched wake-up. A result returned by wait_agent is removed from pending delivery, so an obsolete event cannot wake the manager again. The manager can retrieve the result with `wait_agent` when needed. Set `notifyOnSettled: false` if you prefer explicit polling. Keeping `idleTtlMs: 0` avoids losing process continuity between related tasks.
