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
  hasNoVerify,
  isDocsOnly,
  isGitCommit,
  parseSkipReason,
  validateDossier,
} from "../../../scripts/commit-review/lib.mjs";

const MAX_DOSSIER_AGE_MS = 5 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const SPLIT_WAIVER_TTL_MS = 30 * 60 * 1000;
const WAIVER_DIR = path.join(STATE_DIR, "waivers");
const PENDING_DIR = path.join(STATE_DIR, "pending");

function deny(event, message) {
  event.effect = "deny";
  event.message = message;
}

async function recordWaiver(repoRoot, kind, reason, binding, extra = {}) {
  const waiversDir = path.join(repoRoot, WAIVER_DIR);
  const waiverPath = path.join(
    waiversDir,
    `${kind}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.json`,
  );
  await mkdir(waiversDir, { recursive: true });
  const record = {
    schema_version: 1,
    kind,
    reason,
    branch: binding?.branch ?? "unknown",
    head: binding?.head ?? "unknown",
    diff_hash: binding?.diffHash ?? "",
    command_hash: binding?.commandHash ?? "",
    files: binding?.files ?? [],
    created_at: new Date().toISOString(),
    ...extra,
  };
  await writeFile(waiverPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path.relative(repoRoot, waiverPath);
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

async function findSplitWaiver(repoRoot, binding) {
  const dir = path.join(repoRoot, WAIVER_DIR);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const [raw, details] = await Promise.all([
        readFile(path.join(dir, entry.name), "utf8"),
        stat(path.join(dir, entry.name)),
      ]);
      if (Date.now() - details.mtimeMs > SPLIT_WAIVER_TTL_MS) continue;
      const waiver = JSON.parse(raw);
      if (waiver.kind !== "split") continue;
      if (
        waiver.branch === binding.branch &&
        waiver.head === binding.head &&
        waiver.diff_hash === binding.diffHash &&
        waiver.command_hash === binding.commandHash
      ) {
        return waiver;
      }
    } catch {
      // Ignore malformed waiver records.
    }
  }
  return null;
}

async function writeReviewTask(repoRoot, binding, command, { oversized = false } = {}) {
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
    files: binding.files,
    oversized,
    requested_at: new Date().toISOString(),
  };
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

  const prompt = buildPrompt({
    requestPath: path.relative(repoRoot, requestPath),
    diffPath: path.relative(repoRoot, diffPath),
    dossierPath: path.relative(repoRoot, dossierPath),
    binding,
    oversized,
  });
  await writeFile(taskPath, prompt, "utf8");

  return {
    runDir,
    taskPath: path.relative(repoRoot, taskPath),
    dossierPath: path.relative(repoRoot, dossierPath),
  };
}

function handoffMessage(review) {
  return [
    "Commit review required before this commit.",
    "",
    `1. Read ${review.taskPath}.`,
    `2. Send its contents to the ${REVIEW_AGENT} subagent (subagent tool, agent "${REVIEW_AGENT}").`,
    "3. After the reviewer writes PASS, retry the exact same commit command.",
    "",
    "The gate consumes a PASS once. A FAIL returns findings; fix them, stage the changes, and retry.",
    `Dossier: ${review.dossierPath}`,
  ].join("\n");
}

async function writePendingSplitRequest(repoRoot, binding, command) {
  const id = `split-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const dir = path.join(repoRoot, PENDING_DIR, id);
  const diffPath = path.join(dir, "diff.patch");
  const requestPath = path.join(dir, "request.json");
  await mkdir(dir, { recursive: true });
  await writeFile(diffPath, binding.diff, "utf8");
  const request = {
    schema_version: 1,
    id,
    repo_root: repoRoot,
    branch: binding.branch,
    head: binding.head,
    command,
    command_hash: binding.commandHash,
    diff_hash: binding.diffHash,
    diff_path: path.relative(repoRoot, diffPath),
    diff_bytes: Buffer.byteLength(binding.diff, "utf8"),
    files: binding.files,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
  };
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return { id, dir, requestPath };
}

async function readPendingSplitRequest(repoRoot, id) {
  if (!/^split-[a-z0-9-]+$/.test(id)) {
    return { ok: false, reason: "invalid waiver id" };
  }
  const dir = path.join(repoRoot, PENDING_DIR, id);
  try {
    const request = JSON.parse(await readFile(path.join(dir, "request.json"), "utf8"));
    if (request.id !== id) return { ok: false, reason: "waiver id mismatch" };
    if (Date.parse(request.expires_at) < Date.now()) {
      return { ok: false, reason: "waiver request expired" };
    }
    return { ok: true, request, dir };
  } catch {
    return { ok: false, reason: "waiver request not found" };
  }
}

function splitPromptMessage(id, diffBytes) {
  return [
    `Commit review gate: the staged diff is ${diffBytes} bytes, above the ` +
      `${MAX_DIFF_BYTES}-byte split threshold.`,
    "",
    "Option A: split the commit into smaller commits and review each one.",
    "Option B: have the user send this prompt to waive the split check for this exact diff:",
    "",
    `  /commit-review waive split ${id} <one-line reason>`,
    "",
    `The request expires in 10 minutes. It skips only the split check; the independent review still runs.`,
  ].join("\n");
}

async function gateCommit(event, command, repoRoot) {
  if (hasNoVerify(command)) {
    const reason = parseSkipReason(command);
    if (!reason) {
      return deny(
        event,
        [
          "Commit review skip requires an explicit reason.",
          "",
          "Retry with:",
          '  COMMIT_REVIEW_SKIP_REASON="why this commit must skip review" git commit --no-verify ...',
          "",
          "The skip is recorded under .agents/state/commit-review/waivers/.",
        ].join("\n"),
      );
    }
    let binding = null;
    try {
      binding = computeBinding(repoRoot, command);
    } catch {
      // A skip is still recorded when the diff cannot be bound.
    }
    const waiver = await recordWaiver(repoRoot, "skip", reason, binding, {
      source: "command",
    });
    console.log(`[commit-review] SKIP (${reason}) waiver=${waiver}`);
    return;
  }

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

  if (isDocsOnly(binding.files)) {
    const waiver = await recordWaiver(
      repoRoot,
      "docs",
      "documentation-only commit",
      binding,
      { source: "automatic" },
    );
    console.log(`[commit-review] DOCS waiver=${waiver} files=${binding.files.length}`);
    return;
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

  const diffBytes = Buffer.byteLength(binding.diff, "utf8");
  if (diffBytes > MAX_DIFF_BYTES) {
    const waiver = await findSplitWaiver(repoRoot, binding);
    if (!waiver) {
      const pending = await writePendingSplitRequest(repoRoot, binding, command);
      return deny(event, splitPromptMessage(pending.id, diffBytes));
    }
    const review = await writeReviewTask(repoRoot, binding, command, { oversized: true });
    return deny(event, handoffMessage(review));
  }

  const review = await writeReviewTask(repoRoot, binding, command);
  return deny(event, handoffMessage(review));
}

async function handleWaiverPrompt(event, ctx) {
  const text = event.prompt?.text ?? "";
  const match = text.match(/^\s*\/?commit-review\s+waive\s+split\s+(\S+)\s+(.+?)\s*$/is);
  if (!match) return;

  const [, id, rawReason] = match;
  const reason = rawReason.trim();
  const repoRoot = ctx.location?.directory;
  if (!repoRoot) return;
  if (reason.length < 3) {
    event.prompt.text = "Split waiver rejected: include a one-line reason after the waiver id.";
    return;
  }

  const pending = await readPendingSplitRequest(repoRoot, id);
  if (!pending.ok) {
    event.prompt.text = `Split waiver ${id} is not available: ${pending.reason}. Retry the commit to create a new request.`;
    return;
  }

  let binding;
  try {
    binding = computeBinding(repoRoot, pending.request.command);
  } catch (error) {
    event.prompt.text =
      "Split waiver rejected: the staged diff cannot be read. Retry the commit to create a new request.\n" +
      `${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  if (
    binding.branch !== pending.request.branch ||
    binding.head !== pending.request.head ||
    binding.diffHash !== pending.request.diff_hash ||
    binding.commandHash !== pending.request.command_hash
  ) {
    event.prompt.text =
      "Split waiver rejected: the staged diff or commit command changed. Retry the commit to create a new request.";
    return;
  }

  const waiver = await recordWaiver(repoRoot, "split", reason, binding, {
    source: "user-prompt",
    pending_id: id,
  });
  await rm(pending.dir, { recursive: true, force: true }).catch(() => {});
  event.metadata = {
    ...(event.metadata ?? {}),
    commitReviewWaiver: { id, kind: "split", path: waiver },
  };
  event.prompt.text = [
    `Split waiver ${id} recorded for the staged diff.`,
    "",
    "Retry the exact commit command:",
    "",
    `  ${pending.request.command}`,
    "",
    "The independent review still runs. The gate will hand off the review task.",
  ].join("\n");
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

      try {
        await gateCommit(event, command, repoRoot);
      } catch (error) {
        deny(
          event,
          "Commit review gate failed: " +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "Fix the gate or use the explicit skip path.",
        );
      }
    });

    await ctx.session.hook("prompt", async (event) => {
      try {
        await handleWaiverPrompt(event, ctx);
      } catch (error) {
        event.prompt.text =
          "Commit review waiver failed: " +
          `${error instanceof Error ? error.message : String(error)}. ` +
          "Retry the waiver prompt or use the explicit skip path.";
      }
    });
  },
};
