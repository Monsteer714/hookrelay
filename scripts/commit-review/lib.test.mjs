import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assessCommitCommand,
  computeBinding,
  formatReviewMessage,
  isGitCommit,
  sha256,
  validateDossier,
} from "./lib.mjs";

test("isGitCommit recognizes commit invocations and ignores lookalikes", () => {
  assert.equal(isGitCommit('git commit -m "feat: add API"'), true);
  assert.equal(isGitCommit("git -C /tmp/repo commit -m fix"), true);
  assert.equal(isGitCommit("git commit --amend --no-edit"), true);
  assert.equal(isGitCommit('echo "git commit"'), false);
  assert.equal(isGitCommit("git status"), false);
  assert.equal(isGitCommit("git commit --dry-run"), false);
  assert.equal(isGitCommit("git commit --help"), false);
});

test("assessCommitCommand rejects commit forms the gate cannot bind", () => {
  assert.deepEqual(assessCommitCommand('git commit -m "fix"'), { ok: true });
  assert.equal(assessCommitCommand('git commit -am "fix"').ok, false);
  assert.equal(assessCommitCommand('git commit --all -m "fix"').ok, false);
  assert.equal(assessCommitCommand("git commit --amend --no-edit").ok, false);
  assert.equal(assessCommitCommand("git commit internal/api/main.go").ok, false);
  assert.equal(assessCommitCommand("git commit -- internal/api/main.go").ok, false);
  assert.deepEqual(assessCommitCommand("git commit --dry-run"), { ok: true, skipped: true });
});

test("computeBinding binds the staged diff and hashes it", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "hookrelay-review-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await writeFile(path.join(repo, "main.go"), "package main\n\nfunc main() {}\n");
    execFileSync("git", ["-C", repo, "add", "main.go"]);

    const binding = computeBinding(repo, 'git commit -m "feat: add main"');
    assert.equal(binding.branch, "main");
    assert.equal(binding.head, "ROOT");
    assert.match(binding.diffHash, /^[0-9a-f]{64}$/);
    assert.match(binding.commandHash, /^[0-9a-f]{64}$/);
    assert.match(binding.diff, /main\.go/);
    assert.equal(binding.diffHash, sha256(binding.diff));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("validateDossier accepts a bound PASS and rejects mismatches", () => {
  const binding = {
    branch: "main",
    head: "a".repeat(40),
    diffHash: "b".repeat(64),
    commandHash: "c".repeat(64),
  };
  const base = {
    schema_version: 1,
    verdict: "PASS",
    branch: binding.branch,
    head: binding.head,
    diff_hash: binding.diffHash,
    command_hash: binding.commandHash,
    findings: [],
    advisories: ["low: consider a smaller helper"],
  };

  assert.deepEqual(validateDossier(base, binding), {
    ok: true,
    verdict: "PASS",
    findings: [],
    advisories: ["low: consider a smaller helper"],
  });

  assert.equal(validateDossier({ ...base, findings: ["high: bug"] }, binding).ok, false);
  assert.equal(validateDossier({ ...base, diff_hash: "d".repeat(64) }, binding).ok, false);
  assert.equal(validateDossier({ ...base, branch: "other" }, binding).ok, false);
  assert.equal(validateDossier({ ...base, head: "e".repeat(40) }, binding).ok, false);
  assert.equal(validateDossier({ ...base, verdict: "FAIL" }, binding).ok, false);
});

test("validateDossier requires findings for FAIL and ignores advisories for PASS", () => {
  const binding = {
    branch: "main",
    head: "a".repeat(40),
    diffHash: "b".repeat(64),
    commandHash: "c".repeat(64),
  };
  const fail = {
    schema_version: 1,
    verdict: "FAIL",
    branch: binding.branch,
    head: binding.head,
    diff_hash: binding.diffHash,
    command_hash: binding.commandHash,
    findings: ["high: missing timeout"],
    advisories: [],
  };
  assert.equal(validateDossier(fail, binding).ok, true);
  assert.equal(validateDossier({ ...fail, findings: [] }, binding).ok, false);
});

test("formatReviewMessage keeps advisories non-blocking", () => {
  const message = formatReviewMessage({
    findings: ["high: missing retry bound"],
    advisories: ["low: rename helper"],
  });
  assert.match(message, /Commit review FAILED/);
  assert.match(message, /Findings \(blocking\)/);
  assert.match(message, /Advisories \(non-blocking\)/);
  assert.match(message, /missing retry bound/);
  assert.match(message, /rename helper/);
});
