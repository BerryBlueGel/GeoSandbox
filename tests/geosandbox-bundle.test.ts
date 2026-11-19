import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import type { GeoLibreProject } from "../packages/core/src/types";
import {
  exportBundle,
  importBundle,
} from "../apps/geolibre-desktop/src/lib/sandbox/bundle";

test("portable bundle deduplicates assets and restores exact bytes without fetching online references", async () => {
  const asset = "data:model/gltf-binary;base64,AQIDBAU=";
  const project = {
    name: "Example",
    version: "0.2.0",
    layers: [{ source: { url: asset }, metadata: { model: asset } }],
    basemapStyleUrl: "https://example.invalid/map",
  } as unknown as GeoLibreProject;
  const result = await exportBundle(project);
  assert.equal(result.assetCount, 1);
  assert.deepEqual(result.externalReferences, ["https://example.invalid/map"]);
  const restored = JSON.parse((await importBundle(result.bytes)).projectText);
  assert.equal(restored.layers[0].source.url, asset);
  assert.deepEqual(restored, project);
});
test("corrupted resources, invalid version and unexpected archive paths fail closed", async () => {
  const bundle = await exportBundle({
    layers: [{ asset: "data:application/octet-stream;base64,AQID" }],
  } as unknown as GeoLibreProject);
  const files = unzipSync(bundle.bytes),
    asset = Object.keys(files).find((n) => n.startsWith("assets/"))!;
  files[asset][0] = 9;
  await assert.rejects(importBundle(zipSync(files)), /校验失败/);
  await assert.rejects(
    importBundle(zipSync({ "../outside": strToU8("x") })),
    /非预期资源路径/
  );
  const fresh = unzipSync(bundle.bytes),
    manifest = JSON.parse(strFromU8(fresh["manifest.json"]));
  manifest.version = 999;
  fresh["manifest.json"] = strToU8(JSON.stringify(manifest));
  await assert.rejects(importBundle(zipSync(fresh)), /不支持/);
});
test("blob resources survive session URL revocation after export", async () => {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array([7, 8, 9])], { type: "image/tiff" })
  );
  const result = await exportBundle({
    layers: [{ source: { url } }],
  } as unknown as GeoLibreProject);
  URL.revokeObjectURL(url);
  const restored = JSON.parse((await importBundle(result.bytes)).projectText);
  assert.equal(restored.layers[0].source.url, "data:image/tiff;base64,BwgJ");
});
