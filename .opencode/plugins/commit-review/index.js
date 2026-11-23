import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MAX_DIFF_BYTES,
  REVIEW_AGENT,
  STATE_DIR,
  assessCommitCommand,
  buildPrompt,
  computeBinding,
  formatReviewMessage,
  isGitCommit,
  validateDossier,
} from "../../../scripts/commit-review/lib.mjs";

const MAX_DOSSIER_AGE_MS = 5 * 60 * 60 * 1000;

function deny(event, message) {
  event.effect = "deny";
  event.message = message;
}

async function findMatchingDossier(repoRoot, binding) {
  const root = path.join(repoRoot, STATE_DIR);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dossierPath = path.join(root, entry.name, "dossier.json");
    try {
      const [raw, details] = await Promise.all([
        readFile(dossierPath, "utf8"),
        stat(dossierPath),
      ]);
      if (Date.now() - details.mtimeMs > MAX_DOSSIER_AGE_MS) continue;
      const result = validateDossier(JSON.parse(raw), binding);
      if (!result.ok) continue;
      matches.push({ dossierPath, result, mtime: details.mtimeMs });
    } catch {
      // A missing, unreadable, or malformed dossier is not evidence.
    }
  }

  matches.sort((left, right) => right.mtime - left.mtime);
  return matches[0] ?? null;
}

async function writeReviewTask(repoRoot, binding, command) {
  const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(repoRoot, STATE_DIR, runId);
  const diffPath = path.join(runDir, "diff.patch");
  const requestPath = path.join(runDir, "request.json");
  const dossierPath = path.join(runDir, "dossier.json");
  const taskPath = path.join(runDir, "task.md");

  await mkdir(runDir, { recursive: true });
  await writeFile(diffPath, binding.diff, "utf8");

  const request = {
    schema_version: 1,
    run_id: runId,
    repo_root: repoRoot,
    branch: binding.branch,
    head: binding.head,
    command,
    command_hash: binding.commandHash,
    diff_hash: binding.diffHash,
    diff_path: path.relative(repoRoot, diffPath),
    dossier_path: path.relative(repoRoot, dossierPath),
    diff_bytes: Buffer.byteLength(binding.diff, "utf8"),
    requested_at: new Date().toISOString(),
  };
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

  const prompt = buildPrompt({
    requestPath: path.relative(repoRoot, requestPath),
    diffPath: path.relative(repoRoot, diffPath),
    dossierPath: path.relative(repoRoot, dossierPath),
    binding,
  });
  await writeFile(taskPath, prompt, "utf8");

  return {
    runDir,
    taskPath: path.relative(repoRoot, taskPath),
    dossierPath: path.relative(repoRoot, dossierPath),
  };
}

async function gateCommit(event, command, repoRoot) {
  const assessment = assessCommitCommand(command);
  if (!assessment.ok) {
    return deny(event, `Commit review gate: ${assessment.reason}`);
  }
  if (assessment.skipped) return;

  let binding;
  try {
    binding = computeBinding(repoRoot, command);
  } catch (error) {
    return deny(
      event,
      `Commit review gate could not read the staged diff: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!binding.diff.trim()) return;

  const diffBytes = Buffer.byteLength(binding.diff, "utf8");
  if (diffBytes > MAX_DIFF_BYTES) {
    return deny(
      event,
      `Commit review gate: the staged diff is ${diffBytes} bytes, above the ` +
        `${MAX_DIFF_BYTES}-byte review limit. Split the commit or review it manually.`,
    );
  }

  const existing = await findMatchingDossier(repoRoot, binding);
  if (existing) {
    if (existing.result.verdict === "PASS") {
      await rm(existing.dossierPath, { force: true }).catch(() => {});
      console.log(
        `[commit-review] PASS for ${binding.branch}@${binding.head.slice(0, 7)} ` +
          `(${existing.result.advisories.length} advisory(ies))`,
      );
      return;
    }
    return deny(event, formatReviewMessage(existing.result));
  }

  const review = await writeReviewTask(repoRoot, binding, command);
  return deny(
    event,
    [
      "Commit review required before this commit.",
      "",
      `1. Read ${review.taskPath}.`,
      `2. Send its contents to the ${REVIEW_AGENT} subagent (subagent tool, agent "${REVIEW_AGENT}").`,
      "3. After the reviewer writes PASS, retry the exact same commit command.",
      "",
      "The gate consumes a PASS once. A FAIL returns findings; fix them, stage the changes, and retry.",
      `Dossier: ${review.dossierPath}`,
    ].join("\n"),
  );
}

export default {
  id: "commit-review",
  async setup(ctx) {
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.action !== "shell") return;
      if (event.agent === REVIEW_AGENT) return;

      const command = (event.resources ?? []).find((resource) => isGitCommit(resource));
      if (!command) return;

      const repoRoot = ctx.location?.directory;
      if (!repoRoot) {
        deny(event, "Commit review gate: the OpenCode location has no directory.");
        return;
      }

      await gateCommit(event, command, repoRoot);
    });
  },
};
