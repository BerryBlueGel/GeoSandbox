import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  getBounds,
  getSceneVertexCount,
  VertexCountMethod,
} from "@gltf-transform/functions";

export interface ModelMeasurement {
  dimensions: [number, number, number];
  vertices: number;
  basis: "glTF-metres";
}
export async function measureModel(
  data: Uint8Array
): Promise<ModelMeasurement> {
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
  const binary =
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
      0,
      true
    ) === 0x46546c67;
  const document = binary
    ? await io.readBinary(data)
    : await io.readJSON({
        json: JSON.parse(new TextDecoder().decode(data)),
        resources: {},
      });
  const scene =
    document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) throw new Error("模型没有可测量场景。");
  const { min, max } = getBounds(scene);
  const dimensions = max.map((value, index) => value - min[index]) as [
    number,
    number,
    number
  ];
  if (
    !dimensions.every((v) => Number.isFinite(v) && v >= 0) ||
    !dimensions.some((v) => v > 0)
  )
    throw new Error("模型没有有效静态几何包围盒。");
  return {
    dimensions,
    vertices: getSceneVertexCount(scene, VertexCountMethod.UPLOAD),
    basis: "glTF-metres",
  };
}
