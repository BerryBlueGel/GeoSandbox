import type { RecoveryPoint } from "./recovery";

export interface StorageOverview {
  directory: string;
  categories: Record<string, { bytes: number; files: number; skipped: number }>;
  recoveryBytes: number;
  recoveryLimitBytes: number;
  diskFreeBytes: number;
  totalCheckpoints: number;
  protectedCount: number;
  blocked: string[];
  points: Array<RecoveryPoint & { protected: boolean }>;
}
export interface CleanupSelection {
  checkpointIds: string[];
  orphanedFiles: boolean;
}
export interface CleanupPlan {
  fingerprint: string;
  files: Array<{ path: string; bytes: number; reason: string }>;
  reclaimableBytes: number;
  selectedCount: number;
  retainedCount: number;
  protectedCount: number;
  recentOrphans: number;
  hasMoreCandidates: boolean;
  blocked: string[];
}
export interface CleanupReceipt {
  id: string;
  fingerprint: string;
  status: "running" | "completed" | "partial" | "interrupted";
  removedBytes: number | null;
  removedFiles: number | null;
  message: string;
}
const base = "/sandbox-api/storage";
export async function storageJson(response: Response) {
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof value?.detail === "string" ? value.detail : "存储管理请求失败"
    );
  return value;
}

/** Once deletion starts, recover its receipt by ID; never repeat the POST. */
export async function executeStorageCleanup(
  id: string,
  selection: CleanupSelection,
  plan: CleanupPlan
): Promise<CleanupReceipt> {
  let receipt: CleanupReceipt;
  let response: Response | undefined;
  try {
    response = await fetch(`${base}/cleanup/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...selection, fingerprint: plan.fingerprint }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    // Recover below; a transport failure says nothing about whether deletion started.
  }
  if (response && response.status < 500) {
    receipt = await storageJson(response); // Known validation errors did no deletion.
  } else {
    try {
      receipt = await storageJson(
        await fetch(`${base}/receipts/${id}`, {
          signal: AbortSignal.timeout(30000),
        })
      );
    } catch {
      throw new Error(
        `清理状态未确认，请按编号 ${id} 核对 D 盘回执并重新扫描；不要重复执行旧清单。`
      );
    }
  }
  try {
    const signal = AbortSignal.timeout(15000);
    while (receipt.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      signal.throwIfAborted();
      receipt = await storageJson(
        await fetch(`${base}/receipts/${id}`, { signal })
      );
    }
  } catch {
    throw new Error(`清理状态未确认，请按编号 ${id} 核对 D 盘回执并重新扫描。`);
  }
  if (receipt.id !== id || receipt.fingerprint !== plan.fingerprint)
    throw new Error(`清理回执无法匹配，请按编号 ${id} 核对 D 盘记录。`);
  return receipt;
}

export function storageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}
