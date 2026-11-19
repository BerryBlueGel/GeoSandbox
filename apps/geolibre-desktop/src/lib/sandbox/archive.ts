import {
  unzip,
  zip,
  type AsyncTerminable,
  type AsyncUnzipOptions,
  type Unzipped,
} from "fflate";

function codec<T>(
  start: (done: (error: Error | null, value?: T) => void) => AsyncTerminable,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let terminate: AsyncTerminable | undefined;
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) {
        terminate?.();
        reject(error);
      } else resolve(value!);
    };
    const abort = () =>
      finish(
        signal?.reason ?? new DOMException("压缩任务已取消。", "AbortError")
      );
    signal?.addEventListener("abort", abort, { once: true });
    try {
      terminate = start(finish);
      if (settled) terminate();
    } catch (error) {
      finish(error);
    }
  });
}

export function zipArchive(
  files: Record<string, Uint8Array>,
  signal?: AbortSignal
) {
  return codec<Uint8Array>((done) => zip(files, { level: 3 }, done), signal);
}

export function unzipArchive(
  bytes: Uint8Array,
  filter: NonNullable<AsyncUnzipOptions["filter"]>,
  signal?: AbortSignal
) {
  return codec<Unzipped>((done) => {
    let invalid: Error | undefined;
    const stop = unzip(
      bytes,
      {
        filter: (file) => {
          if (invalid) return false;
          try {
            return filter(file);
          } catch (error) {
            invalid = error instanceof Error ? error : new Error(String(error));
            return false;
          }
        },
      },
      (error, files) => done(invalid ?? error, files)
    );
    if (invalid) {
      stop();
      done(invalid);
    }
    return stop;
  }, signal);
}
