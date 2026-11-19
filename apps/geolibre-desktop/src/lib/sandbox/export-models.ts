import { Document, WebIO, type mat4, type Node } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, mergeDocuments, unpartition } from "@gltf-transform/functions";
import { MAX_LOCAL_GLTF_BYTES } from "../local-gltf";
import {
  Cartesian3,
  HeadingPitchRoll,
  Matrix3,
  Matrix4,
  Transforms,
} from "cesium";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  modelConfig,
  placements,
  validatePlacement,
  type Placement,
} from "./model";

/** Use the SAME heading and axis conversion as the existing Cesium model path. */
export function instanceMatrix(p: Placement, anchor: Placement): number[] {
  validatePlacement(p);
  validatePlacement(anchor);
  const position = Cartesian3.fromDegrees(p.lng, p.lat, p.altitude);
  const q = Transforms.headingPitchRollQuaternion(
    position,
    new HeadingPitchRoll(((p.bearing - 90) * Math.PI) / 180, 0, 0)
  );
  const world = Matrix4.fromTranslationQuaternionRotationScale(
    position,
    q,
    new Cartesian3(p.scale, p.scale, p.scale)
  );
  const anchorFrame = Transforms.eastNorthUpToFixedFrame(
    Cartesian3.fromDegrees(anchor.lng, anchor.lat, anchor.altitude)
  );
  const relative = Matrix4.multiply(
    Matrix4.inverseTransformation(anchorFrame, new Matrix4()),
    world,
    new Matrix4()
  );
  const yUpToZUp = Matrix4.fromRotationTranslation(
    Matrix3.fromRotationX(Math.PI / 2)
  );
  const zUpToYUp = Matrix4.fromRotationTranslation(
    Matrix3.fromRotationX(-Math.PI / 2)
  );
  return Array.from(
    Matrix4.toArray(
      Matrix4.multiply(
        zUpToYUp,
        Matrix4.multiply(relative, yUpToZUp, new Matrix4()),
        new Matrix4()
      )
    )
  );
}

export async function exportModelAssembly(
  layers: GeoLibreLayer[],
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; metadata: object }> {
  const models = layers.filter((l) => l.visible && modelConfig(l));
  const anchor = models.flatMap(placements)[0];
  if (!anchor) throw new Error("没有可导出的可见模型实例。");
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
  const supported = new Set(
    ALL_EXTENSIONS.map((extension) => extension.EXTENSION_NAME)
  );
  const target = new Document(),
    scene = target.createScene("GeoSandbox assembly");
  target.getRoot().setDefaultScene(scene);
  let count = 0,
    total = 0;
  const records: object[] = [];
  for (const layer of models) {
    signal?.throwIfAborted();
    const sg = modelConfig(layer)!.scenegraph!;
    if (sg.translation?.some((n) => n !== 0))
      throw new Error(
        `${layer.name} 带有额外模型偏移，请先校准；本次导出已停止。`
      );
    const response = await fetch(sg.modelUrl, { signal });
    if (!response.ok) throw new Error(`无法读取模型 ${layer.name}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    total += bytes.length * placements(layer).length;
    if (total > 128 * 1024 * 1024)
      throw new Error("模型资源超过 128 MiB，请分组导出。");
    const json =
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        0,
        true
      ) === 0x46546c67
        ? await io.binaryToJSON(bytes)
        : { json: JSON.parse(new TextDecoder().decode(bytes)), resources: {} };
    const unsupported = (json.json.extensionsUsed ?? []).filter(
      (name: string) => !supported.has(name)
    );
    if (unsupported.length)
      throw new Error(
        `${layer.name} 使用尚未支持的扩展：${unsupported.join(
          ", "
        )}。请保留原模型或导出项目包。`
      );
    const source = await io.readJSON(json);
    signal?.throwIfAborted();
    if (
      source.getRoot().listAnimations().length ||
      source.getRoot().listSkins().length
    )
      throw new Error(
        "装配 GLB 暂只支持静态模型；动画/骨骼请通过项目包保留原件。"
      );
    const originalScene =
      source.getRoot().getDefaultScene() ?? source.getRoot().listScenes()[0];
    if (!originalScene) throw new Error(`${layer.name} 没有场景。`);
    for (const p of placements(layer)) {
      if (count % 16 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal?.throwIfAborted();
      }
      const map = mergeDocuments(target, source);
      for (const originalNode of source.getRoot().listNodes()) {
        (map.get(originalNode) as Node).setName(
          `${layer.name} ${count + 1}/${originalNode.getName() || "node"}`
        );
      }
      const wrapper = target
        .createNode(`${layer.name} ${++count}`)
        .setMatrix(instanceMatrix(p, anchor) as mat4);
      const roots = originalScene
        .listChildren()
        .map((node) => map.get(node) as Node);
      // A model can contain multiple scenes. Detach mapped roots before dropping those scenes.
      for (const original of source.getRoot().listScenes())
        map.get(original)?.dispose();
      for (const node of roots) wrapper.addChild(node);
      scene.addChild(wrapper);
      records.push({ layerId: layer.id, name: layer.name, placement: p });
      if (count > 2000)
        throw new Error("一次最多导出 2000 个实例，请分组导出。");
    }
  }
  await target.transform(dedup(), unpartition());
  signal?.throwIfAborted();
  const metadata = {
    format: "geosandbox-model-assembly",
    version: 1,
    crs: "WGS84",
    localAxes: "glTF right-handed Y-up, metres",
    importPlacement: {
      lng: anchor.lng,
      lat: anchor.lat,
      altitude: anchor.altitude,
      bearing: 90,
      scale: 1,
    },
    heightNote:
      "Heights are the authored offsets. Terrain elevation is not baked into the exported meshes.",
    instances: records,
  };
  target.getRoot().setExtras({ geosandbox: metadata });
  const output = await io.writeBinary(target);
  signal?.throwIfAborted();
  if (output.length > MAX_LOCAL_GLTF_BYTES)
    throw new Error(
      "组装 GLB 超过当前 24 MiB 重导入上限，请拆分导出或保存完整项目包。"
    );
  return { bytes: output, metadata };
}
