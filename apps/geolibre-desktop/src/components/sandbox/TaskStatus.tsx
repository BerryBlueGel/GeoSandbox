import { Button } from "@geolibre/ui";
import type { SandboxTaskState } from "../../lib/sandbox/tasks";

export function TaskStatus({
  state,
  cancel,
  history,
}: {
  state: SandboxTaskState;
  cancel: () => void;
  history: () => void;
}) {
  if (state.phase === "idle") return null;
  const running = state.phase === "queued" || state.phase === "running";
  return (
    <section
      className="space-y-2 border-b bg-muted/30 px-4 py-3"
      aria-label="沙盒任务状态"
    >
      <p
        role={state.phase === "error" ? "alert" : "status"}
        className="break-words text-xs leading-relaxed"
      >
        <strong>{state.label}</strong> · {state.stage}
      </p>
      <div className="flex gap-2">
        {running && (
          <Button size="sm" variant="outline" onClick={cancel}>
            取消当前任务
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={history}>
          查看处理历史
        </Button>
      </div>
      {running && (
        <p className="text-xs text-muted-foreground">
          按实际处理阶段显示进度；取消后未提交的结果不会应用。
        </p>
      )}
      {state.phase === "writing" && (
        <p className="text-xs text-muted-foreground">
          磁盘操作已开始，正在核对回执，此阶段不可取消；网络中断时请按编号核对实际结果。
        </p>
      )}
      {state.phase === "cancelling" && (
        <p className="text-xs text-muted-foreground">
          正在等待后台进程退出回执，尚未标记为已取消。
        </p>
      )}
    </section>
  );
}
