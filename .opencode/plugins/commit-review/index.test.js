import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import plugin from "./index.js";

async function makeRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "hookrelay-plugin-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await writeFile(path.join(repo, "main.go"), "package main\n\nfunc main() {}\n");
  execFileSync("git", ["-C", repo, "add", "main.go"]);
  return repo;
}

async function setup(repo) {
  let evaluate;
  const ctx = {
    location: { directory: repo },
    permission: {
      hook: async (name, callback) => {
        assert.equal(name, "evaluate");
        evaluate = callback;
      },
    },
  };
  await plugin.setup(ctx);
  return evaluate;
}

function commitEvent() {
  return {
    action: "shell",
    agent: "build",
    sessionID: "ses_parent",
    resources: ['git commit -m "feat: add main"'],
    effect: "allow",
  };
}

async function latestRun(repo) {
  const root = path.join(repo, ".agents/state/commit-review");
  const runs = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const run = runs.at(-1);
  assert.ok(run, "expected a review run directory");
  const request = JSON.parse(await readFile(path.join(root, run, "request.json"), "utf8"));
  return { run, root, request, dir: path.join(root, run) };
}

async function writeDossier(repo, overrides = {}) {
  const { run, request, dir } = await latestRun(repo);
  const dossier = {
    schema_version: 1,
    verdict: "PASS",
    branch: request.branch,
    head: request.head,
    diff_hash: request.diff_hash,
    command_hash: request.command_hash,
    findings: [],
    advisories: [],
    reviewed_files: ["main.go"],
    ...overrides,
  };
  await writeFile(path.join(dir, "dossier.json"), JSON.stringify(dossier, null, 2));
  return { run, dossier };
}

test("first commit is denied with a reviewer task", async () => {
  const repo = await makeRepo();
  try {
    const hook = await setup(repo);
    const event = commitEvent();
    await hook(event);
    assert.equal(event.effect, "deny");
    assert.match(event.message, /Commit review required/);
    assert.match(event.message, /commit-reviewer/);
    assert.match(event.message, /task\.md/);

    const { dir, request } = await latestRun(repo);
    const task = await readFile(path.join(dir, "task.md"), "utf8");
    const diff = await readFile(path.join(dir, "diff.patch"), "utf8");
    assert.match(task, /independent commit reviewer/);
    assert.ok(task.includes(request.diff_hash));
    assert.match(diff, /main\.go/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a bound PASS is consumed once and allows the retry", async () => {
  const repo = await makeRepo();
  try {
    const hook = await setup(repo);
    const first = commitEvent();
    await hook(first);
    assert.equal(first.effect, "deny");
    await writeDossier(repo);

    const retry = commitEvent();
    await hook(retry);
    assert.equal(retry.effect, "allow");

    const again = commitEvent();
    await hook(again);
    assert.equal(again.effect, "deny");
    assert.match(again.message, /Commit review required/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a FAIL dossier denies with findings and advisories", async () => {
  const repo = await makeRepo();
  try {
    const hook = await setup(repo);
    const first = commitEvent();
    await hook(first);
    await writeDossier(repo, {
      verdict: "FAIL",
      findings: ["high: main.go:3 does not validate input"],
      advisories: ["low: add a table test later"],
    });

    const retry = commitEvent();
    await hook(retry);
    assert.equal(retry.effect, "deny");
    assert.match(retry.message, /Commit review FAILED/);
    assert.match(retry.message, /does not validate input/);
    assert.match(retry.message, /add a table test later/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a dossier bound to another diff is ignored", async () => {
  const repo = await makeRepo();
  try {
    const hook = await setup(repo);
    const first = commitEvent();
    await hook(first);
    await writeDossier(repo, { diff_hash: "d".repeat(64) });

    const retry = commitEvent();
    await hook(retry);
    assert.equal(retry.effect, "deny");
    assert.match(retry.message, /Commit review required/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("unsupported commit forms are rejected without creating a review", async () => {
  const repo = await makeRepo();
  try {
    const hook = await setup(repo);
    const event = {
      ...commitEvent(),
      resources: ['git commit -am "feat: add main"'],
    };
    await hook(event);
    assert.equal(event.effect, "deny");
    assert.match(event.message, /git commit -a/);
    const runs = await readdir(path.join(repo, ".agents/state/commit-review")).catch(() => []);
    assert.equal(runs.length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the reviewer agent is ignored to avoid recursion", async () => {
  const repo = await makeRepo();
  try {
    const hook = await setup(repo);
    const event = { ...commitEvent(), agent: "commit-reviewer" };
    await hook(event);
    assert.equal(event.effect, "allow");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
