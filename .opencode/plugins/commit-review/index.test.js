import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import plugin from "./index.js";

async function makeRepoWith(files) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "hookrelay-plugin-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(repo, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  execFileSync("git", ["-C", repo, "add", "."]);
  return repo;
}

async function makeRepo() {
  return makeRepoWith({ "main.go": "package main\n\nfunc main() {}\n" });
}

async function setup(repo) {
  let permission;
  let prompt;
  const ctx = {
    location: { directory: repo },
    permission: {
      hook: async (name, callback) => {
        assert.equal(name, "evaluate");
        permission = callback;
      },
    },
    session: {
      hook: async (name, callback) => {
        assert.equal(name, "prompt");
        prompt = callback;
      },
    },
  };
  await plugin.setup(ctx);
  return { permission, prompt };
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
  const entries = await readdir(root, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "pending" || entry.name === "waivers") continue;
    try {
      await readFile(path.join(root, entry.name, "request.json"));
      runs.push(entry.name);
    } catch {
      // Not a review run.
    }
  }
  runs.sort();
  const run = runs.at(-1);
  assert.ok(run, "expected a review run directory");
  const request = JSON.parse(await readFile(path.join(root, run, "request.json"), "utf8"));
  return { run, root, request, dir: path.join(root, run) };
}

async function latestWaiver(repo) {
  const dir = path.join(repo, ".agents/state/commit-review/waivers");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  assert.ok(files.length > 0, "expected a waiver record");
  return JSON.parse(await readFile(path.join(dir, files.at(-1)), "utf8"));
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
    const hooks = await setup(repo);
    const event = commitEvent();
    await hooks.permission(event);
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
    const hooks = await setup(repo);
    const first = commitEvent();
    await hooks.permission(first);
    assert.equal(first.effect, "deny");
    await writeDossier(repo);

    const retry = commitEvent();
    await hooks.permission(retry);
    assert.equal(retry.effect, "allow");

    const again = commitEvent();
    await hooks.permission(again);
    assert.equal(again.effect, "deny");
    assert.match(again.message, /Commit review required/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a FAIL dossier denies with findings and advisories", async () => {
  const repo = await makeRepo();
  try {
    const hooks = await setup(repo);
    const first = commitEvent();
    await hooks.permission(first);
    await writeDossier(repo, {
      verdict: "FAIL",
      findings: ["high: main.go:3 does not validate input"],
      advisories: ["low: add a table test later"],
    });

    const retry = commitEvent();
    await hooks.permission(retry);
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
    const hooks = await setup(repo);
    const first = commitEvent();
    await hooks.permission(first);
    await writeDossier(repo, { diff_hash: "d".repeat(64) });

    const retry = commitEvent();
    await hooks.permission(retry);
    assert.equal(retry.effect, "deny");
    assert.match(retry.message, /Commit review required/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("unsupported commit forms are rejected without creating a review", async () => {
  const repo = await makeRepo();
  try {
    const hooks = await setup(repo);
    const event = {
      ...commitEvent(),
      resources: ['git commit -am "feat: add main"'],
    };
    await hooks.permission(event);
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
    const hooks = await setup(repo);
    const event = { ...commitEvent(), agent: "commit-reviewer" };
    await hooks.permission(event);
    assert.equal(event.effect, "allow");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("--no-verify without a reason is denied", async () => {
  const repo = await makeRepo();
  try {
    const hooks = await setup(repo);
    const event = {
      ...commitEvent(),
      resources: ['git commit --no-verify -m "feat: add main"'],
    };
    await hooks.permission(event);
    assert.equal(event.effect, "deny");
    assert.match(event.message, /explicit reason/);
    const waivers = await readdir(
      path.join(repo, ".agents/state/commit-review/waivers"),
    ).catch(() => []);
    assert.equal(waivers.length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("--no-verify with a reason records a skip waiver", async () => {
  const repo = await makeRepo();
  try {
    const hooks = await setup(repo);
    const event = {
      ...commitEvent(),
      resources: [
        'COMMIT_REVIEW_SKIP_REASON="emergency rollback" git commit --no-verify -m "feat: add main"',
      ],
    };
    await hooks.permission(event);
    assert.equal(event.effect, "allow");
    const waiver = await latestWaiver(repo);
    assert.equal(waiver.kind, "skip");
    assert.equal(waiver.reason, "emergency rollback");
    assert.equal(waiver.source, "command");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("documentation-only commits are exempt and recorded", async () => {
  const repo = await makeRepoWith({
    "README.md": "hello\n",
    "docs/architecture/README.md": "design\n",
  });
  try {
    const hooks = await setup(repo);
    const event = commitEvent();
    await hooks.permission(event);
    assert.equal(event.effect, "allow");
    const waiver = await latestWaiver(repo);
    assert.equal(waiver.kind, "docs");
    assert.equal(waiver.source, "automatic");
    assert.deepEqual(waiver.files.sort(), ["README.md", "docs/architecture/README.md"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("mixed documentation and code still requires review", async () => {
  const repo = await makeRepoWith({
    "README.md": "hello\n",
    "main.go": "package main\n\nfunc main() {}\n",
  });
  try {
    const hooks = await setup(repo);
    const event = commitEvent();
    await hooks.permission(event);
    assert.equal(event.effect, "deny");
    assert.match(event.message, /Commit review required/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("an oversized commit asks the user for a split waiver, then reviews", async () => {
  const repo = await makeRepoWith({
    "a.txt": "a".repeat(300 * 1024),
    "b.txt": "b".repeat(300 * 1024),
  });
  try {
    const hooks = await setup(repo);
    const first = commitEvent();
    await hooks.permission(first);
    assert.equal(first.effect, "deny");
    assert.match(first.message, /split threshold/);
    const match = first.message.match(/\/commit-review waive split (\S+)/);
    assert.ok(match, "expected a waiver prompt");
    const id = match[1];

    const prompt = {
      prompt: { text: `/commit-review waive split ${id} benchmark data` },
      metadata: {},
    };
    await hooks.prompt(prompt);
    assert.match(prompt.prompt.text, /Split waiver/);
    assert.match(prompt.prompt.text, /Retry the exact commit command/);

    const retry = commitEvent();
    await hooks.permission(retry);
    assert.equal(retry.effect, "deny");
    assert.match(retry.message, /Commit review required/);
    assert.match(retry.message, /task\.md/);

    await writeDossier(repo);
    const final = commitEvent();
    await hooks.permission(final);
    assert.equal(final.effect, "allow");

    const waiver = await latestWaiver(repo);
    assert.equal(waiver.kind, "split");
    assert.equal(waiver.reason, "benchmark data");
    assert.equal(waiver.source, "user-prompt");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a split waiver for a changed diff is rejected", async () => {
  const repo = await makeRepoWith({
    "a.txt": "a".repeat(300 * 1024),
    "b.txt": "b".repeat(300 * 1024),
  });
  try {
    const hooks = await setup(repo);
    const first = commitEvent();
    await hooks.permission(first);
    const id = first.message.match(/\/commit-review waive split (\S+)/)?.[1];
    assert.ok(id);

    await writeFile(path.join(repo, "a.txt"), "changed\n");
    execFileSync("git", ["-C", repo, "add", "a.txt"]);

    const prompt = {
      prompt: { text: `/commit-review waive split ${id} stale request` },
      metadata: {},
    };
    await hooks.prompt(prompt);
    assert.match(prompt.prompt.text, /staged diff or commit command changed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
