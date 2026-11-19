import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { readFile } from "node:fs/promises";
import {
  useAppStore,
  clearHistory,
  undo,
  redo,
  parseProject,
  projectFromStore,
  serializeProject,
  applyGroupEffects,
  setHistoryCoalesceMs,
  type GeoLibreLayer,
} from "@geolibre/core";
import { Cartographic, EllipsoidGeodesic } from "cesium";
import {
  assemblyPlan,
  applyModelPlan,
} from "../apps/geolibre-desktop/src/lib/sandbox/assembly";
import {
  modelConfig,
  placements,
} from "../apps/geolibre-desktop/src/lib/sandbox/model";
import {
  applyModelGroupCopy,
  modelGroupMembers,
  previewModelGroupCopy,
  saveModelGroup,
} from "../apps/geolibre-desktop/src/lib/sandbox/assembly-groups";
import {
  registrationPlan,
  type ControlPair,
} from "../apps/geolibre-desktop/src/lib/sandbox/registration";
import {
  measureModel,
  calibrateModel,
} from "../apps/geolibre-desktop/src/lib/sandbox/measure-model";

setHistoryCoalesceMs(0);
afterEach(() => {
  useAppStore.getState().newProject();
  clearHistory();
});
function model(
  id: string,
  lng: number,
  altitude: number,
  scale = 1
): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "deckgl-viz",
    visible: true,
    opacity: 1,
    source: {
      type: "deckgl-viz",
      data: [{ lng, lat: 0, altitude, scale, label: id }],
    },
    metadata: {
      vizConfig: {
        layerKind: "scenegraph",
        fieldMapping: {
          lng: "lng",
          lat: "lat",
          altitude: "altitude",
          scale: "scale",
        },
        scenegraph: {
          modelUrl: "data:model/gltf-binary;base64,AQID",
          altitude: 0,
          bearing: 0,
          sizeScale: 1,
        },
      },
    },
  } as unknown as GeoLibreLayer;
}
const identity = { east: 0, north: 0, up: 0, bearing: 0, scale: 1 };

// Independent equatorial WGS84 scale factors for short offsets, sufficient at the millimetre tolerance here.
function nearEquator(east: number, north: number, longitude = 0) {
  return { lng: longitude + east / 111319.490793, lat: north / 110574.275822 };
}

function controlPairs(scale: number): ControlPair[] {
  return [
    [0, 0],
    [20, 0],
    [0, 30],
    [10, 10],
  ].map(([x, y], i) => ({
    source: nearEquator(x, y),
    target: nearEquator(100 + scale * y, -40 - scale * x, 2),
    role: i === 3 ? "check" : "fit",
  }));
}

test("registration transforms the model from three fit points, validates a held-out point, and saves its report", () => {
  const before = model("A", 0, 7, 2);
  useAppStore.setState({ layers: [before] });
  clearHistory();
  const { projectGeneration } = useAppStore.getState();
  const points = controlPairs(1.5);
  const plan = registrationPlan(
    [before],
    [before.id],
    points,
    "similarity",
    0.001,
    projectGeneration
  );
  assert.equal(plan.registration?.acceptable, true);
  assert.ok(plan.registration!.checkRmse < 0.0001);
  assert.equal(useAppStore.getState().layers[0], before);
  const after = placements(plan.changes[0].after)[0];
  assert.ok(Math.abs(after.lng - points[0].target.lng) < 1e-8);
  assert.ok(Math.abs(after.lat - points[0].target.lat) < 1e-8);
  assert.ok(Math.abs(after.bearing - 90) < 1e-6);
  assert.ok(Math.abs(after.scale - 3) < 1e-6);
  assert.equal(after.altitude, 7);
  applyModelPlan(plan);
  const saved = parseProject(
    serializeProject(projectFromStore(useAppStore.getState()))
  );
  assert.equal(
    saved.processingHistory?.at(-1)?.parameters.checkRmse,
    plan.registration!.checkRmse
  );
  undo();
  assert.equal(useAppStore.getState().layers[0], before);
  redo();
  assert.deepEqual(placements(useAppStore.getState().layers[0])[0], after);
});

test("a bad independent checkpoint leaves the fit unchanged and blocks committing; duplicate and collinear points are rejected", () => {
  const before = model("A", 0, 7);
  useAppStore.setState({ layers: [before] });
  clearHistory();
  const { projectGeneration } = useAppStore.getState();
  const make = (points: ControlPair[]) =>
    registrationPlan(
      [before],
      [before.id],
      points,
      "rigid",
      0.1,
      projectGeneration
    );
  const pairs = controlPairs(1);
  const good = make(pairs);
  assert.equal(good.registration?.acceptable, true);
  const bad = make([
    ...pairs.slice(0, 3),
    { ...pairs[3], target: nearEquator(170, -40, 2) },
  ]);
  assert.deepEqual(bad.registration?.transform, good.registration?.transform);
  assert.equal(bad.registration?.acceptable, false);
  assert.throws(() => applyModelPlan(bad), /超出误差限值/);
  assert.equal(useAppStore.getState().layers[0], before);
  assert.throws(
    () => make([...pairs.slice(0, 3), { ...pairs[0], role: "check" }]),
    /距离不足/
  );
  assert.throws(
    () =>
      make([
        pairs[0],
        pairs[1],
        { ...pairs[2], source: nearEquator(40, 0) },
        pairs[3],
      ]),
    /共线/
  );
  useAppStore
    .getState()
    .loadProject(projectFromStore(useAppStore.getState()), null);
  assert.throws(() => applyModelPlan(good), /项目已切换/);
});

test("a model assembly uses metric offsets and scales its spacing and authored heights", () => {
  const a = model("A", 0, 5),
    b = model("B", 0.001, 15, 2);
  const plan = assemblyPlan([a, b], ["A", "B"], {
    east: 10,
    north: 20,
    up: 3,
    bearing: 90,
    scale: 2,
  });
  const [p, q] = plan.changes.map((c) => placements(c.after)[0]);
  const distance = new EllipsoidGeodesic(
    Cartographic.fromDegrees(p.lng, p.lat),
    Cartographic.fromDegrees(q.lng, q.lat)
  ).surfaceDistance;
  assert.ok(Math.abs(distance - 222.6389816) < 0.02);
  assert.ok(q.lat < p.lat && Math.abs(q.lng - p.lng) < 1e-8);
  assert.deepEqual(
    [p.altitude, q.altitude, p.scale, q.scale, p.bearing, q.bearing],
    [8, 28, 2, 4, 90, 90]
  );
  assert.deepEqual(placements(a)[0], {
    lng: 0,
    lat: 0,
    altitude: 5,
    bearing: 0,
    scale: 1,
  });
});
test("two model changes commit as one undoable action and preserve unrelated layers", () => {
  const layers = [model("A", 0, 0), model("B", 0.001, 0), model("C", 0.002, 0)];
  useAppStore.setState({ layers });
  clearHistory();
  const plan = assemblyPlan(layers, ["A", "B"], { ...identity, east: 10 });
  applyModelPlan(plan);
  assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
  assert.equal(useAppStore.getState().layers[2], layers[2]);
  undo();
  assert.equal(useAppStore.getState().layers[0], layers[0]);
  assert.equal(useAppStore.getState().layers[1], layers[1]);
  redo();
  assert.equal(useAppStore.getState().layers[0], plan.changes[0].after);
  assert.equal(useAppStore.getState().layers[1], plan.changes[1].after);
});
test("one stale model aborts the whole plan without partially editing other models", () => {
  const layers = [model("A", 0, 0), model("B", 0.001, 0)];
  useAppStore.setState({ layers });
  clearHistory();
  const plan = assemblyPlan(layers, ["A", "B"], { ...identity, up: 3 });
  useAppStore.getState().updateLayer("B", { opacity: 0.5 });
  const before = useAppStore.getState().layers;
  assert.throws(() => applyModelPlan(plan), /数据已变化/);
  assert.equal(useAppStore.getState().layers, before);
  assert.equal(useAppStore.getState().layers[0], layers[0]);
});
test("height-only transformations preserve exact coordinates and invalid global groups are rejected", () => {
  const layer = model("A", 118.14, 5);
  const plan = assemblyPlan([layer], ["A"], { ...identity, up: 2 });
  assert.equal(placements(plan.changes[0].after)[0].lng, 118.14);
  assert.equal(placements(plan.changes[0].after)[0].lat, 0);
  assert.throws(
    () => assemblyPlan([layer, model("B", 120, 0)], ["A", "B"], identity),
    /5 km/
  );
  assert.throws(() => assemblyPlan([layer], ["missing"], identity), /有效模型/);
  assert.throws(
    () =>
      assemblyPlan(
        [model("A", 0, 0), model("B", 180, 0)],
        ["A", "B"],
        identity
      ),
    /5 km/
  );
});

test("named model groups preserve their parent's render settings and round-trip with placed copies", () => {
  const a = model("A", 0, 5),
    b = model("B", 0.001, 15, 2);
  const state = useAppStore.getState();
  useAppStore.setState({ layers: [a, b] });
  const parent = state.addLayerGroup("Campus", [a.id, b.id]);
  state.setLayerGroupOpacity(parent, 0.4);
  const sourceId = saveModelGroup("  Building pair  ", [b.id, a.id]);
  const before = useAppStore.getState();
  assert.equal(
    before.layerGroups.find((g) => g.id === sourceId)?.parentId,
    parent
  );
  assert.deepEqual(
    applyGroupEffects(before.layers, before.layerGroups).map(
      (layer) => layer.opacity
    ),
    [0.4, 0.4]
  );

  const target = { lng: 118.14, lat: 39.64, altitude: 20 };
  const preview = previewModelGroupCopy(sourceId, target);
  assert.equal(useAppStore.getState().layers, before.layers);
  clearHistory();
  const copy = applyModelGroupCopy(preview);
  const after = useAppStore.getState();
  const [c, d] = modelGroupMembers(after.layers, after.layerGroups, copy.id);
  assert.equal(copy.parentId, parent);
  assert.equal(copy.name, "Building pair 副本");
  assert.deepEqual(after.layers.slice(0, 2), before.layers);
  assert.notEqual(c.id, a.id);
  assert.equal(
    modelConfig(c)?.scenegraph?.modelUrl,
    modelConfig(a)?.scenegraph?.modelUrl
  );
  const [p, q] = [placements(c)[0], placements(d)[0]];
  assert.deepEqual(p, { ...target, bearing: 0, scale: 1 });
  assert.deepEqual([q.altitude, q.scale, q.bearing], [30, 2, 0]);
  const distance = new EllipsoidGeodesic(
    Cartographic.fromDegrees(p.lng, p.lat),
    Cartographic.fromDegrees(q.lng, q.lat)
  );
  assert.ok(Math.abs(distance.surfaceDistance - 111.3194908) < 0.02);
  assert.ok(Math.abs(distance.startHeading - Math.PI / 2) < 1e-6);
  assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
  undo();
  assert.deepEqual(useAppStore.getState().layers, before.layers);
  assert.deepEqual(useAppStore.getState().layerGroups, before.layerGroups);
  redo();
  assert.deepEqual(useAppStore.getState().layers, after.layers);
  assert.deepEqual(useAppStore.getState().layerGroups, after.layerGroups);

  const project = parseProject(serializeProject(projectFromStore(after)));
  state.loadProject(project, null);
  const reopened = useAppStore.getState();
  assert.equal(
    modelGroupMembers(reopened.layers, reopened.layerGroups, copy.id).length,
    2
  );
  const repeated = applyModelGroupCopy(
    previewModelGroupCopy(sourceId, { ...target, lng: 118.2 })
  );
  assert.equal(repeated.name, "Building pair 副本 2");
});

test("invalid destinations and stale group membership cannot add partial copies", () => {
  const a = model("A", 0, 5),
    b = model("B", 0.001, 15);
  const state = useAppStore.getState();
  useAppStore.setState({ layers: [a, b] });
  const id = saveModelGroup("Source", [a.id]);
  assert.throws(() => saveModelGroup("Mixed", [a.id, b.id]), /同一图层分组/);
  assert.throws(
    () => previewModelGroupCopy(id, { lng: 181, lat: 0, altitude: 0 }),
    /经度/
  );
  const plan = previewModelGroupCopy(id, { lng: 70, lat: 0, altitude: 0 });
  state.moveLayerToGroup(b.id, id);
  const current = useAppStore.getState();
  assert.throws(() => applyModelGroupCopy(plan), /组合内容已变化/);
  assert.equal(useAppStore.getState(), current);
  const accepted = previewModelGroupCopy(id, { lng: 70, lat: 0, altitude: 0 });
  state.loadProject(projectFromStore(current), null);
  assert.throws(() => applyModelGroupCopy(accepted), /组合内容已变化/);
});
test("real glTF bounds drive absolute unit and width calibration without altering original assets", async () => {
  const data = await readFile(
    new URL(
      "../apps/geolibre-desktop/public/geosandbox/teaching-block.glb",
      import.meta.url
    )
  );
  const measurement = await measureModel(data);
  assert.deepEqual(measurement.dimensions, [37, 12.5, 17]);
  assert.equal(measurement.vertices, 192);
  const layer = model("A", 118.14, 5, 2);
  layer.metadata.geosandboxMeasurement = measurement;
  const cm = calibrateModel(layer, 0, { unit: "cm" });
  const half = calibrateModel(layer, 0, { widthMetres: 18.5 });
  assert.equal(placements(cm)[0].scale, 0.01);
  assert.equal(placements(half)[0].scale, 0.5);
  assert.equal(placements(half)[0].lng, 118.14);
  assert.deepEqual(
    (cm.metadata.vizConfig as { scenegraph: unknown }).scenegraph,
    (half.metadata.vizConfig as { scenegraph: unknown }).scenegraph
  );
  assert.equal(placements(layer)[0].scale, 2);
  assert.throws(() => calibrateModel(layer, 0, { widthMetres: -1 }), /正数/);
});
