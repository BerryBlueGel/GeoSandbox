import type { GeoLibreLayer } from "@geolibre/core";
import { modelConfig, placements, transformInstance } from "./model";
import { measureModelInBackground } from "./measure-worker";

import type { ModelMeasurement } from "./measure-geometry";
export { measureModel, type ModelMeasurement } from "./measure-geometry";

export function modelMeasurement(
  layer: GeoLibreLayer
): ModelMeasurement | null {
  const value = layer.metadata.geosandboxMeasurement as
    | ModelMeasurement
    | undefined;
  return value?.basis === "glTF-metres" &&
    Array.isArray(value.dimensions) &&
    value.dimensions.length === 3 &&
    value.dimensions.every(
      (v) => typeof v === "number" && Number.isFinite(v) && v >= 0
    ) &&
    Number.isSafeInteger(value.vertices) &&
    value.vertices >= 0
    ? value
    : null;
}
export const UNIT_FACTORS = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048 } as const;
export async function measureLayer(
  layer: GeoLibreLayer,
  signal?: AbortSignal
): Promise<GeoLibreLayer> {
  const url = modelConfig(layer)?.scenegraph?.modelUrl;
  if (!url) throw new Error("需要有效的 glTF 模型。");
  const timeout = AbortSignal.timeout(30000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  requestSignal.throwIfAborted();
  const response = await fetch(url, { signal: requestSignal });
  if (!response.ok) throw new Error("无法读取模型资源。");
  const measured = await measureModelInBackground(
    new Uint8Array(await response.arrayBuffer()),
    requestSignal
  );
  requestSignal.throwIfAborted();
  return {
    ...layer,
    metadata: { ...layer.metadata, geosandboxMeasurement: measured },
  };
}
export function calibrateModel(
  layer: GeoLibreLayer,
  index: number,
  calibration: { unit: keyof typeof UNIT_FACTORS } | { widthMetres: number }
): GeoLibreLayer {
  const p = placements(layer)[index];
  if (!p) throw new Error("模型实例不存在。");
  let scale: number;
  if ("unit" in calibration) {
    scale = Object.hasOwn(UNIT_FACTORS, calibration.unit)
      ? UNIT_FACTORS[calibration.unit]
      : Number.NaN;
    if (!scale) throw new Error("不支持的模型单位。");
  } else {
    const measurement = modelMeasurement(layer);
    if (!measurement || measurement.dimensions[0] <= 0)
      throw new Error("需要先测量有效的模型 X 方向宽度。");
    if (
      !Number.isFinite(calibration.widthMetres) ||
      calibration.widthMetres <= 0
    )
      throw new Error("目标宽度必须为正数米。");
    scale = calibration.widthMetres / measurement.dimensions[0];
  }
  return transformInstance(layer, index, { ...p, scale });
}
