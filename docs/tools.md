# Tool reference

All IDs refer to workers owned by the current parent session. `/pworkers` provides a human-readable view of the same pool.

| Tool | Required | Optional |
| --- | --- | --- |
| `spawn_agent` | `task` | `name`, `role`, `provider`, `model`, `thinking`, `cwd` |
| `send_input` | `id`, `message` | `mode`: `auto`, `steer`, `follow_up`, `interrupt` |
| `wait_agent` | `ids` | `until`: `any` or `all`; `timeout_ms` (default 30000); `verbose` |
| `list_agents` | — | `verbose` |
| `close_agent` | `id` | — |
| `resume_agent` | `id` | — |

## Sending work

`spawn_agent` returns after the child's `get_state` handshake and initial prompt acceptance. It does not wait for the task to finish.

| Mode | Idle worker | Running worker |
| --- | --- | --- |
| `auto` / `steer` | Prompt | Steer |
| `follow_up` | Prompt | Queue follow-up |
| `interrupt` | Prompt | Abort, then prompt |

State-changing input is serialized per worker. Use `wait_agent` to wait for the result. `agent_settled` marks the end of the current run, not the end of the process.

## Results and lifecycle

Model-visible tool results use [TOON](https://github.com/toon-format/toon). Pi RPC itself remains JSONL, and structured tool `details` remain unchanged for integrations.

- `send_input` acknowledges with `id`, `status`, `pid` and an error if present. It does not repeat output, paths or usage.
- `spawn_agent` also reports the selected provider/model; `resume_agent` adds cache continuity.
- `list_agents` returns a compact table of ID, name/role, state, PID, model and error. It does not fetch worker output.
- `wait_agent` returns timeout state and each selected worker's ID, state, error and full latest output.
- `verbose: true` on list/wait adds the full metadata, session path, usage and latest output for diagnostics.

`idle` means the run has settled: check `error` and the output before interpreting it as success. Multiline output and special characters are encoded by the TOON library without truncation.

`wait_agent` returns when the requested workers are idle, closed or crashed. Its timeout does not kill them. A crashed worker needs `resume_agent` before more input; a saved session must exist.

`close_agent` stops the process but keeps metadata. `resume_agent` returns a different PID on the same saved session and reports `cold_process`. Related turns in a live process report `warm_process`; neither label is proof of a provider cache hit.

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Availability depends on the model.

Completion notifications are short, passive signals. They do not include worker output or start a new manager turn. Use `wait_agent` with the notified ID to fetch the result on demand.
