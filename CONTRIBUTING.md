# Contributing

Small, focused changes are welcome. Open an issue for a bug or a substantial design change; include the intended behavior and a reproducible example.

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run test:e2e
```

Add a failing behavioral regression before fixing a bug. Test observable behavior at the process/tool boundary; avoid assertions that merely search source files for strings. Include exact boundaries for limits and state transitions.

Preserve the central contract: a settled worker stays alive, related tasks reuse its process, and close/resume retains the session while starting a new process. Do not replace persistent RPC workers with one-shot subprocesses.

Do not commit credentials, private transcripts, local paths or generated acceptance logs. The default suite must stay offline. Provider tests are opt-in and described in [testing](docs/testing.md).

A pull request should explain the user-visible change, its regression or acceptance check, and relevant limitations. Keep unrelated refactors separate.
