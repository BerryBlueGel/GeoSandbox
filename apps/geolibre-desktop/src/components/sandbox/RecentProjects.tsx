import { useEffect, useState } from "react";
import { Button } from "@geolibre/ui";
import type { BundleInput } from "../../lib/sandbox/bundle";
import { savedBundleInput } from "../../lib/sandbox/saved-project";

interface SavedProject {
  exportId: string;
  name: string;
  bytes: number;
  modifiedAt: string;
  downloadUrl: string;
}
export function RecentProjects({
  revision,
  busy,
  openBundle,
  onOpenHistory,
}: {
  revision: number;
  busy: boolean;
  openBundle: (file: BundleInput) => Promise<boolean>;
  onOpenHistory: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [directory, setDirectory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetch("/sandbox-api/projects", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取 D 盘已保存项目。");
        const result = await response.json();
        if (!controller.signal.aborted) {
          setProjects(result.projects);
          setDirectory(result.directory);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision, refresh]);
  return (
    <section className="space-y-3 border-t pt-4" aria-label="已保存的本地项目">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">D 盘已保存项目</h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading || busy}
          onClick={() => setRefresh((v) => v + 1)}
        >
          刷新列表
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        显示最近 20
        个项目，每个名称取最近一次未归档的保存。打开时检查资源完整性，替换当前项目可撤销。
      </p>
      {loading && (
        <p role="status" className="text-xs">
          正在读取已保存项目…
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!loading && !error && !projects.length && (
        <p className="text-xs text-muted-foreground">
          还没有项目包，先保存当前项目。
        </p>
      )}
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {projects.map((project) => (
          <div key={project.exportId} className="rounded-md border p-3">
            <p className="break-all text-sm font-medium">{project.name}</p>
            <p className="my-1 text-xs text-muted-foreground">
              {new Date(project.modifiedAt).toLocaleString("zh-CN")} ·{" "}
              {(project.bytes / 1024).toFixed(1)} KiB
            </p>
            <Button
              className="w-full"
              variant="outline"
              size="sm"
              disabled={busy || loading}
              aria-label={`打开已保存项目 ${project.name}`}
              onClick={() =>
                void openBundle(
                  savedBundleInput(project.name, project.downloadUrl)
                )
              }
            >
              打开项目
            </Button>
          </div>
        ))}
      </div>
      {!!directory && (
        <p className="break-all text-xs text-muted-foreground">{directory}</p>
      )}
      <Button
        className="w-full"
        variant="outline"
        disabled={busy}
        onClick={onOpenHistory}
      >
        查看所有自动保存与历史
      </Button>
      <p className="text-xs leading-relaxed text-muted-foreground">
        小型项目的自动历史保存在浏览器，清理浏览器后可能丢失；完整项目请保存到 D
        盘。
      </p>
    </section>
  );
}
