import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { buildProjectSnapshot } from "../lib/build-project-snapshot";
import { projectChanged } from "../lib/project-broadcast-changed";
import {
  createRecoveryController,
  saveRecoveryPoint,
  type RecoveryStatus,
} from "../lib/sandbox/recovery";
import type { ResourceCache } from "../lib/sandbox/bundle";

export function useDiskRecovery(mapControllerRef: RefObject<MapEngine | null>, available = true) {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem("geosandbox-disk-recovery") !== "off";
    } catch {
      return true;
    }
  });
  const [status, setStatus] = useState<RecoveryStatus>({ phase: "idle" });
  const writer = useRef<ReturnType<typeof createRecoveryController> | null>(
    null
  );
  useEffect(() => {
    if (!available) return;
    setStatus({ phase: "idle" });
    const cache: ResourceCache = new Map();
    const isMeaningful = () =>
      useAppStore.getState().layers.length > 0 ||
      useAppStore.getState().projectName !== "Untitled Project";
    let meaningful = isMeaningful();
    const current = createRecoveryController({
      snapshot: () => buildProjectSnapshot(mapControllerRef),
      save: (project, signal) => saveRecoveryPoint(project, signal, cache),
      status: setStatus,
    });
    writer.current = current;
    if (enabled && meaningful) current.schedule();
    const stop = useAppStore.subscribe((state, previous) => {
      if (state.projectGeneration !== previous.projectGeneration) {
        current.reset();
        cache.clear();
        meaningful = false;
      }
      meaningful ||= isMeaningful();
      if (enabled && meaningful && projectChanged(state, previous))
        current.schedule();
    });
    return () => {
      stop();
      current.dispose();
      cache.clear();
      writer.current = null;
    };
  }, [available, enabled, mapControllerRef]);
  const toggle = useCallback((value: boolean) => {
    setEnabled(value);
    try {
      localStorage.setItem("geosandbox-disk-recovery", value ? "on" : "off");
    } catch {
      /* Session setting still works. */
    }
  }, []);
  const flush = useCallback(async () => {
    if (
      !useAppStore.getState().layers.length &&
      useAppStore.getState().projectName === "Untitled Project"
    )
      throw new Error("先添加数据或命名项目，再创建恢复点。");
    await writer.current?.flush();
  }, []);
  return { enabled, toggle, status, flush };
}
