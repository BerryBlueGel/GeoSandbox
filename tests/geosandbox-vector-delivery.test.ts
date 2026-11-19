import assert from "node:assert/strict";
import { test } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  prepareVectorDelivery,
  serializeVectorDelivery,
} from "../apps/geolibre-desktop/src/lib/sandbox/vector-delivery";

function layer(data: FeatureCollection): GeoLibreLayer {
  return {
    id: "data",
    name: "Survey / 1",
    type: "geojson",
    geojson: data,
    fieldVisibility: { privateId: "excluded" },
  } as GeoLibreLayer;
}

test("delivery preview scopes excluded fields and warns about the selected binary format before saving", async () => {
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "stable",
        geometry: { type: "Point", coordinates: [118.14, 39.64, 5] },
        properties: {
          exceedingly_long_field: "楼".repeat(100),
          nested: { value: 12 },
          active: true,
          privateId: "fixture-only",
        },
      },
    ],
  };
  const item = layer(data);
  const shape = prepareVectorDelivery(item, "shapefile");
  assert.equal(shape.fieldCount, 3);
  assert.match(shape.warnings.join("\n"), /丢失高程/);
  assert.match(shape.warnings.join("\n"), /254 字节/);
  assert.match(shape.warnings.join("\n"), /exceedingly_long_field/);
  const gpkg = prepareVectorDelivery(item, "geopackage");
  assert.match(gpkg.warnings.join("\n"), /布尔值/);

  const geojson = await serializeVectorDelivery(
    prepareVectorDelivery(item, "geojson")
  );
  assert.match(geojson.name, /\.geojson$/);
  const decoded = JSON.parse(new TextDecoder().decode(geojson.data));
  assert.deepEqual(
    decoded.features[0].geometry.coordinates,
    [118.14, 39.64, 5]
  );
  assert.equal(decoded.features[0].id, "stable");
  assert.equal(decoded.features[0].properties.privateId, undefined);
  assert.equal(data.features[0].properties?.privateId, "fixture-only");
});

test("delivery rejects invalid geographic positions and cannot export a shapefile made only of collections", () => {
  const item = layer({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [10000, 20000] },
        properties: {},
      },
    ],
  });
  assert.throws(() => prepareVectorDelivery(item, "geojson"), /无效经纬度/);
  item.geojson!.features[0].geometry = {
    type: "GeometryCollection",
    geometries: [{ type: "Point", coordinates: [0, 0] }],
  };
  assert.throws(
    () => prepareVectorDelivery(item, "shapefile"),
    /需要点、线或面/
  );
  assert.doesNotThrow(() => prepareVectorDelivery(item, "geopackage"));
});
