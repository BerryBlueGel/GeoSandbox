import {
  excludeHiddenFieldsFromGeojson,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { walkPositions } from "../geometry-wkb";
import {
  sanitizeExportFileName,
  shapefileFieldWarnings,
} from "../vector-export";
import { exportBinaryVectorLayer } from "../vector-exporter";

export const DELIVERY_FORMATS = {
  geojson: "GeoJSON",
  geopackage: "GeoPackage",
  shapefile: "Shapefile ZIP",
} as const;
export type DeliveryFormat = keyof typeof DELIVERY_FORMATS;

export interface VectorDelivery {
  layer: GeoLibreLayer;
  format: DeliveryFormat;
  data: FeatureCollection;
  fieldCount: number;
  warnings: string[];
}

export function prepareVectorDelivery(
  layer: GeoLibreLayer,
  format: DeliveryFormat
): VectorDelivery {
  if (!layer.geojson?.features.length)
    throw new Error("请选择含要素的矢量图层。");
  const data = excludeHiddenFieldsFromGeojson(
    layer.geojson,
    layer.fieldVisibility
  );
  const excluded = Object.entries(layer.fieldVisibility ?? {})
    .filter(([, visibility]) => visibility === "excluded")
    .map(([key]) => key);
  const warnings: string[] = [];
  if (excluded.length) warnings.push(`排除字段：${excluded.join("、")}`);

  const keys = new Set<string>();
  const encoder = new TextEncoder();
  let withHeight = 0;
  let nested = false;
  let boolean = false;
  let longText = false;
  let decimal = false;
  let collections = 0;
  for (const feature of data.features) {
    let hasExtraDimension = false;
    if (feature.geometry)
      walkPositions(feature.geometry, (point) => {
        if (
          point.length < 2 ||
          !point.every(Number.isFinite) ||
          point[0] < -180 ||
          point[0] > 180 ||
          point[1] < -90 ||
          point[1] > 90
        )
          throw new Error("发现无效经纬度。导出前请核对图层坐标系和几何。");
        hasExtraDimension ||= point.length > 2;
      });
    if (hasExtraDimension) withHeight++;
    if (feature.geometry?.type === "GeometryCollection") collections++;
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      keys.add(key);
      if (value === null) continue;
      nested ||= typeof value === "object";
      boolean ||= typeof value === "boolean";
      decimal ||= typeof value === "number" && !Number.isInteger(value);
      if (
        format === "shapefile" &&
        (typeof value === "object" || typeof value === "string")
      )
        longText ||=
          encoder.encode(
            typeof value === "string" ? value : JSON.stringify(value)
          ).length > 254;
    }
  }
  if (format !== "geojson") {
    warnings.push(
      "二进制导出为二维数据。字段会按目标格式重新命名或推断类型，原要素 ID 不作为目标记录主键保留。"
    );
    if (withHeight)
      warnings.push(`${withHeight} 个要素将丢失高程或其他附加坐标维度。`);
    if (nested) warnings.push("对象和数组属性将写为 JSON 文本。");
  }
  if (format === "geopackage" && boolean)
    warnings.push("布尔值将写为 0/1，或按混合列类型写为文本。");
  if (format === "shapefile") {
    if (
      !data.features.some(
        (feature) =>
          feature.geometry && feature.geometry.type !== "GeometryCollection"
      )
    )
      throw new Error(
        "Shapefile 需要点、线或面几何。请选择 GeoJSON 或 GeoPackage。"
      );
    warnings.push(...shapefileFieldWarnings(data));
    if (collections)
      warnings.push(`${collections} 个几何集合将写成空几何记录。`);
    if (longText) warnings.push("超过 254 字节的属性文本将被截断。");
    if (decimal)
      warnings.push("DBF 小数及混合类型字段可能取舍有效位数或写为文本。");
  }
  return { layer, format, data, fieldCount: keys.size, warnings };
}

export async function serializeVectorDelivery(plan: VectorDelivery) {
  const name = sanitizeExportFileName(plan.layer.name).slice(0, 120);
  if (plan.format === "geojson") {
    const payload = { type: "FeatureCollection", features: plan.data.features };
    return {
      data: new TextEncoder().encode(JSON.stringify(payload)),
      name: `${name}.geojson`,
      mimeType: "application/geo+json",
    };
  }
  const result = await exportBinaryVectorLayer(plan.data, plan.format, name);
  return {
    data: result.data,
    name: `${name}.${result.extension}`,
    mimeType: result.mimeType,
  };
}
