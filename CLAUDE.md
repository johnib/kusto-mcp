# kusto-mcp

## Telemetry (product code)

- Telemetry is always on. Never add an opt-out, enable flag, or env kill-switch — not
  even "for local dev". Only salted hashes and bounded enums may ship; README's "What
  is NEVER collected" is the contract.
- Never export error messages or stacks — they echo query text and identifiers. Error
  class name only, plus an errno code where present (see `recordSpanError`).
- Crash-path telemetry must never throw. A second failure inside a crash handler is
  what turned #180/#196 into a 100% CPU spin.
- Never delete `autoDetectResources: false` (`src/common/telemetry.ts:117`). NodeSDK's
  default detectors add `host.id`, `host.name` and `process.owner` as *resource*
  attributes — under every span, and invisible to a span-attribute review.
- Every local run ships real spans to the production Honeycomb dataset. `src/index.ts`
  starts telemetry unconditionally and `npm run test:e2e` spawns the built server and
  mocks nothing. `machine.id` persists to disk, so the machine joins the fleet
  permanently. Export `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9999` before
  running the server or e2e locally.
- Before analysing the Honeycomb `kusto-mcp` environment, read
  `docs/telemetry-semantics.md` if you have it — it holds the counting conventions and
  query gotchas. It is maintainer-local and deliberately untracked, so it is absent from
  a fresh clone and from CI; without it, derive conventions from the code rather than
  assuming span volume means anything.

## Tests and CI

- CI runs the **unit** project only; `tests/e2e` never runs there (it needs `az login`
  and a live cluster). Any regression guard that must hold goes in `tests/unit`.
- CI order is lint → test → build, so `dist/` does not exist while unit tests run.
- Nothing lints or typechecks `tests/`: every lint script is `eslint src` and
  `tsconfig.json` includes only `src/**/*`. A type error in a new test surfaces only
  when jest executes that line.
- `npm run format` is scoped to `src/**/*.ts`. Never `prettier --write` README.md or
  `docs/*.md` — it reflows unrelated lines into the diff.
- CI is `ubuntu-latest` only, but Windows is ~75% of the fleet. A platform-specific fix
  gets no `Closes #` until a `windows-latest` A/B (baseline vs patched) has actually run.
- Check CI with `gh pr view --json statusCheckRollup`, not by parsing `gh pr checks` —
  it renders cancelled jobs as `fail`.

## Repo

- `docs/` and `.proto/` hold untracked internal planning material and are not
  gitignored — only `CONFIGURATION.md`, `DEVELOPER.md` and `pre-commit-hooks.md` are
  tracked. Stage per file; never `git add docs/`.
- Releases are semantic-release on merge to `master`, squash-merged — so the **PR title**
  carries the semantic prefix. Only `fix:` and `feat:` publish; use `chore:`/`docs:` for
  changes that must not release.
- The empty `stderr.on('error', () => {})` in `installStderrErrorGuard`
  (`src/common/utils.ts`) is the *entire* fix for the orphan CPU spin (#180, #196). It
  looks like a no-op. Never remove it in a cleanup or `/simplify` pass.

## Calling this MCP server

- `show-tables` / `show-table` / `show-functions` / `show-function` `JSON.stringify`
  their result directly (`src/server.ts`) and bypass the response limiter — a full
  schema dump blows the token cap. Prefer `execute-query`, which caps at 12000 chars
  regardless of `limit`, and aggregate server-side:
  `.show tables | summarize Total=count(), Tables=make_list(TableName)`.
