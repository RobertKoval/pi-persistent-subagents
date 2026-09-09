# Testing

## Offline checks

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run diagnose
```

The default suite spawns deterministic fake RPC processes. It covers PID reuse, routing, shutdown, crash recovery, session continuity, account selection, framing and errors without contacting a model.

## Installed Pi, no model calls

```sh
npm run test:e2e
npm run test:lifecycle
```

The first command verifies extension registration and executes `/pworkers`. The second tests startup cleanup under SIGTERM, SIGHUP and SIGKILL. Lifecycle scripts currently use POSIX process inspection and are intended for macOS/Linux.

## Live acceptance

These commands use your authenticated Pi account and **consume model quota**. The default models are `openai-codex/gpt-5.6-luna` and `gpt-5.6-terra`; they must be available to your account. They use temporary directories and clean up their own sessions after process shutdown.

```sh
npm run test:live            # Same PID, account metadata, resume and recall
npm run test:live:manager    # Terra managing Luna/Terra through all six tools
npm run test:live:wake       # Manager ends a turn, then resumes on worker completion
npm run test:live:dedup      # Consumed result does not create another manager run
npm run test:live:streaming  # Actual steer/follow_up/abort RPC routing
npm run test:live:shutdown   # Parent + workers + shell descendants
npm run test:live:cache     # Persistent vs restarted process, same transcript
```

The live harness explicitly loads the checkout and the standard npm installation of pi-accounts, avoiding duplicate registration when the released extension is already installed. Set `PI_TEST_ACCOUNTS_EXTENSION` to an existing account extension path for a nonstandard installation. Other parent extensions are excluded from these tests.

Set `PI_TEST_ACCOUNT` to a non-secret pi-accounts account name to choose it for the temporary parent session. This does not change the global account selection. The harness checks inherited metadata; switching identities during an active session remains a separate provider-specific scenario.

The cache comparison alternates task order across two arms, with five equivalent tasks each. The restarted arm retains its session/transcript while changing PID each turn. Totals are checked against actual Pi session assistant messages. This tests usage accounting and process continuity; it does not independently measure Business credits, quota or socket reuse.

## Reporting a failure

Include Pi/Node versions, OS, the command, and sanitized error output. Never attach auth files, tokens or private session transcripts. For behavioral fixes, reproduce the bug in a failing test first; then run the offline suite and relevant integration check.
