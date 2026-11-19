import { useCallback, useEffect, useState } from "react";
import { Button } from "@geolibre/ui";
import type { SandboxTaskExecute } from "../../lib/sandbox/tasks";
import {
  executeStorageCleanup,
  storageJson,
  storageSize,
  type StorageOverview,
  type CleanupPlan,
  type CleanupReceipt,
} from "../../lib/sandbox/storage";

const categoryLabels: Record<string, string> = {
  checkpoints: "恢复区（含回执/临时文件）",
  assets: "原始导入与显示预览",
  exports: "已保存成果",
  "native-jobs": "原生 GIS 任务",
  logs: "运行与验收日志",
};
export function StorageManagement({
  busy,
  executeTask,
  onChanged,
}: {
  busy: boolean;
  executeTask: SandboxTaskExecute;
  onChanged: () => void;
}) {
  const [overview, setOverview] = useState<StorageOverview>();
  const [selected, setSelected] = useState<string[]>([]);
  const [orphans, setOrphans] = useState(true);
  const [plan, setPlan] = useState<CleanupPlan>();
  const [confirmed, setConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<CleanupReceipt>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setPlan(undefined);
    setConfirmed(false);
    setError("");
    try {
      const response = await fetch("/sandbox-api/storage", {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
      const result: StorageOverview = await storageJson(response);
      if (!signal?.aborted) {
        setOverview(result);
        setSelected([]);
      }
    } catch (cause) {
      if (!signal?.aborted)
        setError(cause instanceof Error ? cause.message : "容量读取失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  const disabled = busy || loading;
  return (
    <section className="space-y-3 border-t pt-4" aria-label="存储与清理">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">存储与清理</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void refresh()}
        >
          刷新容量
        </Button>
      </div>
      {loading && (
        <p role="status" className="text-xs">
          正在核对恢复区引用与容量…
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
      {overview && (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            恢复配额已用 {storageSize(overview.recoveryBytes)} /{" "}
            {storageSize(overview.recoveryLimitBytes)}，所在磁盘可用{" "}
            {storageSize(overview.diskFreeBytes)}。
          </p>
          {overview.recoveryBytes >= overview.recoveryLimitBytes && (
            <p role="alert" className="text-xs text-destructive">
              恢复配额已满，自动恢复点暂停；清理后可重新创建。
            </p>
          )}
          <dl className="space-y-1 text-xs">
            {Object.entries(overview.categories).map(([kind, value]) => (
              <div key={kind} className="flex justify-between gap-3">
                <dt>{categoryLabels[kind]}</dt>
                <dd className="shrink-0">
                  {storageSize(value.bytes)} · {value.files} 文件
                  {value.skipped > 0 ? "（有跳过项）" : ""}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs leading-relaxed text-muted-foreground">
            按项目编号保护各项目的最新恢复点。旧版恢复点缺少编号时逐条保留。未引用资源须超过
            24 小时且近期未被保存流程使用。
          </p>
          {overview.blocked.map((message) => (
            <p key={message} role="alert" className="text-xs text-destructive">
              {message}
            </p>
          ))}
          <details>
            <summary className="cursor-pointer text-sm">
              选择旧恢复点（共 {overview.totalCheckpoints} 条，保护{" "}
              {overview.protectedCount} 条）
            </summary>
            <p className="my-2 text-xs text-muted-foreground">
              显示最早 200 条；清理后刷新可继续查看。未选择的恢复点保留。
            </p>
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {overview.points.map((point) => (
                <label
                  key={point.id}
                  className="flex items-start gap-2 rounded-md border p-2 text-xs"
                >
                  <input
                    type="checkbox"
                    aria-label={`选择清理恢复点 ${point.name} ${point.id}`}
                    disabled={
                      disabled || point.protected || !!overview.blocked.length
                    }
                    checked={selected.includes(point.id)}
                    onChange={(event) => {
                      setSelected(
                        event.target.checked
                          ? [...selected, point.id]
                          : selected.filter((id) => id !== point.id)
                      );
                      setPlan(undefined);
                      setConfirmed(false);
                    }}
                  />
                  <span className="min-w-0 break-words">
                    {point.name} ·{" "}
                    {new Date(point.createdAt).toLocaleString("zh-CN")}
                    {point.projectId
                      ? ` · 项目 ${point.projectId.slice(0, 8)}`
                      : " · 旧版"}
                    {point.protected
                      ? point.projectId
                        ? " · 最新，保留"
                        : " · 保留"
                      : ""}
                  </span>
                </label>
              ))}
            </div>
          </details>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              disabled={disabled}
              checked={orphans}
              onChange={(event) => {
                setOrphans(event.target.checked);
                setPlan(undefined);
                setConfirmed(false);
              }}
            />
            同时清理超过 24 小时的未引用文档和资源
          </label>
          <Button
            className="w-full"
            variant="outline"
            disabled={disabled || !!overview.blocked.length}
            onClick={() =>
              void executeTask(
                {
                  id: "geosandbox-storage-preview",
                  label: "预览恢复区清理",
                  record: false,
                },
                async (task) => {
                  await task.stage("核对保留恢复点与资源引用");
                  const result: CleanupPlan = await storageJson(
                    await fetch("/sandbox-api/storage/preview", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        checkpointIds: selected,
                        orphanedFiles: orphans,
                      }),
                      signal: task.signal,
                    })
                  );
                  task.commit(() => {
                    setPlan(result);
                    setConfirmed(false);
                    setReceipt(undefined);
                  });
                }
              )
            }
          >
            预览清理清单
          </Button>
          {plan && (
            <div
              className="space-y-2 rounded-md border bg-muted/30 p-3"
              aria-label="清理预览清单"
            >
              <p className="text-sm">
                本批 {plan.files.length} 个文件，预计释放{" "}
                {storageSize(plan.reclaimableBytes)}；保留 {plan.retainedCount}{" "}
                个恢复点。
              </p>
              <p className="text-xs text-muted-foreground">
                近期使用或不足 24 小时的未引用文件保留 {plan.recentOrphans} 份。
                {plan.hasMoreCandidates &&
                  "每批最多 500 个文件，完成后可重新预览。"}
              </p>
              {plan.blocked.map((message) => (
                <p
                  key={message}
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {message}
                </p>
              ))}
              {!!plan.files.length && (
                <>
                  <div className="max-h-48 space-y-2 overflow-y-auto">
                    {plan.files.map((file) => (
                      <p key={file.path} className="break-all text-xs">
                        {file.path} · {storageSize(file.bytes)}
                        <br />
                        {file.reason}
                      </p>
                    ))}
                  </div>
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    我已核对清单，永久删除列出的恢复文件（不可撤销）
                  </label>
                  <Button
                    className="w-full"
                    variant="destructive"
                    disabled={disabled || !confirmed || !!plan.blocked.length}
                    onClick={() => {
                      const id = crypto.randomUUID().replaceAll("-", "");
                      void executeTask(
                        {
                          id: "geosandbox-storage-cleanup",
                          label: "清理恢复区",
                          record: false,
                        },
                        async (task) => {
                          const result = await task.persist(
                            `执行清理并核对回执 ${id}`,
                            () =>
                              executeStorageCleanup(
                                id,
                                {
                                  checkpointIds: selected,
                                  orphanedFiles: orphans,
                                },
                                plan
                              )
                          );
                          setReceipt(result);
                          onChanged();
                          await refresh();
                          if (result.status !== "completed")
                            throw new Error(result.message);
                        }
                      ).then((ok) => {
                        if (!ok) {
                          setPlan(undefined);
                          setConfirmed(false);
                        }
                      });
                    }}
                  >
                    执行这份清理清单
                  </Button>
                </>
              )}
              {!plan.files.length && !plan.blocked.length && (
                <p className="text-xs">没有符合条件的文件；未执行删除。</p>
              )}
            </div>
          )}
          {receipt && (
            <p role="status" className="break-all text-xs">
              {receipt.message}{" "}
              {receipt.removedBytes !== null &&
                `已清理 ${receipt.removedFiles} 个文件 / ${storageSize(
                  receipt.removedBytes
                )}。`}
              回执 {receipt.id}
            </p>
          )}
          <p className="break-all text-xs text-muted-foreground">
            {overview.directory}
          </p>
        </>
      )}
    </section>
  );
}
