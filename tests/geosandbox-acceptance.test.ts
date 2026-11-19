import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inspectFile } from "../apps/geolibre-desktop/src/lib/sandbox/inspect-file";
import { measureModel } from "../apps/geolibre-desktop/src/lib/sandbox/measure-model";
import { importBundle } from "../apps/geolibre-desktop/src/lib/sandbox/bundle";

const baseline = JSON.parse(
  await readFile(
    new URL("fixtures/geosandbox/acceptance.json", import.meta.url),
    "utf8"
  )
);
for (const entry of baseline.cases) {
  test(`acceptance ${entry.id}: immutable fixture and content recognition`, async () => {
    const bytes = await readFile(new URL(`../${entry.path}`, import.meta.url));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256
    );
    assert.equal(bytes.length, entry.bytes);
    const result = await inspectFile(new File([bytes], "misleading.dat"));
    assert.equal(result.format, entry.expectedFormat);
    if (entry.expected.dimensions) {
      const measured = await measureModel(bytes);
      assert.deepEqual(measured.dimensions, entry.expected.dimensions);
    }
    if (entry.expectedFormat === "geojson")
      assert.equal(
        JSON.parse(bytes.toString()).features.length,
        entry.expected.features
      );
    if (entry.expectedFormat === "geosandbox") {
      const result = await importBundle(bytes);
      const project = JSON.parse(result.projectText);
      assert.equal(project.layers.length, entry.expected.layers);
      assert.equal(result.manifest.assets.length, entry.expected.assets);
      assert.equal(
        project.layers
          .filter((l: { type: string }) => l.type === "deckgl-viz")
          .reduce(
            (n: number, l: { source: { data: unknown[] } }) =>
              n + l.source.data.length,
            0
          ),
        entry.expected.modelInstances
      );
    }
  });
}
