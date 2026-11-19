import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolContext } from "@strands-agents/sdk";
import { readFile } from "node:fs/promises";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  listAssistantTools,
  unregisterAssistantToolsByOwner,
} from "../packages/plugins/src/assistant-tool-registry";
import {
  registerSandboxTools,
  type ModelPlan,
} from "../apps/geolibre-desktop/src/lib/sandbox/assistant";
import {
  placements,
  transformInstance,
} from "../apps/geolibre-desktop/src/lib/sandbox/model";
import { applyModelPlan } from "../apps/geolibre-desktop/src/lib/sandbox/assembly";

afterEach(() => {
  unregisterAssistantToolsByOwner("geosandbox");
  useAppStore.setState({ layers: [] });
});

function seed() {
  const layer = {
    id: "test-model",
    name: "Constructed model",
    type: "deckgl-viz",
    visible: true,
    source: {
      type: "deckgl-viz",
      data: [
        { lng: 118.14, lat: 39.64 },
        { lng: 118.15, lat: 39.65 },
      ],
    },
    metadata: {
      vizConfig: {
        layerKind: "scenegraph",
        fieldMapping: { lng: "lng", lat: "lat" },
        scenegraph: {
          modelUrl: "data:model/gltf-binary;base64,AQID",
          sizeScale: 1,
          altitude: 0,
          bearing: 0,
        },
      },
    },
  } as unknown as GeoLibreLayer;
  useAppStore.setState({ layers: [layer] });
  return layer;
}

async function invoke(
  name: string,
  input: unknown,
  cancelSignal?: AbortSignal
) {
  const tool = listAssistantTools().find((tool) => tool.name.endsWith(name))!;
  const stream = tool.stream({
    toolUse: { name: tool.name, toolUseId: "test-use", input },
    cancelSignal,
  } as ToolContext);
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  return step.value;
}

test("AI preview leaves live data untouched and targets only the requested instance", async () => {
  const layer = seed();
  let plan: ModelPlan | undefined;
  registerSandboxTools((next) => {
    plan = next;
  });
  const inspection = await invoke("sandbox_inspect_models", {});
  assert.equal(inspection.status, "success");
  assert.match(JSON.stringify(inspection), /test-model/);
  const result = await invoke("sandbox_preview_transform", {
    layerId: layer.id,
    index: 1,
    bearing: 30,
    scale: 1.1,
  });
  assert.equal(result.status, "success");
  assert.match(JSON.stringify(result), /awaiting_user_apply/);
  assert.equal(useAppStore.getState().layers[0], layer);
  assert.equal(plan!.changes[0].before, layer);
  assert.deepEqual(placements(plan!.changes[0].after)[0], placements(layer)[0]);
  assert.equal(placements(plan!.changes[0].after)[1].bearing, 30);
  assert.equal(placements(plan!.changes[0].after)[1].scale, 1.1);
  // A later edit changes the before reference: this is the same condition the UI blocks.
  useAppStore
    .getState()
    .updateLayer(
      layer.id,
      transformInstance(layer, 0, { ...placements(layer)[0], scale: 2 })
    );
  assert.notEqual(useAppStore.getState().layers[0], plan!.changes[0].before);
});

test("all sandbox tool callbacks reject malformed and undeclared inputs at runtime", async () => {
  const layer = seed();
  let previews = 0;
  registerSandboxTools(() => previews++);
  const target = { layerId: layer.id, index: 0 };
  const cases: [string, unknown][] = [
    ["sandbox_inspect_models", { code: "delete everything" }],
    ["sandbox_preview_transform", null],
    ["sandbox_preview_transform", { ...target, scale: 1, code: "run_python" }],
    ["sandbox_preview_transform", { ...target, altitude: Infinity }],
    ["sandbox_preview_transform", { ...target, bearing: NaN }],
    ["sandbox_preview_transform", target],
    ["sandbox_preview_calibration", { ...target, unit: "__proto__" }],
    ["sandbox_preview_calibration", { ...target, widthMetres: "18.5" }],
    [
      "sandbox_preview_calibration",
      { ...target, widthMetres: 2, execute: true },
    ],
    ["sandbox_preview_assembly", { layerIds: [layer.id], scale: "2" }],
    ["sandbox_preview_assembly", { layerIds: [layer.id], up: NaN }],
    ["sandbox_preview_assembly", { layerIds: [layer.id, layer.id], up: 2 }],
    ["sandbox_preview_assembly", { layerIds: Array(65).fill(layer.id), up: 2 }],
    ["sandbox_preview_assembly", { layerIds: [layer.id], up: 2, apply: true }],
  ];
  for (const [tool, input] of cases)
    assert.equal(
      (await invoke(tool, input)).status,
      "error",
      `${tool}: ${JSON.stringify(input)}`
    );
  assert.equal(previews, 0);
  assert.equal(useAppStore.getState().layers[0], layer);
});

test("model inspection sends only the declared measurement summary", async () => {
  const layer = seed();
  layer.metadata.geosandboxMeasurement = {
    basis: "glTF-metres",
    dimensions: [37, 12.5, 17],
    vertices: 192,
    extraAssetUrl: "private-model-url",
    extraCredential: "private-value",
  };
  registerSandboxTools(() => {});
  const result = await invoke("sandbox_inspect_models", {});
  assert.equal(result.status, "success");
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-model-url|private-value|base64/
  );
});

for (const interruption of [
  "stop",
  "switch",
  "edit",
  "dispose",
  "supersede",
] as const) {
  test(`late width calibration cannot publish after ${interruption}`, async () => {
    const layer = seed();
    const bytes = await readFile(
      new URL(
        "../apps/geolibre-desktop/public/geosandbox/teaching-block.glb",
        import.meta.url
      )
    );
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchBefore = globalThis.fetch;
    let requestSignal: AbortSignal | undefined;
    // Deliberately ignore abort in this fake transport, exercising the post-await guard too.
    globalThis.fetch = async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      started();
      await wait;
      return new Response(bytes);
    };
    const plans: ModelPlan[] = [];
    const dispose = registerSandboxTools((plan) => plans.push(plan));
    const abort = new AbortController();
    try {
      const running = invoke(
        "sandbox_preview_calibration",
        {
          layerId: layer.id,
          index: 0,
          widthMetres: 18.5,
        },
        abort.signal
      );
      await entered;
      if (interruption === "stop") abort.abort();
      if (interruption === "switch")
        useAppStore.setState((s) => ({
          projectGeneration: s.projectGeneration + 1,
        }));
      if (interruption === "edit")
        useAppStore
          .getState()
          .updateLayer(layer.id, { name: "Changed during measurement" });
      if (interruption === "dispose") dispose();
      if (interruption === "supersede") {
        assert.equal(
          (
            await invoke("sandbox_preview_transform", {
              layerId: layer.id,
              index: 0,
              altitude: 2,
            })
          ).status,
          "success"
        );
      }
      release();
      // A stale registration may throw; normal callback guards return SDK error results.
      const result = await running;
      assert.equal(result.status, "error");
      assert.equal(plans.length, interruption === "supersede" ? 1 : 0);
      if (
        interruption === "stop" ||
        interruption === "dispose" ||
        interruption === "supersede"
      )
        assert.equal(requestSignal?.aborted, true);
      if (interruption !== "edit")
        assert.equal(useAppStore.getState().layers[0], layer);
      if (interruption === "supersede")
        assert.equal(placements(plans[0].changes[0].after)[0].altitude, 2);
    } finally {
      release();
      dispose();
      globalThis.fetch = fetchBefore;
    }
  });
}

test("an AI plan cannot apply across a project switch even if layer references are reused", async () => {
  const layer = seed();
  let plan: ModelPlan | undefined;
  registerSandboxTools((next) => {
    plan = next;
  });
  await invoke("sandbox_preview_transform", {
    layerId: layer.id,
    index: 0,
    altitude: 2,
  });
  useAppStore.setState((s) => ({ projectGeneration: s.projectGeneration + 1 }));
  assert.throws(() => applyModelPlan(plan!), /项目已切换/);
  assert.equal(useAppStore.getState().layers[0], layer);
});

test("invalid AI parameters never create a plan or mutate a model", async () => {
  const layer = seed();
  let previews = 0;
  registerSandboxTools(() => {
    previews++;
  });
  for (const input of [
    { layerId: layer.id, index: 0, scale: -1 },
    { layerId: layer.id, index: 0, lng: 181 },
    { layerId: layer.id, index: 99 },
    { layerId: layer.id, index: 0, bearing: "30" },
    { layerId: "missing", index: 0 },
  ])
    assert.equal(
      (await invoke("sandbox_preview_transform", input)).status,
      "error"
    );
  assert.equal(previews, 0);
  assert.equal(useAppStore.getState().layers[0], layer);
});

test("AI unit calibration and whole-model assembly remain unapplied until confirmation", async () => {
  const layer = seed();
  const other = { ...layer, id: "another-model", name: "Second model" };
  useAppStore.setState({ layers: [layer, other] });
  let plan: ModelPlan | undefined;
  registerSandboxTools((next) => {
    plan = next;
  });
  const unit = await invoke("sandbox_preview_calibration", {
    layerId: layer.id,
    index: 0,
    unit: "ft",
  });
  assert.equal(unit.status, "success");
  assert.equal(placements(plan!.changes[0].after)[0].scale, 0.3048);
  assert.equal(useAppStore.getState().layers[0], layer);
  const group = await invoke("sandbox_preview_assembly", {
    layerIds: [layer.id, other.id],
    up: 2,
  });
  assert.equal(group.status, "success");
  assert.equal(plan!.changes.length, 2);
  assert.equal(placements(plan!.changes[1].after)[0].altitude, 2);
  assert.equal(useAppStore.getState().layers[1], other);
  assert.equal(
    (
      await invoke("sandbox_preview_calibration", {
        layerId: layer.id,
        index: 0,
        unit: "m",
        widthMetres: 3,
      })
    ).status,
    "error"
  );
});

test("AI width calibration measures the current asset instead of trusting cached dimensions", async () => {
  const layer = seed();
  const bytes = await readFile(
    new URL(
      "../apps/geolibre-desktop/public/geosandbox/teaching-block.glb",
      import.meta.url
    )
  );
  const config = layer.metadata.vizConfig as {
    scenegraph: { modelUrl: string };
  };
  config.scenegraph.modelUrl = `data:model/gltf-binary;base64,${bytes.toString(
    "base64"
  )}`;
  layer.metadata.geosandboxMeasurement = {
    basis: "glTF-metres",
    dimensions: [1000, 1000, 1000],
    vertices: 1,
  };
  let plan: ModelPlan | undefined;
  registerSandboxTools((next) => {
    plan = next;
  });
  const result = await invoke("sandbox_preview_calibration", {
    layerId: layer.id,
    index: 0,
    widthMetres: 18.5,
  });
  assert.equal(result.status, "success");
  assert.equal(placements(plan!.changes[0].after)[0].scale, 0.5);
  assert.equal(useAppStore.getState().layers[0], layer);
});
