import type { GeoLibreLayer } from "@geolibre/core";
import {
  createDeckVizStoreLayer,
  DEFAULT_DECK_VIZ_STYLE,
} from "@geolibre/plugins";
import {
  embedLocalGltf,
  localGltfMime,
  MAX_LOCAL_GLTF_BYTES,
} from "../local-gltf";
import { validatePlacement, type Placement } from "./model";
import { measureModelInBackground } from "./measure-worker";

/** Reuse GeoLibre's self-contained-asset validator; honor our own assembly anchor. */
export async function importedModel(
  name: string,
  data: ArrayBuffer,
  center: [number, number],
  signal?: AbortSignal
): Promise<GeoLibreLayer> {
  signal?.throwIfAborted();
  if (data.byteLength > MAX_LOCAL_GLTF_BYTES)
    throw new Error("单个模型超过 24 MiB，请先拆分或简化模型。");
  let mime: string;
  try {
    mime = localGltfMime(data);
  } catch (error) {
    if (error instanceof Error && error.message === "externalResources")
      throw new Error(
        "模型引用了外部纹理或二进制文件，请先打包成资源自包含的 GLB / glTF。"
      );
    throw new Error(
      "文件不是有效的 glTF 2.0 / GLB。指定格式不会转换文件内容，请检查原文件。"
    );
  }
  const bytes = new Uint8Array(data),
    view = new DataView(data);
  const root = JSON.parse(
    new TextDecoder().decode(
      mime === "model/gltf-binary"
        ? bytes.subarray(20, 20 + view.getUint32(12, true))
        : bytes
    )
  );
  if (
    !Array.isArray(root.scenes) ||
    !root.scenes.length ||
    !Array.isArray(root.meshes) ||
    !root.meshes.some(
      (mesh: { primitives?: unknown[] } | null) =>
        Array.isArray(mesh?.primitives) && (mesh?.primitives?.length ?? 0) > 0
    )
  )
    throw new Error(
      "模型没有可显示的网格场景。请检查导出时是否包含场景和几何对象。"
    );
  const p: Placement = root.extras?.geosandbox?.importPlacement ?? {
    lng: center[0],
    lat: center[1],
    altitude: 0,
    bearing: 0,
    scale: 1,
  };
  validatePlacement(p);
  const url = await embedLocalGltf(data);
  signal?.throwIfAborted();
  const layer = createDeckVizStoreLayer({
    name: name.replace(/\.(glb|gltf)$/i, ""),
    sourcePath: name,
    config: {
      layerKind: "scenegraph",
      format: "csv-rows",
      fieldMapping: {
        lng: "lng",
        lat: "lat",
        altitude: "altitude",
        bearing: "bearing",
        scale: "scale",
      },
      style: DEFAULT_DECK_VIZ_STYLE,
      scenegraph: {
        modelUrl: url,
        sizeScale: 1,
        sizeMinPixels: 0,
        bearing: 0,
        orientationRoll: 90,
        translation: [0, 0, 0],
        altitude: 0,
      },
    },
    rows: [p],
    bounds: [p.lng, p.lat, p.lng, p.lat],
  });
  try {
    layer.metadata.geosandboxMeasurement = await measureModelInBackground(bytes, signal);
  } catch {
    signal?.throwIfAborted();
    layer.metadata.geosandboxMeasurementNote =
      "当前模型无法测量静态包围盒，可手动设置缩放。压缩或扩展资源请保留原件。";
  }
  layer.metadata.geosandboxOriginalName = name;
  signal?.throwIfAborted();
  return layer;
}
