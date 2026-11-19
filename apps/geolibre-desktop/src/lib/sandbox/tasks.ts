import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { untilAborted } from "../abortable";
import { createOperationTokens } from "../operation-tokens";
import { beginProcessingRun } from "../processing-history";
import { projectChanged } from "../project-broadcast-changed";

export interface SandboxTaskState {
  phase:
    | "idle"
    | "queued"
    | "running"
    | "cancelling"
    | "writing"
    | "success"
    | "cancelled"
    | "error";
  label: string;
  stage: string;
  error?: string;
}
export interface SandboxTaskOptions {
  id: string;
  label: string;
  inputs?: readonly GeoLibreLayer[];
  engine?: string;
  parameters?: Record<string, unknown>;
  timeoutMs?: number;
  record?: boolean;
  replaceProject?: boolean;
}
export interface SandboxTaskContext {
  signal: AbortSignal;
  check: () => void;
  /** A native task must confirm its owned process stopped before showing cancelled. */
  onCancel: (cleanup: () => Promise<void>) => void;
  /** Yield for UI input and paint between actual work phases; no fabricated percentage. */
  stage: (label: string) => Promise<void>;
  /** The final synchronous project/UI write, after every input is checked. */
  commit: (action: () => void) => void;
  /** Irreversible file writes: cancellation is closed until receipt verification settles. */
  persist: <T>(stage: string, action: () => Promise<T>) => Promise<T>;
}
export type SandboxTaskExecute = (
  options: SandboxTaskOptions,
  action: (task: SandboxTaskContext) => Promise<void> | void
) => Promise<boolean>;

/** Small adapter around the existing operation tokens, cancellation and project history. */
export function createSandboxTasks(
  onChange: (state: SandboxTaskState) => void
) {
  const tokens = createOperationTokens();
  let active: AbortController | undefined;
  let disposed = false;
  let writing = false;
  const emit = (state: SandboxTaskState) => {
    if (!disposed) onChange(state);
  };
  function cancel(reason = "已取消；未提交的结果不会应用。") {
    if (writing) return;
    active?.abort(new DOMException(reason, "AbortError"));
    tokens.invalidate();
  }
  const run: SandboxTaskExecute = async (options, action) => {
    if (active || disposed) return false;
    const controller = new AbortController();
    active = controller;
    writing = false;
    const { signal } = controller;
    const token = tokens.begin();
    const generation = useAppStore.getState().projectGeneration;
    const original = useAppStore.getState();
    const inputs = [...(options.inputs ?? [])];
    let committing = false;
    let committed = false;
    let timedOut = false;
    const cancellation: Array<() => Promise<void>> = [];
    const currentInputs = () =>
      (!options.replaceProject ||
        (!projectChanged(original, useAppStore.getState()) &&
          original.comments === useAppStore.getState().comments &&
          original.printLayout === useAppStore.getState().printLayout &&
          original.obiaWorkbench === useAppStore.getState().obiaWorkbench &&
          original.projectInteraction ===
            useAppStore.getState().projectInteraction &&
          original.projectPlugins === useAppStore.getState().projectPlugins)) &&
      inputs.every(
        (layer) =>
          useAppStore
            .getState()
            .layers.find((entry) => entry.id === layer.id) === layer
      );
    const check = () => {
      signal.throwIfAborted();
      if (
        !tokens.isCurrent(token) ||
        useAppStore.getState().projectGeneration !== generation
      )
        throw writing
          ? new Error(
              "磁盘操作已开始，但项目已切换；请核对 D 盘回执，当前项目未被标记为已保存。"
            )
          : new DOMException("项目已切换，旧任务结果不会应用。", "AbortError");
      if (!writing && !currentInputs())
        throw new DOMException(
          "输入图层已变化，请重新运行任务。",
          "AbortError"
        );
    };
    const tracker =
      options.record === false
        ? null
        : beginProcessingRun({
            kind: "sandbox",
            toolId: options.id,
            toolName: options.label,
            engine: options.engine ?? "browser",
            parameters: { ...options.parameters },
          });
    const unsubscribe = useAppStore.subscribe((state) => {
      // The final guarded commit has already applied. Renderer/UI restore effects
      // may notify before the action promise settles; they cannot cancel that result.
      if (committing || committed || writing || signal.aborted) return;
      if (state.projectGeneration !== generation)
        cancel("项目已切换，旧任务结果不会应用。");
      else if (!currentInputs()) cancel("输入图层已变化，请重新运行任务。");
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      cancel("任务超时，未提交的结果不会应用，请拆分数据后重试。");
    }, options.timeoutMs ?? 120000);
    const task: SandboxTaskContext = {
      signal,
      check,
      onCancel: (cleanup) => {
        check();
        cancellation.push(cleanup);
      },
      persist: async (stage, action) => {
        check();
        writing = true;
        clearTimeout(timeout);
        emit({ phase: "writing", label: options.label, stage });
        // Transport/receipt helpers have shorter limits; this is the final bound.
        return untilAborted(action(), AbortSignal.timeout(90000));
      },
      stage: async (stage) => {
        check();
        emit({
          phase: writing ? "writing" : "running",
          label: options.label,
          stage,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        check();
      },
      commit: (write) => {
        check();
        if (committed) throw new Error("任务结果只能提交一次。");
        committing = true;
        try {
          write();
          committed = true;
        } finally {
          committing = false;
        }
      },
    };
    const finish = (
      status: "success" | "cancelled" | "error",
      error?: string
    ) => {
      unsubscribe();
      // Never append the previous project's task record to its replacement.
      if (useAppStore.getState().projectGeneration === generation)
        tracker?.finish(status, error);
      emit({
        phase: status,
        label: options.label,
        stage: status === "success" ? "已完成" : error ?? "",
        error,
      });
    };
    emit({ phase: "queued", label: options.label, stage: "等待开始" });
    try {
      await untilAborted(
        (async () => {
          await task.stage("准备任务");
          await action(task);
          if (!committed) check();
        })(),
        signal
      );
      finish("success");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cancellation.length) {
        emit({
          phase: "cancelling",
          label: options.label,
          stage: "正在确认后台计算已停止…",
        });
        try {
          await untilAborted(
            Promise.all(cancellation.map((cleanup) => cleanup())),
            AbortSignal.timeout(15000)
          );
        } catch {
          finish(
            "error",
            "后台停止未确认；结果不会应用，请在数据页的后台任务中核对。"
          );
          return false;
        }
      }
      finish(
        timedOut
          ? "error"
          : signal.aborted ||
            (error instanceof Error && error.name === "AbortError")
          ? "cancelled"
          : "error",
        message
      );
      return false;
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      if (active === controller) {
        active = undefined;
        writing = false;
        tokens.invalidate();
      }
    }
  };
  return {
    run,
    cancel,
    get running() {
      return !!active;
    },
    dispose() {
      disposed = true;
      cancel("装配面板已卸载，任务已取消。");
    },
  };
}
