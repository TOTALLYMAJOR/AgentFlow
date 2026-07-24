import type { GitWorktreeRecord } from "./types.js";

export function parseWorktreePorcelain(source: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: Partial<GitWorktreeRecord> | null = null;

  for (const field of source.split("\0")) {
    if (field.length === 0) {
      if (current?.path !== undefined) {
        records.push(completeRecord({ ...current, path: current.path }));
      }
      current = null;
      continue;
    }

    const separator = field.indexOf(" ");
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? "" : field.slice(separator + 1);
    if (key === "worktree") {
      if (current?.path !== undefined) {
        records.push(completeRecord({ ...current, path: current.path }));
      }
      current = { path: value };
      continue;
    }
    if (current === null) {
      continue;
    }
    switch (key) {
      case "HEAD":
        current.headCommit = value;
        break;
      case "branch":
        current.branchReference = value;
        current.branchName = value.startsWith("refs/heads/")
          ? value.slice("refs/heads/".length)
          : null;
        break;
      case "detached":
        current.detached = true;
        break;
      case "bare":
        current.bare = true;
        break;
      case "locked":
        current.locked = true;
        current.lockReason = value.length === 0 ? null : value;
        break;
      case "prunable":
        current.prunable = true;
        current.pruneReason = value.length === 0 ? null : value;
        break;
    }
  }
  if (current?.path !== undefined) {
    records.push(completeRecord({ ...current, path: current.path }));
  }
  return records;
}

function completeRecord(
  record: Partial<GitWorktreeRecord> & { path: string },
): GitWorktreeRecord {
  return {
    path: record.path,
    headCommit: record.headCommit ?? "",
    branchReference: record.branchReference ?? null,
    branchName: record.branchName ?? null,
    detached: record.detached ?? false,
    bare: record.bare ?? false,
    locked: record.locked ?? false,
    lockReason: record.lockReason ?? null,
    prunable: record.prunable ?? false,
    pruneReason: record.pruneReason ?? null,
  };
}
