import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@geolibre/core";
import {
  createSandboxTasks,
  type SandboxTaskExecute,
  type SandboxTaskState,
} from "../lib/sandbox/tasks";

export function useSandboxTasks() {
  const runner = useRef<ReturnType<typeof createSandboxTasks> | null>(null);
  const [state, setState] = useState<SandboxTaskState>({
    phase: "idle",
    label: "",
    stage: "",
  });
  useEffect(() => {
    const current = createSandboxTasks(setState);
    runner.current = current;
    setState({ phase: "idle", label: "", stage: "" });
    let generation = useAppStore.getState().projectGeneration;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.projectGeneration === generation) return;
      generation = state.projectGeneration;
      if (!current.running) setState({ phase: "idle", label: "", stage: "" });
    });
    return () => {
      unsubscribe();
      current.dispose();
      if (runner.current === current) runner.current = null;
    };
  }, []);
  const execute = useCallback<SandboxTaskExecute>(
    (options, action) =>
      runner.current?.run(options, action) ?? Promise.resolve(false),
    []
  );
  const cancel = useCallback(
    (reason?: string) => runner.current?.cancel(reason),
    []
  );
  const isRunning = useCallback(() => !!runner.current?.running, []);
  return { state, execute, cancel, isRunning };
}
