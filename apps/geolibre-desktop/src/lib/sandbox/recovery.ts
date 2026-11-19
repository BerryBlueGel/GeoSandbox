import { redactCredentials, type GeoLibreProject } from "@geolibre/core";
import { collectProjectResources, type ResourceCache } from "./bundle";

export interface RecoveryPoint {
  id: string;
  projectId?: string | null;
  name: string;
  createdAt: string;
  assetCount: number;
  layerCount: number;
  downloadUrl: string;
}
export type RecoveryStatus = {
  phase: "idle" | "scheduled" | "saving" | "saved" | "error";
  point?: RecoveryPoint;
  error?: string;
};

async function jsonResponse(response: Response) {
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(
      typeof error?.detail === "string"
        ? error.detail
        : "无法确认 D 盘恢复点写入，请检查本地服务与磁盘。"
    );
  }
  return response.json();
}

/** Reuse the portable resource manifest; only missing asset bytes cross the local API. */
export async function saveRecoveryPoint(
  project: GeoLibreProject,
  signal: AbortSignal,
  cache: ResourceCache = new Map()
): Promise<RecoveryPoint> {
  const result = await collectProjectResources(redactCredentials(project), {
    signal,
    cache,
  });
  const check = await jsonResponse(
    await fetch("/sandbox-api/checkpoints/missing-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        hashes: result.manifest.assets.map((a) => a.sha256),
      }),
    })
  );
  for (const hash of check.missing as string[]) {
    const asset = result.manifest.assets.find((a) => a.sha256 === hash);
    if (!asset) throw new Error("恢复服务返回了未知资源。");
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(result.files[asset.path])]),
      "asset.bin"
    );
    await jsonResponse(
      await fetch(`/sandbox-api/checkpoints/assets/${hash}`, {
        method: "POST",
        body: form,
        signal,
      })
    );
  }
  signal.throwIfAborted();
  return jsonResponse(
    await fetch("/sandbox-api/checkpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        project: result.project,
        manifest: result.manifest,
      }),
    })
  );
}

/** Serialize writes, coalesce edits and discard stale status after a project switch. */
export function createRecoveryController({
  snapshot,
  save,
  status,
  delay = 10000,
  maxWait = 30000,
}: {
  snapshot: () => GeoLibreProject;
  save: (
    project: GeoLibreProject,
    signal: AbortSignal
  ) => Promise<RecoveryPoint>;
  status: (value: RecoveryStatus) => void;
  delay?: number;
  maxWait?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let maximum: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let requested = false,
    disposed = false,
    epoch = 0;
  let controller: AbortController | undefined;
  const clear = () => {
    clearTimeout(timer);
    clearTimeout(maximum);
    timer = maximum = undefined;
  };
  const flush = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    clear();
    requested = true;
    if (running) return running;
    running = (async () => {
      let failure: unknown;
      while (requested && !disposed) {
        requested = false;
        const started = epoch;
        controller = new AbortController();
        status({ phase: "saving" });
        try {
          const point = await save(
            snapshot(),
            AbortSignal.any([controller.signal, AbortSignal.timeout(90000)])
          );
          if (!disposed && started === epoch) {
            status({ phase: "saved", point });
            failure = undefined;
          }
        } catch (error) {
          if (!disposed && started === epoch) {
            failure = error;
            status({
              phase: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      if (failure) throw failure;
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
  const automatic = () =>
    void flush().catch(() => {
      /* Visible status retains the error. */
    });
  const reset = () => {
    epoch++;
    requested = false;
    clear();
    controller?.abort();
    if (!disposed) status({ phase: "idle" });
  };
  return {
    flush,
    schedule() {
      if (disposed) return;
      clearTimeout(timer);
      timer = setTimeout(automatic, delay);
      maximum ??= setTimeout(automatic, maxWait);
      if (!running) status({ phase: "scheduled" });
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}
