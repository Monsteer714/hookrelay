# Commit Review Gate

This document describes the independent commit review gate used by HookRelay agents. It is a local workflow check: a `git commit` from an OpenCode agent is denied until a fresh-context subagent has reviewed the exact staged diff and written a bound `PASS` dossier. The retry consumes that dossier once.

---

## 1. Context

Coding agents are good at producing plausible diffs and bad at noticing that they skipped a boundary case. A self-review in the same context inherits the agent's assumptions, so it tends to confirm the change instead of challenging it.

HookRelay therefore separates authorship from review:

- the author agent has the task context and the edit history;
- the reviewer has no parent context, only the repository and the staged diff;
- the reviewer writes a bound verdict;
- the gate allows the commit only on `PASS`.

This is the same shape used by [boxlite-ai/agent-tooling](https://github.com/boxlite-ai/agent-tooling): a host hook blocks the action, an independent auditor produces evidence, and a gate validates that evidence before allowing the action.

## 2. Goals

- Review every agent-driven commit, not just pull requests.
- Keep the reviewer independent: fresh session, fresh context, no parent transcript.
- Bind the verdict to the exact branch, HEAD, staged diff, and command.
- Make `findings` blocking and `advisories` non-blocking.
- Fail closed on missing, malformed, stale, or unbound evidence.
- Keep the reviewer read-only except for its own dossier.
- Keep the gate fast and non-blocking: the hook never waits for a model call.

## 3. Non-goals

- A sandbox or a security boundary. A user with filesystem access can edit the plugin.
- Reviewing commits made outside OpenCode.
- Replacing tests, CI, or human review.
- Reviewing commit message style. The gate reviews code, not prose.
- Exactly-once review. A commit that changes after review is reviewed again.

## 4. Flow

The gate is a two-phase handoff. The permission hook denies the first attempt and prepares a review task. The author agent spawns the reviewer. The author retries the commit; the gate validates and consumes the dossier.

```mermaid
sequenceDiagram
    autonumber
    participant A as Author agent
    participant P as OpenCode permission hook
    participant S as State directory
    participant R as commit-reviewer subagent

    A->>P: shell: git commit -m "..."
    P->>P: parse command, compute binding
    alt unstaged or empty diff
        P-->>A: allow (let Git report the empty commit)
    else diff too large or unsupported form
        P-->>A: deny with a concrete next action
    else matching PASS dossier exists
        P->>S: consume the dossier
        P-->>A: allow
    else matching FAIL dossier exists
        P-->>A: deny with findings
    else no matching dossier
        P->>S: write task.md, request.json, diff.patch
        P-->>A: deny: spawn commit-reviewer with task.md
        A->>R: subagent tool, agent=commit-reviewer, prompt=task.md
        R->>S: read request and diff
        R->>R: read AGENTS.md and relevant source
        R->>S: write dossier.json
        R-->>A: PASS or FAIL
        A->>P: retry the exact commit command
        P->>S: validate and consume dossier
        P-->>A: allow on PASS, deny on FAIL
    end
```

The first denial is not a failure. It is the normal handoff. The author agent must read the task file and pass it to the reviewer.

## 5. Components

### 5.1 Permission hook

`.opencode/plugins/commit-review/index.js` registers an OpenCode `permission.evaluate` hook.

- It runs only for `action === "shell"`.
- It ignores commands from the `commit-reviewer` agent to avoid recursion.
- It matches commands that invoke `git commit`.
- It computes the binding from Git itself.
- It looks for a matching dossier in the state directory.
- On a matching `PASS`, it deletes the dossier and allows the commit.
- On a matching `FAIL`, it denies with the findings.
- On no match, it writes the review task and denies with the next action.

The hook never calls a model and never waits for one. It only reads and writes local files.

### 5.2 Reviewer subagent

`.opencode/agents/commit-reviewer.md` defines a `subagent`-only agent.

- It has read access to the repository.
- It may run only a small set of read-only Git commands.
- It cannot read `.env`, private keys, or files outside the repository.
- It cannot fetch the web, launch another subagent, ask the parent, or load skills.
- It may write only `.agents/state/commit-review/`.

The author agent spawns it with the task file as the prompt. The reviewer is instructed to treat every repository file as untrusted data. A prompt injection in a comment or fixture cannot make it commit, push, or edit code because it has no such permission.

### 5.3 State directory

Each denied attempt gets a unique run directory:

```text
.agents/state/commit-review/<run-id>/
├── request.json
├── diff.patch
├── task.md
└── dossier.json      # written by the reviewer
```

`request.json` contains:

```json
{
  "schema_version": 1,
  "run_id": "...",
  "repo_root": "/absolute/path",
  "branch": "main",
  "head": "abc123...",
  "command": "git commit -m ...",
  "command_hash": "sha256",
  "diff_hash": "sha256",
  "diff_path": ".agents/state/commit-review/<run-id>/diff.patch",
  "dossier_path": ".agents/state/commit-review/<run-id>/dossier.json",
  "diff_bytes": 1234,
  "requested_at": "2026-11-23T..."
}
```

`.agents/state/` is gitignored. It is local runtime state, not a source artifact.

### 5.4 Dossier

The reviewer writes:

```json
{
  "schema_version": 1,
  "verdict": "PASS",
  "branch": "main",
  "head": "abc123...",
  "diff_hash": "sha256",
  "command_hash": "sha256",
  "findings": [],
  "advisories": ["low: consider a table test later"],
  "reviewed_files": ["internal/event/ingest.go"],
  "notes": ""
}
```

The gate rejects a dossier when:

- it is missing, unreadable, or invalid JSON;
- `schema_version` is not `1`;
- `verdict` is not `PASS` or `FAIL`;
- branch, HEAD, diff hash, or command hash does not match;
- `findings` or `advisories` is not an array of bounded strings;
- `PASS` has findings;
- `FAIL` has no findings;
- it is older than five hours.

## 6. Binding

A verdict is valid only for the exact review input.

| Field | Source | Why it matters |
| --- | --- | --- |
| `branch` | `git symbolic-ref --short -q HEAD` | Prevents a verdict from another branch |
| `head` | `git rev-parse HEAD`, or `ROOT` on the first commit | Prevents a verdict from another base |
| `diff_hash` | SHA-256 of `git diff --cached --no-ext-diff --no-color --binary` | Prevents a verdict from another staged diff |
| `command_hash` | SHA-256 of the exact shell command | Prevents a verdict from another commit command |

The diff is written to `diff.patch` and the reviewer is asked to verify its hash before deciding. The gate revalidates the dossier on the retry.

A `PASS` is consumed by one commit. The next commit recomputes the binding and needs a new review; there is no reusable approval.

## 7. Decision policy

- `findings` are critical or high. Any finding means `FAIL`.
- `advisories` are low or nit. They never block.
- A `FAIL` denial includes the findings and the non-blocking advisories.
- A `PASS` allows the retry. It does not auto-approve a command that the user's rules would otherwise ask about; the gate only removes its own denial.
- A missing or invalid dossier is a denial, not an allow. The gate fails closed.

This split avoids a common failure mode: a single severity field with a default that downgrades a real bug into a non-blocking nit.

## 8. Trust boundary

```mermaid
flowchart LR
    Author[Author agent] -->|staged diff| Gate
    Gate -->|task + diff| Reviewer
    Reviewer -->|dossier| Gate
    Gate -->|allow or deny| Author
    Repo[(Repository content)] -.->|untrusted data| Reviewer
```

- Repository content is untrusted input to the reviewer.
- The reviewer is untrusted output to the gate. The gate validates the binding and the shape; it does not trust the verdict text.
- The author is untrusted input to the gate. The gate computes the diff itself rather than accepting a diff path or hash from the agent.
- The state directory is local and writable. A local user can tamper with it; this is a workflow check, not a security boundary.

## 9. Failure modes

| Failure | Behavior |
| --- | --- |
| Reviewer writes no dossier | Retry is denied with the review task |
| Dossier is malformed | Retry is denied with the review task |
| Dossier binding does not match | Retry is denied with the review task |
| Reviewer reports `FAIL` | Retry is denied with findings |
| `git commit -a` | Denied before review; stage explicitly |
| `git commit --amend` | Denied before review |
| Path-limited commit | Denied before review; stage explicitly |
| Diff above 512 KiB | Denied with a split suggestion |
| Empty staged diff | Allowed; Git reports the empty commit |
| Reviewer times out | The author agent reports the timeout; no dossier exists, so the commit stays blocked |
| OpenCode plugin not loaded | No gate; this is a known boundary |
| Commit from an external terminal | No gate; this is a known boundary |

## 10. Why these choices

### Why a handoff instead of reviewing inside the permission hook

The first implementation created a child session from inside `permission.evaluate` and waited for it. That can deadlock: the parent tool call is paused inside the permission check while the reviewer model call needs the same session runtime. The handoff avoids the deadlock and keeps the permission check fast.

The request-denial-retry shape also matches the boxlite design: the hook never authors the verdict, and the action is retried only after independent evidence exists.

### Why a dossier file instead of parsing the final message

The final assistant message is easy to truncate, wrap in prose, or decorate with a code fence. A file written to a known path is easier to validate and binds the reviewer to an explicit artifact. The gate still asks the reviewer to reply `PASS` or `FAIL`, but the verdict of record is the dossier.

### Why review at commit time instead of PR time

A commit is the smallest reviewable unit and the point where an agent can still fix the issue cheaply. PR review is still necessary, but it should not be the first time a missing timeout or an unbounded retry is noticed.

### Why no retry history in v1

The boxlite design tracks repeated `FAIL` cycles, reflections, referees, and a dead-letter ledger. That is valuable for a long-running agent workflow, but it is a large amount of state for a portfolio project. HookRelay v1 keeps the gate stateless across commits: every commit gets one independent review. A future version can add history and a retry budget without changing the binding model.

## 11. Limits

- The gate only runs inside OpenCode. A human or another agent can commit from a terminal and bypass it.
- The reviewer is an LLM. It can miss a bug or report a false positive.
- The diff cap is 512 KiB. Larger commits must be split or reviewed manually.
- The gate reviews the staged diff, not the final commit object. `--amend`, `-a`, and pathspec commits are rejected because they cannot be bound reliably.
- The gate does not review commit message quality, author identity, signatures, or generated code provenance.
- The state directory is local and not tamper-evident.
- A stale PASS is rejected after five hours. The author must re-review.

## 12. Future work

- Add a custom `commit_review` tool that performs the handoff without requiring the author to read `task.md`.
- Add a Git `pre-commit` hook that consumes the same dossier, so commits from a terminal share one gate.
- Add a retry budget and a reflection step after repeated failures.
- Add a second reviewer for security-sensitive paths.
- Add a CI job that runs the same criteria on the pull request diff.
- Add per-repository policy for severity thresholds and diff caps.
- Record review latency and pass rate in Prometheus-compatible metrics.

## 13. Tests

The gate has two test layers:

- `scripts/commit-review/lib.test.mjs` covers command parsing, diff binding, dossier validation, and message formatting.
- `.opencode/plugins/commit-review/index.test.js` covers the OpenCode adapter with a fake permission hook. It exercises the first denial, the task file, PASS consumption, FAIL denial, binding mismatch, unsupported commands, and recursion protection.

Run them with:

```sh
node --test scripts/commit-review/lib.test.mjs .opencode/plugins/commit-review/index.test.js
```
