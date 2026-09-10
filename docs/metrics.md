# Usage and capacity metrics

Run `/pmetrics` in Pi to get a private local dashboard URL. It shows the last 30 days by default; change the UTC date range to inspect older data. JSON exports include individual calls, tasks, tools, raw numeric usage, price snapshots and concurrency intervals. CSV exports assistant calls and compaction operations, distinguished by the `operation` column.

Worker accounting defaults **on**; main-agent accounting defaults **off**. Both can be changed independently in the dashboard or with:

```text
/pmetrics workers off
/pmetrics workers on
/pmetrics main on
/pmetrics main off
```

The commands above save project overrides in `.pi/persistent-subagents.json`. To set defaults for **all projects**:

```text
/pmetrics global workers on
/pmetrics global main on
```

Global commands write `<PI_CODING_AGENT_DIR or ~/.pi/agent>/persistent-subagents/config.json`. The dashboard's **Save settings for** selector offers the same project/global choice. Explicit project settings take precedence over global defaults. To remove an override and inherit the global value:

```text
/pmetrics project workers inherit
/pmetrics project main inherit
```

Changes take effect immediately in the current Pi according to that precedence, without restarting workers. Other already-running Pi instances retain their settings; future sessions load the saved values. Alternatively set `metricsWorkers` and `metricsMain` in the existing global or project config. Disabling collection retains historical data and does not disable the worker lifecycle registry or its existing usage counters.

## Storage and identities

All Pi instances using the same agent directory share `persistent-subagents/metrics.sqlite`. SQLite WAL and a busy timeout allow separate processes to write concurrently. The optional `PI_PERSISTENT_SUBAGENTS_METRICS_DB` environment variable selects another local database (also useful for isolated acceptance tests). Do not put this database on a network filesystem.

History is retained; the 30-day default is a report filter, not automatic deletion. No old session-log import happens automatically. This collector observes only this extension's workers and, when enabled, their main Pi agents. It does not scrape unrelated agents.

Project identity hashes the canonical working directory. Session identifiers are hashed; worker identity stays stable across worker process restarts. The actual worker session identifier comes from the RPC handshake. Project labels are `project-<hash prefix>` so filesystem paths are never stored. Different working directories are separate projects. The actor table retains structural parents even when their usage collection is off. Nested workers inherit their parent's actor identity when running this version of the extension.

A task is an observed agent run through `agent_settled`, including automatic continuations, not an inferred business task. Its identity is bound to the first assistant-message timestamp within its worker. Model calls are deduplicated by worker identity and Pi assistant-message timestamp; tools by worker identity and tool-call ID. Reopening a session does not replay or re-add its usage. This relies on Pi's distinct timestamps for distinct messages in a worker session; sources that reuse message timestamps are not supported. No transcript content is hashed or stored to manufacture identities.

## Measurement methods

| Metric | Definition |
| --- | --- |
| Input/output/cache read/write | Numeric fields of Pi's normalized `Usage`, unchanged. Unknown fields remain absent, not zero. |
| Reasoning | Optional provider-reported breakdown; already part of output, never added again. |
| Model-call wall time | Observed `turn_start` to assistant `message_end`. Includes context preparation, transport and provider waiting; not GPU execution time. Missing start/end means unknown duration. |
| First-fragment latency | First observed text/thinking/tool-call delta minus call start. |
| Observed stream throughput | Output tokens divided by last-delta minus first-delta time. N/A for fewer than two separated fragments or missing output usage. Includes reasoning/tool-call deltas; transport buffering can distort it. Not decode TPS. |
| Tool time | Union of observed tool-execution intervals, excluding `wait_agent`. Compiler/web work inside a shell command remains classified as `bash`; arguments are not inspected. |
| Wait time | Union of `wait_agent` tool intervals. |
| Retry wait | Observed worker backoff intervals; separate from model/tool time. Each failed assistant attempt retains its own reported usage. |
| Compaction time | Observed compaction operation duration, potentially containing multiple requests and retry waits. Not treated as one model-call interval. |
| Other/unknown time | Task wall time not covered by a model, tool, compaction or retry interval. This is not a claim that the process was idle. |
| Generation duty cycle | Union of model-call intervals divided by task wall time. Interval categories may overlap; their sums need not equal wall time. |
| Worker-hours | Sum of workers' task wall time, excluding idle resident processes. |
| Concurrency | Simultaneous observed model-call intervals. Average and p95 are weighted by elapsed time across the entire selected period, including zero. Half-open intervals avoid double-counting adjoining calls. |
| Peak generating workers | Distinct workers with overlapping observed model-call intervals, not workers proven to be decoding simultaneously on a server. |
| Required aggregate TPS | Reported output divided by the union of model-call intervals for completed, measurable calls wholly within the selected period. A workload indicator, not a hardware sizing guarantee. |
| Cache-hit ratio | `cacheRead / (input + cacheRead + cacheWrite)` for newly observed, reviewed Pi 0.85 OpenAI Responses/Completions, Codex Responses and Anthropic Messages adapters. Zero denominator, missing fields, unknown providers or unmarked historical rows yield N/A. Raw counters are retained. |

Per-project/day reports split durations at UTC midnight. Token counts and cost from assistant calls and reported compactions belong entirely to the completion day; they are never prorated across days without token-level timestamps. Task timing and concurrency are clipped to the requested range. Aggregate stream throughput is total measurable output / total measurable stream duration; p50/p95 stream throughput are unweighted call percentiles.

Daily usage totals are sums of reported fields, with missing-usage counts and per-field reporting counts alongside them. A field absent from every completed call is N/A. A partial total is a lower bound, not a complete bill. Main and worker roles can be filtered separately or combined. Daily cache ratios are token-weighted, not an average of request percentages. If a day contains usage with uncertified semantics, its combined ratio is N/A and `cache_ratio_unavailable` reports the uncovered count. A model filter can isolate verified calls.

## Cost snapshots

Each completed call stores its numeric Pi usage cost components, total, `pi-usage-cost` source, recording timestamp, USD currency and effective per-million rates where usage and cost allow them to be derived. Snapshots are immutable after completion: later model pricing changes do not rewrite history.

Reported compaction usage and cost are included exactly once. Worker RPC does not identify whether a compaction was supplied by another extension, so its model/provider attribution remains `unknown`; it is still attributed to its project, session and worker. The main-agent hook distinguishes built-in and extension-supplied compactions: built-in operations use the selected model, extension-supplied ones remain unknown. Compaction intervals are excluded from ordinary model-call concurrency, duty cycle and stream TPS, and shown separately. Their reported output is included in output/day.

These are **API-equivalent estimates**, not provider invoices or subscription-limit measurements. A zero in Pi's price catalog can produce a zero estimate; this does not prove free inference. Subscription allocation, electricity/hardware costs and custom tariffs are not included in this MVP.

## Privacy and lifecycle

Only generated/hashed identifiers, safe model/provider/tool/project labels, statuses, timestamps and allowlisted numeric usage/cost data are persisted. No prompts, response text, reasoning content, shell output, tool arguments, environment contents, request headers, credentials or filesystem paths enter the database. “Raw usage” means Pi's numeric normalized usage fields, not a provider's arbitrary JSON payload.

The dashboard binds to `127.0.0.1` on a random port with a random access token, no external assets, and no CORS access. It closes with the owning extension/session. Treat its URL as private. Collection failures produce a warning and disable collection for that adapter instead of interrupting agent work; affected reports have a coverage gap.

Interrupted observed calls retain any already-reported usage; missing usage remains unknown. A hard process kill can leave open intervals. They stay visibly incomplete and are excluded from completed-duration/concurrency statistics rather than being assigned an invented end time. An enable/disable transition is an observation boundary, not a claim that the underlying model stopped.

## Coverage limits and follow-up work

- Ordinary assistant attempts (including errors/retries) and Pi-reported compaction usage are collected. Failed summarization attempts may have usage Pi does not report; that missing amount is not invented. Worker automatic retry and compaction retry backoff are measured from existing RPC events. Main-agent retry backoff and HTTP retries hidden inside provider SDKs are not exposed at these extension boundaries. No monkeypatch, proxy, packet capture or extra collector is installed to infer them.
- Explicit custom/subscription tariffs and historical log import are deferred. Current exports retain the numeric evidence needed for external analysis.
- Concurrent calls are a client-side demand signal. Provider batching, queueing and actual GPU decode concurrency require server telemetry.
- Dashboard queries are intended for local personal history; there is no remote service, automatic retention policy or database vacuum scheduler.

## Verification

`npm test` covers separate processes sharing SQLite, duplicate lifecycle events, session reopen, interrupted/error calls, raw cache fields, overlapping tools, `wait_agent`, tracking switches, nested lineage, UTC boundaries, private exports and malformed HTTP requests. It makes no model calls.

`npm run test:live:metrics` uses two fresh installed-Pi sessions and authenticated workers, verifies same-PID reuse, compares every collected token/cache total with the actual session logs, checks concurrent calls and process cleanup. It consumes provider quota. Optional `PI_TEST_PROVIDER`, `PI_TEST_MODEL` and `PI_TEST_ACCOUNTS_EXTENSION` select the test environment.

`npm run test:live:metrics:coverage` also performs one worker and one main-agent compaction in a disposable project, reconciles their usage with the session entries, and verifies cache ratios from actual Pi messages. It lowers the compaction keep threshold and trusts only that test project for the test processes; it does not modify existing Pi sessions or user settings.

Cache semantics were checked against Pi 0.85's normalization code and the primary [OpenAI cache usage documentation](https://openai.com/index/api-prompt-caching/) and [Anthropic input-token accounting](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). OpenAI's inclusive input is normalized by Pi into disjoint input/read/write counters; Anthropic provides disjoint counters directly. Interpretation is stamped on new records, so historical data is not silently reinterpreted.
