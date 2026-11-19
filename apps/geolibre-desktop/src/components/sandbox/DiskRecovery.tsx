import { useEffect, useState } from "react";
import { Button } from "@geolibre/ui";
import type { RecoveryPoint, RecoveryStatus } from "../../lib/sandbox/recovery";
import type { BundleInput } from "../../lib/sandbox/bundle";

const MESSAGES: Record<RecoveryStatus["phase"], string> = {
  idle: "尚未在本次会话创建磁盘恢复点。",
  scheduled:
    "编辑已进入等待队列，停止编辑约 10 秒后写入；持续编辑约 30 秒触发一次。",
  saving: "正在校验并写入磁盘恢复点…",
  saved: "恢复点已写入；这不代替手动保存项目包。",
  error: "未能确认恢复点写入；旧恢复点仍保留，可刷新列表检查。",
};
export function DiskRecovery({
  enabled,
  toggle,
  status,
  flush,
  busy,
  execute,
  openBundle,
  revision = 0,
}: {
  enabled: boolean;
  toggle: (value: boolean) => void;
  status: RecoveryStatus;
  flush: () => Promise<void>;
  busy: boolean;
  execute: (action: () => Promise<void>) => Promise<boolean>;
  openBundle: (file: BundleInput) => Promise<boolean>;
  revision?: number;
}) {
  const [points, setPoints] = useState<RecoveryPoint[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [directory, setDirectory] = useState("");
  const [bytes, setBytes] = useState(0);
  const pointId = status.point?.id;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetch("/sandbox-api/checkpoints", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("无法读取磁盘恢复点，请检查本地服务。");
        const result = await response.json();
        if (!controller.signal.aborted) {
          setPoints(result.checkpoints);
          setDirectory(result.directory);
          setBytes(result.bytes);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [pointId, refresh, revision]);
  return (
    <section className="space-y-3 border-t pt-4" aria-label="D 盘恢复点">
      <h3 className="text-sm font-semibold">D 盘恢复点</h3>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          disabled={busy}
          checked={enabled}
          onChange={(e) => toggle(e.target.checked)}
        />
        自动创建磁盘恢复点
      </label>
      <p
        role="status"
        className="text-xs leading-relaxed text-muted-foreground"
      >
        {!enabled && status.phase === "idle"
          ? "自动磁盘恢复点已关闭；已有恢复点仍可手动恢复。"
          : MESSAGES[status.phase]}
        {status.point &&
          ` ${new Date(status.point.createdAt).toLocaleString("zh-CN")}`}
      </p>
      {status.error && (
        <p role="alert" className="break-all text-xs text-destructive">
          {status.error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          disabled={busy || status.phase === "saving"}
          onClick={() => void execute(flush)}
        >
          立即创建恢复点
        </Button>
        <Button
          variant="outline"
          disabled={loading || busy}
          onClick={() => setRefresh((v) => v + 1)}
        >
          刷新恢复点
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        不依赖浏览器历史容量。显示最近 20 个恢复点，原资源按哈希去重；累计达到 2
        GiB 时暂停，不自动删除旧恢复点。当前占用{" "}
        {(bytes / 1024 / 1024).toFixed(1)} MiB。
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!loading && !error && !points.length && (
        <p className="text-xs text-muted-foreground">还没有磁盘恢复点。</p>
      )}
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {points.map((point) => (
          <div key={point.id} className="rounded-md border p-3">
            <p className="break-all text-sm font-medium">{point.name}</p>
            <p className="my-1 text-xs text-muted-foreground">
              {new Date(point.createdAt).toLocaleString("zh-CN")} ·{" "}
              {point.layerCount} 层 · {point.assetCount} 份资源
              {point.projectId
                ? ` · 项目 ${point.projectId.slice(0, 8)}`
                : " · 旧版恢复点"}
            </p>
            <Button
              className="w-full"
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={`恢复磁盘项目 ${point.name} ${point.id}`}
              onClick={() =>
                void openBundle({
                  name: point.name,
                  arrayBuffer: async (signal) => {
                    const response = await fetch(point.downloadUrl, {
                      signal: signal
                        ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
                        : AbortSignal.timeout(90000),
                    });
                    if (!response.ok) {
                      const result = await response.json().catch(() => null);
                      throw new Error(
                        result?.detail ?? "恢复点无法读取，未改变当前项目。"
                      );
                    }
                    return response.arrayBuffer();
                  },
                })
              }
            >
              校验并恢复
            </Button>
          </div>
        ))}
      </div>
      {directory && (
        <p className="break-all text-xs text-muted-foreground">{directory}</p>
      )}
    </section>
  );
}
