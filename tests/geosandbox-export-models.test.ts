import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { WebIO } from "@gltf-transform/core";
import type { GeoLibreLayer } from "../packages/core/src/types";
import {
  exportModelAssembly,
  instanceMatrix,
} from "../apps/geolibre-desktop/src/lib/sandbox/export-models";

test("anchor import convention round-trips as identity at bearing 90", () => {
  const p = { lng: 118.14, lat: 39.64, altitude: 20, bearing: 90, scale: 1 };
  const m = instanceMatrix(p, p);
  m.forEach((v, i) => assert.ok(Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-8));
});
test("assembly preserves two instances, asset geometry and georeferencing metadata", async () => {
  const data = await readFile(
    new URL(
      "../apps/geolibre-desktop/public/geosandbox/teaching-block.glb",
      import.meta.url
    )
  );
  const layer = {
    id: "m",
    name: "Building",
    type: "deckgl-viz",
    visible: true,
    source: {
      type: "deckgl-viz",
      data: [
        { lng: 118.14, lat: 39.64 },
        { lng: 118.1401, lat: 39.6401 },
      ],
    },
    metadata: {
      vizConfig: {
        layerKind: "scenegraph",
        fieldMapping: { lng: "lng", lat: "lat" },
        scenegraph: {
          modelUrl: `data:model/gltf-binary;base64,${data.toString("base64")}`,
          sizeScale: 1,
          altitude: 0,
          bearing: 0,
        },
      },
    },
  } as unknown as GeoLibreLayer;
  const result = await exportModelAssembly([layer]);
  const doc = await new WebIO().readBinary(result.bytes);
  assert.equal(doc.getRoot().getDefaultScene()!.listChildren().length, 2);
  const extras = doc.getRoot().getExtras().geosandbox as {
    importPlacement: { bearing: number };
    instances: unknown[];
  };
  assert.equal(extras.importPlacement.bearing, 90);
  assert.equal(extras.instances.length, 2);
  assert.ok(doc.getRoot().listMeshes().length > 0);
});
