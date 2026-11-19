import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { inspectFile } from "../apps/geolibre-desktop/src/lib/sandbox/inspect-file";
import {
  exportBundle,
  importBundle,
} from "../apps/geolibre-desktop/src/lib/sandbox/bundle";
import { createEmptyProject } from "@geolibre/core";

test("real GLB, GeoPackage, TIFF and zipped Shapefile are recognized with misleading names", async () => {
  for (const [path, expected] of [
    ["../apps/geolibre-desktop/public/geosandbox/teaching-block.glb", "glb"],
    ["fixtures/geosandbox/projected.gpkg", "gpkg"],
    ["fixtures/geosandbox/rgb.tif", "tif"],
    ["fixtures/geosandbox/shapefile.zip", "zip"],
  ]) {
    const bytes = await readFile(new URL(path, import.meta.url));
    const result = await inspectFile(new File([bytes], "unknown.dat"));
    assert.equal(result.format, expected);
    assert.ok(result.warnings.some((warning) => warning.includes("扩展名")));
  }
});
test("JSON shape and the actual project manifest outrank a misleading extension", async () => {
  const geo = { type: "FeatureCollection", features: [] };
  assert.equal(
    (await inspectFile(new File([JSON.stringify(geo)], "wrong.glb"))).format,
    "geojson"
  );
  const project = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({ format: "geosandbox", version: 1 })
    ),
    "project.json": strToU8("{}"),
  });
  assert.equal(
    (await inspectFile(new File([project], "project.dat"))).format,
    "geosandbox"
  );
  assert.equal(
    (await inspectFile(new File(['{"asset":{"version":"2.0"}}'], "model.json")))
      .format,
    "gltf"
  );
});
test("incomplete Shapefile archives fail before import and missing projection is explicit", async () => {
  const incomplete = zipSync({ "a.shp": new Uint8Array([1]) });
  await assert.rejects(
    inspectFile(new File([incomplete], "a.zip")),
    /组件不完整/
  );
  const withoutCrs = zipSync({
    "a.shp": new Uint8Array([1]),
    "a.shx": new Uint8Array([1]),
    "a.dbf": new Uint8Array([1]),
  });
  const result = await inspectFile(new File([withoutCrs], "a.zip"));
  assert.equal(result.format, "zip");
  assert.match(result.warnings.join(" "), /缺少 .prj/);
});
test("unknown text is never assigned the format advertised by its file name", async () => {
  const result = await inspectFile(
    new File(["This is not GIS data"], "claimed.gpkg")
  );
  assert.equal(result.format, null);
  assert.equal(
    (await inspectFile(new File(["{broken"], "claimed.json"))).format,
    null
  );
});

test("a saved project with a manifest over 64 KiB can be inspected and reopened", async () => {
  const project = createEmptyProject("Large manifest");
  project.metadata = {
    testReferences: Array.from(
      { length: 800 },
      (_, i) => `https://example.invalid/${i}/${"x".repeat(80)}`
    ),
  };
  const { bytes } = await exportBundle(project);
  assert.ok(unzipSync(bytes)["manifest.json"].length > 65536);
  const file = new File([new Uint8Array(bytes)], "renamed.dat");
  assert.equal((await inspectFile(file)).format, "geosandbox");
  assert.equal(
    JSON.parse((await importBundle(bytes)).projectText).name,
    project.name
  );
});
