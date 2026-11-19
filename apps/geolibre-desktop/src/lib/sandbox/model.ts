import type { GeoLibreLayer } from "@geolibre/core";
import type { DeckVizConfig } from "@geolibre/plugins";

export interface Placement {
  lng: number;
  lat: number;
  altitude: number;
  bearing: number;
  scale: number;
}

type Row = Record<string, unknown>;
const KEYS = {
  lng: "__gs_lng",
  lat: "__gs_lat",
  altitude: "__gs_altitude",
  bearing: "__gs_bearing",
  scale: "__gs_scale",
} as const;

export function modelConfig(layer: GeoLibreLayer): DeckVizConfig | null {
  const c = layer.metadata.vizConfig as DeckVizConfig | undefined;
  return layer.type === "deckgl-viz" &&
    c?.layerKind === "scenegraph" &&
    c.fieldMapping &&
    c.scenegraph?.modelUrl
    ? c
    : null;
}

function rows(layer: GeoLibreLayer): unknown[] {
  const data = (layer.source as { data?: unknown }).data;
  return Array.isArray(data) ? data : [];
}

export function modelPlacementCount(layer: GeoLibreLayer): number {
  return modelConfig(layer) ? rows(layer).length : 0;
}

function field(
  row: unknown,
  key: string | number | undefined,
  fallback: number
): number {
  if (key === undefined || row === null || typeof row !== "object")
    return fallback;
  const value = (row as Record<string | number, unknown>)[key];
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function placements(layer: GeoLibreLayer): Placement[] {
  const c = modelConfig(layer);
  if (!c) return [];
  const sg = c.scenegraph!;
  return rows(layer).map((row) => ({
    lng: field(row, c.fieldMapping.lng, Number.NaN),
    lat: field(row, c.fieldMapping.lat, Number.NaN),
    altitude:
      field(row, c.fieldMapping.altitude, 0) +
      (Number.isFinite(sg.altitude) ? sg.altitude : 0),
    bearing: field(
      row,
      c.fieldMapping.bearing,
      Number.isFinite(sg.bearing) ? sg.bearing : 0
    ),
    scale:
      field(row, c.fieldMapping.scale, 1) *
      (Number.isFinite(sg.sizeScale) ? sg.sizeScale : 1),
  }));
}

export function validatePlacement(p: Placement): void {
  if (!Object.values(p).every(Number.isFinite))
    throw new Error("位置、朝向和缩放必须为有限数值。");
  if (p.lng < -180 || p.lng > 180 || p.lat < -90 || p.lat > 90)
    throw new Error("经度应在 -180～180，纬度应在 -90～90；投影坐标请先转换。");
  if (p.scale <= 0 || p.scale > 1e6)
    throw new Error("缩放必须大于 0 且不超过 1000000。");
}

/** Normalize every instance before changing the shared config, preserving siblings. */
function writePlacements(
  layer: GeoLibreLayer,
  ps: Placement[],
  sourceRows: unknown[]
): GeoLibreLayer {
  const c = modelConfig(layer);
  if (!c) throw new Error("请选择 glTF / GLB 模型图层。");
  ps.forEach(validatePlacement);
  const data = ps.map((p, i) => ({
    ...(sourceRows[i] && typeof sourceRows[i] === "object"
      ? (sourceRows[i] as Row)
      : {}),
    [KEYS.lng]: p.lng,
    [KEYS.lat]: p.lat,
    [KEYS.altitude]: p.altitude,
    [KEYS.bearing]: p.bearing,
    [KEYS.scale]: p.scale,
  }));
  const lngs = ps.map((p) => p.lng),
    lats = ps.map((p) => p.lat);
  return {
    ...layer,
    source: { ...layer.source, data },
    metadata: {
      ...layer.metadata,
      bounds: ps.length
        ? [
            Math.min(...lngs),
            Math.min(...lats),
            Math.max(...lngs),
            Math.max(...lats),
          ]
        : undefined,
      vizConfig: {
        ...c,
        fieldMapping: { ...c.fieldMapping, ...KEYS },
        scenegraph: { ...c.scenegraph!, altitude: 0, bearing: 0, sizeScale: 1 },
      },
    },
  };
}

export function mapModelPlacements(
  layer: GeoLibreLayer,
  transform: (p: Placement, index: number) => Placement
): GeoLibreLayer {
  return writePlacements(layer, placements(layer).map(transform), rows(layer));
}

export function transformInstance(
  layer: GeoLibreLayer,
  index: number,
  p: Placement
): GeoLibreLayer {
  const ps = placements(layer);
  if (!Number.isInteger(index) || index < 0 || index >= ps.length)
    throw new Error("模型实例已变化，请重新选择。");
  ps[index] = p;
  return writePlacements(layer, ps, rows(layer));
}

export function duplicateInstance(
  layer: GeoLibreLayer,
  index: number
): GeoLibreLayer {
  const ps = placements(layer),
    sourceRows = rows(layer);
  if (!ps[index]) throw new Error("模型实例不存在。");
  return writePlacements(
    layer,
    [...ps, { ...ps[index] }],
    [...sourceRows, sourceRows[index]]
  );
}

export function removeInstance(
  layer: GeoLibreLayer,
  index: number
): GeoLibreLayer {
  const ps = placements(layer),
    sourceRows = rows(layer);
  if (!ps[index]) throw new Error("模型实例不存在。");
  return writePlacements(
    layer,
    ps.filter((_, i) => i !== index),
    sourceRows.filter((_, i) => i !== index)
  );
}

export function placementsToFootprints(
  layer: GeoLibreLayer,
  points: [number, number][]
): GeoLibreLayer {
  const ps = placements(layer),
    sourceRows = rows(layer);
  if (!ps[0] || !points.length)
    throw new Error("需要至少一个模型实例和一个有效轮廓。");
  return writePlacements(
    layer,
    points.map(([lng, lat], i) => ({ ...(ps[i] ?? ps[0]), lng, lat })),
    points.map((_, i) => sourceRows[i] ?? sourceRows[0])
  );
}
