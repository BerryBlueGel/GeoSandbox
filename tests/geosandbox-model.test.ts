import assert from "node:assert/strict";
import test from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/types";
import {
  duplicateInstance,
  placements,
  placementsToFootprints,
  removeInstance,
  transformInstance,
  validatePlacement,
} from "../apps/geolibre-desktop/src/lib/sandbox/model";

function layer(): GeoLibreLayer {
  return {
    id: "model",
    type: "deckgl-viz",
    name: "Building",
    source: {
      type: "deckgl-viz",
      data: [
        { x: 118.14, y: 39.64, z: 3, heading: 12, size: 2, label: "A" },
        { x: 118.15, y: 39.65, z: 9, heading: 27, size: 3, label: "B" },
      ],
    },
    visible: true,
    opacity: 1,
    metadata: {
      vizConfig: {
        layerKind: "scenegraph",
        format: "csv-rows",
        fieldMapping: {
          lng: "x",
          lat: "y",
          altitude: "z",
          bearing: "heading",
          scale: "size",
        },
        style: {},
        scenegraph: {
          modelUrl: "data:model/gltf-binary;base64,eA==",
          altitude: 20,
          bearing: 0,
          sizeScale: 10,
        },
      },
    },
  } as unknown as GeoLibreLayer;
}
test("editing an instance preserves effective transforms and attributes of siblings", () => {
  const original = layer(),
    before = placements(original),
    p = { ...before[0], lng: 119, altitude: 50, scale: 1 };
  const next = transformInstance(original, 0, p);
  assert.deepEqual(placements(next), [p, before[1]]);
  assert.deepEqual(placements(original), before);
  assert.equal(
    (next.source as { data: { label: string }[] }).data[1].label,
    "B"
  );
});
test("copy, delete and footprint placement keep a shared asset and independent instances", () => {
  const original = layer(),
    copied = duplicateInstance(original, 1);
  assert.equal(placements(copied).length, 3);
  assert.deepEqual(placements(copied)[2], placements(original)[1]);
  assert.equal(placements(removeInstance(copied, 0)).length, 2);
  const aligned = placementsToFootprints(original, [
    [118, 39],
    [119, 40],
    [120, 41],
  ]);
  assert.deepEqual(
    placements(aligned).map((p) => [p.lng, p.lat]),
    [
      [118, 39],
      [119, 40],
      [120, 41],
    ]
  );
  assert.equal(
    placements(aligned)[2].altitude,
    placements(original)[0].altitude
  );
});
test("invalid coordinates, scales and stale instance indexes are rejected", () => {
  const valid = placements(layer())[0];
  for (const patch of [
    { lng: 500 },
    { lat: 91 },
    { scale: 0 },
    { altitude: NaN },
  ])
    assert.throws(() => validatePlacement({ ...valid, ...patch }));
  assert.throws(() => transformInstance(layer(), 999, valid));
});
