// Constructed test geometry; no part of this scene is a measured campus survey.
import { Document, NodeIO } from "@gltf-transform/core";
import { BoxGeometry } from "three";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "apps/geolibre-desktop/public/geosandbox");
await mkdir(target, { recursive: true });
const doc = new Document(),
  buffer = doc.createBuffer(),
  scene = doc.createScene("Teaching block - constructed example");
doc.getRoot().setDefaultScene(scene);
const concrete = doc
  .createMaterial("Concrete")
  .setBaseColorFactor([0.72, 0.78, 0.83, 1])
  .setMetallicFactor(0)
  .setRoughnessFactor(0.9);
const window = doc
  .createMaterial("Window blue")
  .setBaseColorFactor([0.17, 0.32, 0.46, 1])
  .setMetallicFactor(0.1)
  .setRoughnessFactor(0.5);
function box(name, dimensions, position, material) {
  const g = new BoxGeometry(...dimensions);
  const primitive = doc
    .createPrimitive()
    .setAttribute(
      "POSITION",
      doc
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array(g.attributes.position.array))
        .setBuffer(buffer)
    )
    .setAttribute(
      "NORMAL",
      doc
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array(g.attributes.normal.array))
        .setBuffer(buffer)
    )
    .setIndices(
      doc
        .createAccessor()
        .setType("SCALAR")
        .setArray(new Uint16Array(g.index.array))
        .setBuffer(buffer)
    )
    .setMaterial(material);
  const mesh = doc.createMesh(name).addPrimitive(primitive);
  scene.addChild(doc.createNode(name).setMesh(mesh).setTranslation(position));
  g.dispose();
}
box("Main block", [36, 12, 16], [0, 6, 0], concrete);
box("Roof cap", [37, 0.5, 17], [0, 12.25, 0], concrete);
for (const z of [-8.03, 8.03])
  for (let floor = 0; floor < 3; floor++)
    box(
      `Window strip ${z} floor ${floor}`,
      [32, 1.8, 0.08],
      [0, 2.4 + floor * 3.5, z],
      window
    );
await new NodeIO().write(path.join(target, "teaching-block.glb"), doc);
const feature = (coordinates, properties = {}) => ({
  type: "Feature",
  properties,
  geometry: { type: "Polygon", coordinates: [coordinates] },
});
const rect = (x, y, w, h) => [
  [x - w / 2, y - h / 2],
  [x + w / 2, y - h / 2],
  [x + w / 2, y + h / 2],
  [x - w / 2, y + h / 2],
  [x - w / 2, y - h / 2],
];
const fc = (features) => ({ type: "FeatureCollection", features });
const footprint = fc(
  [
    [118.14, 39.64],
    [118.1406, 39.64035],
    [118.13945, 39.64025],
  ].map(([x, y], i) =>
    feature(rect(x, y, 0.00042, 0.00015), {
      id: i + 1,
      name: `示例教学楼 ${i + 1}`,
      source: "constructed fixture",
    })
  )
);
await writeFile(
  path.join(target, "footprints.geojson"),
  JSON.stringify(footprint, null, 2)
);
await writeFile(
  path.join(target, "site.geojson"),
  JSON.stringify(
    fc([
      feature(rect(118.14, 39.6401, 0.0022, 0.0015), {
        name: "构造场地",
        source: "constructed fixture",
      }),
    ]),
    null,
    2
  )
);
for (const n of [1, 2])
  await writeFile(
    path.join(target, `roads-${n}.geojson`),
    JSON.stringify(
      fc([
        {
          type: "Feature",
          properties: {
            name: `示例道路 ${n}`,
            ...(n === 1 ? { width: 6 } : { class: "walkway" }),
          },
          geometry: {
            type: "LineString",
            coordinates: [
              [118.1392, 39.6397 + n * 0.0002],
              [118.1408, 39.6397 + n * 0.0002],
            ],
          },
        },
      ]),
      null,
      2
    )
  );
console.log("Constructed GLB and GeoJSON fixtures:", target);
