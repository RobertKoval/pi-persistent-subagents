# Configuration

Configuration is optional. The defaults allow six persistent workers, one generation of children, and no idle expiry.

Files are loaded in this order:

1. `<PI_CODING_AGENT_DIR or ~/.pi/agent>/persistent-subagents/config.json`
2. `<project>/.pi/persistent-subagents.json`

Project settings override global settings. Role maps merge by role name. A project can only tighten `workerMcpAllowlist` (see [Worker MCP allowlist](#worker-mcp-allowlist)). An invalid file is rejected as a whole with a warning; valid settings from the other level remain in effect.

| Setting | Default | Meaning |
| --- | --- | --- |
| `metricsWorkers` | `true` | Record this extension’s workers in shared local SQLite. |
| `metricsMain` | `false` | Also record the main Pi agent. Independent of worker tracking. |
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
| `workerMcpAllowlist` | `{}` | Per MCP server, the tools workers may call. See [Worker MCP allowlist](#worker-mcp-allowlist). |

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

## Worker MCP allowlist

Workers share the parent's MCP servers. To keep a server read-only for workers, for example a shared memory that only the manager should write to, list the tools workers may call:

```json
{
  "workerMcpAllowlist": {
    "hindsight": ["recall", "search_pages", "get_*", "list_*"]
  }
}
```

In every worker, any other tool of a listed server is blocked before it runs, and the worker is told to return its finding to the manager instead. A tool the server adds later is blocked until you list it. An empty list blocks every tool of the server for workers. Servers that are not listed, other tools and the manager itself are not affected. Pi's resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) only read, and the allowlist does not restrict them.

A project file can add servers, or block a server the global file lists by giving it `[]`. A different list for a server the global file names is ignored with a warning, so a cloned repository cannot reopen what your global configuration restricts.

Names follow Pi's MCP naming: `*` matches any characters, and characters other than letters, digits and `_` count as `_`, so `get-page` and `get_page` name the same tool. Calls from `codemode` scripts are checked too.

The root session's allowlist applies to every worker generation. It travels to workers in the `PI_PERSISTENT_WORKER_MCP_ALLOWLIST` environment variable, and each worker loads the gate with `-e`, so enforcement does not depend on the child discovering this package. A worker's own configuration cannot loosen it. If a worker receives an unreadable value, it blocks every MCP tool, resource tools included. If a configuration file is invalid, it is ignored with a warning like any other setting, so workers then run without the allowlist from that file.

The gate checks tool names from Pi's built-in MCP support. An extension that replaces it, such as `pi-mcp-adapter`, names tools differently and is not covered.

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
