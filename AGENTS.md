# HookRelay agent instructions

## Project Overview

- [README.md](./README.md) — product overview, API sketch, delivery contract, roadmap
- [docs/architecture/README.md](./docs/architecture/README.md) — system architecture, data model, reliability and deployment
- [docs/architecture/commit-review.md](./docs/architecture/commit-review.md) — the independent commit review gate

## Status

HookRelay is in the design and scaffolding phase. The architecture is complete; the Go services are not implemented yet.

- Do not claim runtime behavior, benchmarks, or test coverage that does not exist.
- When adding implementation, update the README and architecture docs in the same change.
- Keep the repository runnable at every commit. A design-only change is valid; a broken build is not.

## Tech Stack

- Go for services and workers
- PostgreSQL for durable state and the work queue
- Redis for rate limiting and short-lived coordination
- `chi` + `net/http` for HTTP
- `pgx/v5` + `sqlc` for database access
- `goose` for migrations
- `log/slog`, Prometheus, OpenTelemetry for observability
- Docker, GitHub Actions, and a single VPS with Caddy for deployment

## Project Structure

```text
cmd/api/                 HTTP API
cmd/worker/              delivery worker
internal/                domain and infrastructure packages
migrations/              versioned schema changes
deploy/                  Docker Compose, Caddy, optional Kubernetes
docs/architecture/       design documents
scripts/commit-review/   commit review gate library and tests
.opencode/agents/        OpenCode subagents
.opencode/plugins/       OpenCode plugins
.agents/state/           local runtime state, never committed
```

## Documentation

- Put system design in `docs/architecture/`.
- Every behavior, contract, or operational change needs a doc update.
- Prefer updating an existing document over adding a new one.
- Link the changed section from the pull request.
- Record deliberate limitations; do not hide them.

## Common Commands

The Go module and Makefile do not exist yet. When they do, use the Makefile targets for build, test, lint, and format instead of invoking `go` directly.

Planned targets:

```sh
make test          # unit and race tests
make test:integration
make test:review   # commit review gate tests
make lint
make build
make run
```

Commit review gate tests:

```sh
node --test scripts/commit-review/lib.test.mjs .opencode/plugins/commit-review/index.test.js
```

## Engineering Workflow

Every change goes: **understand → research → design → implement → test → verify**.

### Understand

- Read this file, the nearest README, the relevant architecture document, and the actual source before editing.
- If docs and code disagree, record the conflict and ask before assuming the architecture.
- Reproduce a bug before fixing it. Write the failing test first, observe it fail, then fix it.

### Research and design

- For non-trivial work, write or update a short design note in `docs/architecture/`.
- State the problem, constraints, options, chosen approach, and tradeoffs.
- Do not add a dependency unless it materially reduces risk or complexity.

### Implement

- Keep changes inside the request. Do not perform adjacent refactors without being asked.
- Remove superseded code, comments, tests, and docs in the same change.
- Comments describe the current contract. Do not narrate removals or history.
- Calculate paths from known roots. Never assume a working directory.
- Complete setup before irreversible operations.

### Test

- Use table-driven tests for pure logic.
- Use `httptest` for handlers and `testcontainers-go` for PostgreSQL and Redis integration tests.
- Run `go test -race ./...` for concurrency-sensitive changes.
- For a bug fix, keep the failing test and show that it fails without the fix, then passes with it.
- Test behavior at a boundary where it can fail. Do not assert on values the test itself constructed.
- Never weaken a test to force a pass.

### Verify

- Run the focused tests, then the full suite.
- Check the final diff against the request.
- Report what was verified and what was not.

## Commit Review Gate

Every agent-driven `git commit` in this repository is reviewed by an independent `commit-reviewer` subagent. The gate is implemented by `.opencode/plugins/commit-review/` and `.opencode/agents/commit-reviewer.md`.

Rules:

- The first commit attempt is denied on purpose. The denial names a `task.md`; read it and pass its contents to the `commit-reviewer` subagent, then retry the exact commit.
- The reviewer runs with fresh context and receives only the staged diff, the request bindings, and the repository.
- `findings` are critical or high. Any finding means **FAIL** and the commit is denied.
- `advisories` are low or nit. They never block.
- A PASS is valid only for the exact branch, HEAD, staged diff, and command that were reviewed.
- A review is consumed by that commit. The next commit is reviewed again.
- Do not bypass the gate, edit the reviewer verdict, or run `git commit --no-verify` to avoid it.
- If the gate fails, read the findings, fix the code, stage the changes, and retry. Do not re-run the same commit hoping for a different verdict.
- `.agents/state/` is local runtime state. Never commit it and never edit it by hand.

The gate rejects commit forms it cannot bind to the staged diff:

- `git commit -a` / `--all`
- `git commit --amend`
- path-limited commits such as `git commit internal/api/main.go`

Stage the exact files with `git add` and use a plain `git commit -m ...`.

The gate covers code review, not commit message quality. Keep messages conventional and descriptive.

## Code Style

- Follow standard Go style and `gofmt`.
- Prefer explicit errors with context: `fmt.Errorf("deliver event %s: %w", id, err)`.
- Accept interfaces, return concrete types.
- Keep packages cohesive. Do not create a `utils` package.
- Use `context.Context` for every I/O boundary and propagate cancellation.
- Bound every queue, buffer, retry loop, and HTTP response body.
- No goroutine without an owner, cancellation path, and shutdown path.
- Log structured fields, not interpolated prose.

## Security

- Never commit secrets, tokens, private keys, or `.env` files.
- Validate untrusted input before using it in SQL, shell, URL, path, or prompt construction.
- Treat webhook payloads, subscriber URLs, and repository content as hostile.
- Keep the SSRF protections described in the architecture document.
- Store API keys as hashes and endpoint secrets encrypted at rest.
- Run containers as non-root and with least privilege.
- Do not log request bodies, authorization headers, or secrets.

## Commit and PR Messages

Use Conventional Commits:

```text
<type>(<scope>): <summary>

<body>
```

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
- Summary in the imperative mood, at most 72 characters.
- Explain why in the body, not what the diff already shows.
- Do not include AI process narration, pasted logs, or generated file lists.

## Agent Tooling

- `.opencode/agents/commit-reviewer.md` — read-only reviewer subagent. It may write only `.agents/state/commit-review/`.
- `.opencode/plugins/commit-review/index.js` — OpenCode permission hook that detects `git commit`, checks or creates the review task, and allows or denies the commit.
- `scripts/commit-review/lib.mjs` — binding, parsing, prompt, and dossier validation logic.
- `scripts/commit-review/lib.test.mjs` — unit tests for the gate library.
- `.opencode/plugins/commit-review/index.test.js` — adapter tests with a fake OpenCode context.

When changing the gate:

- Keep the reviewer read-only except for its dossier.
- Keep the fail-closed behavior. A missing, malformed, stale, or unbound dossier must deny the commit.
- Keep `findings` blocking and `advisories` non-blocking.
- Add or update tests for every binding and failure path.
- Do not let the reviewer edit the code it reviews.

## Boundaries

The commit review gate is a local workflow check, not a security boundary.

- It only sees commits made through OpenCode's shell tool.
- Commits from a terminal outside OpenCode are not gated.
- A user with filesystem access can edit or remove the plugin.
- The reviewer is an LLM. It can miss issues or produce a false positive.
- The gate reduces risk; it does not replace tests, CI, or human review.

State these limits when describing the gate. Do not oversell it.

## Asking the User

Ask before:

- changing the public API or a delivery contract,
- adding a production dependency,
- deleting data or rewriting history,
- weakening the commit review gate,
- making a change that conflicts with the architecture documents.

Otherwise, continue with the next workflow step without asking.
