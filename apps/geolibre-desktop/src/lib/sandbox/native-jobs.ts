import type { FeatureCollection } from "geojson";
import type { SandboxTaskContext } from "./tasks";

export interface NativeJob {
  id: string;
  filename: string;
  status:
    | "pending"
    | "running"
    | "cancelling"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  stage: string;
  processStopped: boolean | null;
  createdAt: number;
}

export const nativeJobLabels: Record<NativeJob["status"], string> = {
  pending: "等待",
  running: "运行中",
  cancelling: "正在停止",
  succeeded: "完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function isNativeJobActive(job: NativeJob): boolean {
  return !terminal.has(job.status);
}
export interface NativeImportResult {
  assetUrl: string;
  previewUrl: string;
  bounds: [number, number, number, number];
  sourceCrs: string;
  declaredCrs: string | null;
  crsOverridden: boolean;
  width: number;
  height: number;
  bandCount: number;
  sourceDtypes: string[];
  layers: Array<{
    name: string;
    geojson: FeatureCollection;
    sourceCrs: string;
    declaredCrs: string | null;
    crsOverridden: boolean;
  }>;
}
export interface VectorLayerInfo {
  name: string;
  geometryType: string;
  declaredCrs: string | null;
}
const base = "/sandbox-api/native-jobs";
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 300);
    signal.addEventListener("abort", abort, { once: true });
  });

async function checked(response: Response) {
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      typeof value.detail === "string" ? value.detail : "后台任务请求失败"
    );
  return value;
}
export async function listNativeJobs(
  signal?: AbortSignal
): Promise<NativeJob[]> {
  return (await checked(await fetch(base, { signal }))).jobs;
}
export async function cancelNativeJob(id: string): Promise<void> {
  const signal = AbortSignal.timeout(12000);
  let response: Response;
  try {
    response = await fetch(`${base}/${id}/cancel`, { method: "POST", signal });
  } catch {
    // A lost acknowledgment can still have stopped the process. Check the receipt.
    response = await fetch(`${base}/${id}`, { signal });
  }
  let job: NativeJob = await checked(response);
  while (!terminal.has(job.status)) {
    await pause(signal);
    job = await checked(await fetch(`${base}/${id}`, { signal }));
  }
  if (job.processStopped !== true) throw new Error("后台计算停止尚未确认");
}

async function runNativeGis<T>(
  form: FormData,
  kind: "vector" | "raster",
  task: SandboxTaskContext
): Promise<T> {
  const id = crypto.randomUUID();
  task.onCancel(() => cancelNativeJob(id));
  form.append("kind", kind);
  await task.stage("提交原生 GIS 后台任务");
  let response: Response;
  try {
    response = await fetch(`${base}/${id}`, {
      method: "POST",
      body: form,
      signal: task.signal,
    });
  } catch (error) {
    task.check();
    // Recover the known job, never duplicate a submission after a lost response.
    response = await fetch(`${base}/${id}`, { signal: task.signal });
    if (!response.ok) throw error;
  }
  let job: NativeJob = await checked(response);
  while (!terminal.has(job.status)) {
    await task.stage(job.stage);
    await pause(task.signal);
    job = await checked(await fetch(`${base}/${id}`, { signal: task.signal }));
  }
  if (job.status === "cancelled")
    throw new DOMException(job.stage, "AbortError");
  if (job.status !== "succeeded") throw new Error(job.stage);
  await task.stage("核对后台计算结果");
  const result = await checked(
    await fetch(`${base}/${id}/result`, { signal: task.signal })
  );
  task.check();
  return result;
}

export function importNativeGis(
  form: FormData,
  kind: "vector" | "raster",
  task: SandboxTaskContext
) {
  return runNativeGis<NativeImportResult>(form, kind, task);
}

export function inspectNativeVector(file: File, task: SandboxTaskContext) {
  const form = new FormData();
  form.append("file", file);
  form.append("operation", "inspect");
  return runNativeGis<{ layers: VectorLayerInfo[] }>(form, "vector", task);
}
