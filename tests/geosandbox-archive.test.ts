import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";
import {
  zipArchive,
  unzipArchive,
} from "../apps/geolibre-desktop/src/lib/sandbox/archive";
import {
  exportBundle,
  importBundle,
} from "../apps/geolibre-desktop/src/lib/sandbox/bundle";
import type { GeoLibreProject } from "@geolibre/core";

test("cancelling fflate compression or extraction rejects and preserves source bytes", async () => {
  const source = new Uint8Array(4 * 1024 * 1024).fill(123);
  let controller = new AbortController();
  let running = zipArchive({ "large.bin": source }, controller.signal);
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(source[0], 123);
  assert.equal(source.byteLength, 4 * 1024 * 1024);
  const zip = zipSync({ "large.bin": source });
  controller = new AbortController();
  const extraction = unzipArchive(zip, () => true, controller.signal);
  controller.abort();
  await assert.rejects(extraction, { name: "AbortError" });
});

test("an archive filter failure releases asynchronous decompression rather than publishing partial files", async () => {
  const zip = zipSync({
    "large.bin": new Uint8Array(1024 * 1024),
    "bad.bin": new Uint8Array([1]),
  });
  await assert.rejects(
    unzipArchive(zip, (file) => {
      if (file.name === "bad.bin") throw new Error("Constructed invalid path");
      return true;
    }),
    /Constructed invalid path/
  );
});

test("already cancelled package operations never read assets or publish a project", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exportBundle({ layers: [] } as unknown as GeoLibreProject, {
      signal: controller.signal,
    }),
    { name: "AbortError" }
  );
  await assert.rejects(
    importBundle(new Uint8Array(), { signal: controller.signal }),
    { name: "AbortError" }
  );
});
