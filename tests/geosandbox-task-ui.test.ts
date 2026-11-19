import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  useAppStore,
  mockFetch,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { readFile } from "node:fs/promises";
import type { GeoLibreLayer } from "@geolibre/core";
import type { ModelPlan } from "../apps/geolibre-desktop/src/lib/sandbox/assembly";
const { useSandboxTasks } = await import(
  "../apps/geolibre-desktop/src/hooks/useSandboxTasks"
);
const { ModelCalibration } = await import(
  "../apps/geolibre-desktop/src/components/sandbox/ModelCalibration"
);
const { TaskStatus } = await import(
  "../apps/geolibre-desktop/src/components/sandbox/TaskStatus"
);

test("real task hook survives StrictMode, cancels from its visible control and allows retry", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let commits = 0;
  function Harness() {
    const tasks = useSandboxTasks();
    return createElement(
      "div",
      null,
      createElement(
        "button",
        {
          onClick: () =>
            void tasks.execute({ id: "ui", label: "UI task" }, async (task) => {
              await pending;
              task.commit(() => {
                commits++;
              });
            }),
        },
        "Start"
      ),
      createElement(TaskStatus, {
        state: tasks.state,
        cancel: () => tasks.cancel(),
        history: () => {},
      })
    );
  }
  render(createElement(StrictMode, null, createElement(Harness)));
  fireEvent.click(screen.getByText("Start"));
  await screen.findByRole("button", { name: "取消当前任务" });
  fireEvent.click(screen.getByRole("button", { name: "取消当前任务" }));
  await waitFor(() =>
    assert.match(screen.getByRole("status").textContent!, /已取消/)
  );
  await act(async () => {
    release();
  });
  assert.equal(commits, 0);
  fireEvent.click(screen.getByText("Start"));
  await waitFor(() =>
    assert.match(screen.getByRole("status").textContent!, /已完成/)
  );
  assert.equal(commits, 1);
  await act(async () => {
    useAppStore.getState().newProject();
  });
  assert.equal(screen.queryByRole("region", { name: "沙盒任务状态" }), null);
});

test("actual width calibration remains a preview and cancellation leaves the layer untouched", async () => {
  const bytes = await readFile(
    new URL(
      "../apps/geolibre-desktop/public/geosandbox/teaching-block.glb",
      import.meta.url
    )
  );
  const layer = {
    id: "constructed-model",
    name: "Constructed",
    type: "deckgl-viz",
    visible: true,
    source: { type: "deckgl-viz", data: [{ lng: 118.14, lat: 39.64 }] },
    metadata: {
      vizConfig: {
        layerKind: "scenegraph",
        fieldMapping: { lng: "lng", lat: "lat" },
        scenegraph: {
          modelUrl: "data:model/gltf-binary;base64,AQID",
          sizeScale: 1,
          altitude: 0,
        },
      },
      geosandboxMeasurement: {
        basis: "glTF-metres",
        dimensions: [37, 12.5, 17],
        vertices: 192,
      },
    },
  } as unknown as GeoLibreLayer;
  useAppStore.setState({ layers: [layer] });
  let resolveFetch!: () => void;
  const wait = new Promise<void>((resolve) => {
    resolveFetch = resolve;
  });
  let requestedSignal: AbortSignal | undefined;
  mockFetch(async (_url, init) => {
    requestedSignal = init?.signal ?? undefined;
    await wait;
    return new Response(bytes);
  });
  let preview: ModelPlan | undefined;
  function Harness() {
    const tasks = useSandboxTasks();
    return createElement(
      "div",
      null,
      createElement(TaskStatus, {
        state: tasks.state,
        cancel: () => tasks.cancel(),
        history: () => {},
      }),
      createElement(ModelCalibration, {
        layer,
        index: 0,
        busy: tasks.state.phase === "running" || tasks.state.phase === "queued",
        execute: async (action) => {
          await action();
          return true;
        },
        executeTask: tasks.execute,
        onPreview: (plan) => {
          preview = plan;
        },
      })
    );
  }
  render(createElement(Harness));
  fireEvent.click(screen.getByRole("button", { name: "重新测量源模型" }));
  await waitFor(() => assert.ok(requestedSignal));
  fireEvent.click(screen.getByRole("button", { name: "取消当前任务" }));
  await waitFor(() => assert.equal(requestedSignal?.aborted, true));
  await act(async () => {
    resolveFetch();
  });
  assert.equal(useAppStore.getState().layers[0], layer);
  assert.equal(preview, undefined);
  fireEvent.change(screen.getByLabelText("目标 X 宽度（米）"), {
    target: { value: "18.5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "预览尺寸" }));
  await waitFor(() => assert.ok(preview));
  assert.equal(useAppStore.getState().layers[0], layer);
  assert.equal(
    preview!.projectGeneration,
    useAppStore.getState().projectGeneration
  );
  const { placements } = await import(
    "../apps/geolibre-desktop/src/lib/sandbox/model"
  );
  assert.equal(placements(preview!.changes[0].after)[0].scale, 0.5);
});
