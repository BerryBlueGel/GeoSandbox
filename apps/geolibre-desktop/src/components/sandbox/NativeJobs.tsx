import { useCallback, useEffect, useState } from "react";
import { Button } from "@geolibre/ui";
import {
  cancelNativeJob,
  listNativeJobs,
  nativeJobLabels,
  isNativeJobActive,
  type NativeJob,
} from "../../lib/sandbox/native-jobs";

export function NativeJobs({ refreshWhen }: { refreshWhen: string }) {
  const [jobs, setJobs] = useState<NativeJob[]>([]);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setJobs(await listNativeJobs(signal));
      setError("");
    } catch (cause) {
      if (!signal?.aborted)
        setError(cause instanceof Error ? cause.message : "后台任务读取失败");
    }
  }, []);
  const active = jobs.some(isNativeJobActive);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, refreshWhen]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setInterval(() => void refresh(controller.signal), 1500);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [active, refresh]);
  return (
    <section className="space-y-3 border-t pt-4" aria-label="原生 GIS 后台任务">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">原生 GIS 后台任务</h3>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          刷新任务
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        最近 20 项未归档记录保存在 D
        盘。中断或失败后请重新选择原文件；此列表不会自动向项目添加结果。
      </p>
      {error && (
        <p role="alert" className="break-words text-xs">
          {error}
        </p>
      )}
      {!jobs.length && (
        <p className="text-xs text-muted-foreground">暂无原生 GIS 后台任务。</p>
      )}
      {jobs.map((job) => (
        <article
          key={job.id}
          className="space-y-1 rounded-md border p-3 text-xs"
        >
          <p className="break-words font-medium">
            {job.filename} · {nativeJobLabels[job.status]}
          </p>
          <p className="break-words text-muted-foreground">{job.stage}</p>
          {isNativeJobActive(job) && (
            <Button
              size="sm"
              variant="outline"
              disabled={!!stopping}
              onClick={() => {
                setStopping(job.id);
                void cancelNativeJob(job.id)
                  .then(() => refresh())
                  .catch((cause: unknown) => {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "停止未确认，请刷新核对"
                    );
                  })
                  .finally(() => setStopping(""));
              }}
            >
              {stopping === job.id ? "确认进程停止…" : "停止后台任务"}
            </Button>
          )}
        </article>
      ))}
    </section>
  );
}
