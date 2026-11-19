import { useEffect, useState } from "react";
import { Button } from "@geolibre/ui";
import type { BundleInput } from "../../lib/sandbox/bundle";
import {
  isNativeJobActive,
  nativeJobLabels,
  type NativeJob,
} from "../../lib/sandbox/native-jobs";
import { savedBundleInput } from "../../lib/sandbox/saved-project";
import { storageSize } from "../../lib/sandbox/storage";

interface ExportItem {
  exportId: string;
  name: string;
  bytes: number;
  modifiedAt: string;
  downloadUrl: string;
}
type View = "exports" | "jobs";
const PAGE_SIZE = 20;

export function ArchiveLibrary(props: {
  busy: boolean;
  revision: number;
  onChanged: () => void;
  openBundle: (file: BundleInput) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="space-y-3 border-t pt-4"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-semibold">
        任务与成果归档
      </summary>
      {expanded && <ArchiveCatalogue {...props} />}
    </details>
  );
}

function ArchiveCatalogue({
  busy,
  revision,
  onChanged,
  openBundle,
}: {
  busy: boolean;
  revision: number;
  onChanged: () => void;
  openBundle: (file: BundleInput) => Promise<boolean>;
}) {
  const [view, setView] = useState<View>("exports");
  const [archived, setArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [items, setItems] = useState<Array<ExportItem | NativeJob>>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const endpoint =
    view === "exports"
      ? "/sandbox-api/export-library"
      : "/sandbox-api/native-jobs";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setReadError("");
    void fetch(`${endpoint}?archived=${archived}&offset=${offset}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取归档列表，请检查本地服务。");
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (offset > 0 && offset >= data.total) {
          setOffset(
            Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1) * PAGE_SIZE
          );
          return;
        }
        setItems(data.items ?? data.jobs);
        setTotal(data.total);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setReadError(
          error instanceof Error ? error.message : "无法读取归档列表"
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, archived, offset, refresh, revision]);

  async function changeArchive(item: ExportItem | NativeJob) {
    setMutating(true);
    setNotice(undefined);
    const url =
      "exportId" in item
        ? `${endpoint}/${encodeURIComponent(item.exportId)}`
        : `${endpoint}/${item.id}/archive`;
    try {
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          typeof result.detail === "string"
            ? result.detail
            : "归档操作未确认，请核对列表。"
        );
      if (result.archived !== !archived)
        throw new Error("归档状态未确认，请核对列表。");
      setNotice({
        text: archived ? "已取消归档。" : "已归档，可在「已归档」列表中查看。",
      });
    } catch (error) {
      setNotice({
        text:
          error instanceof TypeError
            ? "连接中断，归档状态以刷新后的列表为准。"
            : error instanceof Error
            ? error.message
            : "归档状态未确认。",
        error: true,
      });
    } finally {
      setMutating(false);
      setRefresh((value) => value + 1);
      if ("exportId" in item) onChanged();
    }
  }

  const disabled = busy || mutating;
  return (
    <section className="space-y-3" aria-label="任务与成果归档">
      <p className="text-xs text-muted-foreground">
        归档将条目收起，文件仍在原位置，占用空间不变。
      </p>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <select
          aria-label="归档条目类型"
          className="min-w-0 rounded border bg-background px-2 py-1.5"
          disabled={disabled}
          value={view}
          onChange={(event) => {
            setLoading(true);
            setView(event.target.value as View);
            setOffset(0);
            setNotice(undefined);
          }}
        >
          <option value="exports">导出成果</option>
          <option value="jobs">原生 GIS 任务</option>
        </select>
        <select
          aria-label="归档状态"
          className="min-w-0 rounded border bg-background px-2 py-1.5"
          disabled={disabled}
          value={String(archived)}
          onChange={(event) => {
            setLoading(true);
            setArchived(event.target.value === "true");
            setOffset(0);
            setNotice(undefined);
          }}
        >
          <option value="false">未归档</option>
          <option value="true">已归档</option>
        </select>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs">
          {loading ? "正在读取列表…" : `共 ${total} 项`}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新归档列表
        </Button>
      </div>
      {notice && (
        <p
          role={notice.error ? "alert" : "status"}
          className="break-words text-xs"
        >
          {notice.text}
        </p>
      )}
      {readError && (
        <p role="alert" className="text-xs text-destructive">
          {readError}
        </p>
      )}
      {!readError && !loading && !items.length && (
        <p className="text-xs text-muted-foreground">此列表暂无条目。</p>
      )}
      {!readError && !loading && (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {items.map((item) => {
            const file = "exportId" in item ? item : null;
            const job = "id" in item ? item : null;
            const name = file?.name ?? job?.filename;
            return (
              <article
                key={file?.exportId ?? job?.id}
                className="space-y-2 rounded border p-2 text-xs"
              >
                <p className="break-words font-medium">
                  {name}
                  {job && ` · ${nativeJobLabels[job.status]}`}
                </p>
                <p className="break-words text-muted-foreground">
                  {file
                    ? `${new Date(file.modifiedAt).toLocaleString(
                        "zh-CN"
                      )} · ${storageSize(file.bytes)}`
                    : job?.stage}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {file && (
                    <a
                      className="rounded px-2 py-1 underline focus-visible:outline"
                      href={file.downloadUrl}
                    >
                      下载成果
                    </a>
                  )}
                  {file?.name.toLowerCase().endsWith(".geosandbox") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void openBundle(
                          savedBundleInput(file.name, file.downloadUrl)
                        )
                      }
                    >
                      校验并打开
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || !!(job && isNativeJobActive(job))}
                    onClick={() => void changeArchive(item)}
                  >
                    {archived ? "取消归档" : "归档"}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {!loading && !readError && total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || offset === 0}
            onClick={() => {
              setLoading(true);
              setOffset(offset - PAGE_SIZE);
            }}
          >
            上一页
          </Button>
          <span className="text-xs">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || offset + PAGE_SIZE >= total}
            onClick={() => {
              setLoading(true);
              setOffset(offset + PAGE_SIZE);
            }}
          >
            下一页
          </Button>
        </div>
      )}
    </section>
  );
}
