import { measureModel, type ModelMeasurement } from "./measure-geometry";

/** One worker per measurement: Stop terminates the actual geometry calculation. */
export async function measureModelInBackground(
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<ModelMeasurement> {
  signal?.throwIfAborted();
  if (typeof Worker === "undefined") {
    signal?.throwIfAborted();
    const result = await measureModel(bytes);
    signal?.throwIfAborted();
    return result;
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../../workers/sandbox-model-measure.ts", import.meta.url),
      { type: "module" }
    );
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(
        signal?.reason ?? new DOMException("模型测量已取消。", "AbortError")
      );
    const timeout = setTimeout(
      () => fail(new Error("模型测量超过 30 秒，请简化模型后重试。")),
      30000
    );
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (signal?.aborted) {
        abort();
        return;
      }
      if (!data || data.error || !data.measurement) {
        fail(new Error(data?.error || "模型测量结果缺失。"));
        return;
      }
      cleanup();
      resolve(data.measurement);
    };
    worker.onerror = () =>
      fail(new Error("模型测量 Worker 失败，请重新运行或检查模型。"));
    worker.onmessageerror = () => fail(new Error("模型测量结果无法读取。"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // Preserve the caller's original asset buffer.
      const data = new Uint8Array(bytes).buffer;
      worker.postMessage(data, [data]);
    } catch (error) {
      fail(error);
    }
  });
}
