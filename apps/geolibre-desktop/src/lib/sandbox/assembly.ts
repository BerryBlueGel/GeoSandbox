import {
  MAX_PROCESSING_HISTORY,
  useAppStore,
  type GeoLibreLayer,
  type ProcessingRun,
} from "@geolibre/core";
import { Cartesian3, Cartographic, Matrix3, Matrix4, Transforms } from "cesium";
import {
  mapModelPlacements,
  modelConfig,
  modelPlacementCount,
  placements,
  validatePlacement,
  type Placement,
} from "./model";
import type { RegistrationReport } from "./registration";

export interface ModelChange {
  before: GeoLibreLayer;
  after: GeoLibreLayer;
}
export interface ModelPlan {
  changes: ModelChange[];
  description: string;
  projectGeneration?: number;
  registration?: RegistrationReport;
}
export interface AssemblyTransform {
  east: number;
  north: number;
  up: number;
  bearing: number;
  scale: number;
}
export type AssemblyAnchor = Pick<Placement, "lng" | "lat" | "altitude">;
export type HorizontalPoint = Pick<AssemblyAnchor, "lng" | "lat">;

export function assemblyFrame(anchor: HorizontalPoint) {
  validatePlacement({ ...anchor, altitude: 0, bearing: 0, scale: 1 });
  const origin = Cartesian3.fromDegrees(anchor.lng, anchor.lat, 0);
  const frame = Transforms.eastNorthUpToFixedFrame(origin);
  const inverse = Matrix4.inverseTransformation(frame, new Matrix4());
  return {
    project(point: HorizontalPoint) {
      validatePlacement({ ...point, altitude: 0, bearing: 0, scale: 1 });
      const position = Cartesian3.fromDegrees(point.lng, point.lat, 0);
      if (Cartesian3.distance(origin, position) > 5000)
        throw new Error("组合范围超过 5 km，请按局部场景分组。");
      const local = Matrix4.multiplyByPoint(
        inverse,
        position,
        new Cartesian3()
      );
      local.z = 0;
      return local;
    },
    unproject(local: Cartesian3): HorizontalPoint {
      const point = Cartographic.fromCartesian(
        Matrix4.multiplyByPoint(frame, local, new Cartesian3())
      );
      return {
        lng: (point.longitude * 180) / Math.PI,
        lat: (point.latitude * 180) / Math.PI,
      };
    },
  };
}

/** Local ENU assembly editing; keeps georeferencing and the authored height offsets separate. */
export function assemblyPlan(
  layers: GeoLibreLayer[],
  ids: string[],
  transform: AssemblyTransform,
  destination?: HorizontalPoint & { altitude?: number },
  source?: HorizontalPoint
): ModelPlan {
  if (
    !Object.values(transform).every(Number.isFinite) ||
    transform.scale <= 0 ||
    transform.scale > 1000
  )
    throw new Error("组合参数必须为有限数值，缩放应大于 0 且不超过 1000。");
  const selected = [...new Set(ids)].map((id) =>
    layers.find((layer) => layer.id === id)
  );
  if (
    !selected.length ||
    selected.length > 64 ||
    selected.some((layer) => !layer || !modelConfig(layer))
  )
    throw new Error("请选择 1～64 个有效模型图层。");
  const models = selected as GeoLibreLayer[];
  const counts = models.map(modelPlacementCount);
  if (counts.includes(0))
    throw new Error("选中模型中有空图层，请先创建实例或取消选择。");
  const count = counts.reduce((total, n) => total + n, 0);
  if (count > 2000) throw new Error("组合需要 1～2000 个模型实例。");
  const all = models.flatMap(placements);
  const anchor = { ...all[0], ...source };
  all.forEach(validatePlacement);
  const target = { ...anchor, ...destination };
  validatePlacement({ ...target, bearing: 0, scale: 1 });
  const sameOrigin = target.lng === anchor.lng && target.lat === anchor.lat;
  const horizontalIdentity =
    sameOrigin &&
    transform.east === 0 &&
    transform.north === 0 &&
    transform.scale === 1 &&
    transform.bearing % 360 === 0;
  const frame = assemblyFrame(anchor);
  const targetFrame = sameOrigin ? frame : assemblyFrame(target);
  const rotation = Matrix3.fromRotationZ((-transform.bearing * Math.PI) / 180);
  const changes = models.map((before) => ({
    before,
    after: mapModelPlacements(before, (p) => {
      const local = frame.project(p);
      Cartesian3.multiplyByScalar(local, transform.scale, local);
      Matrix3.multiplyByVector(rotation, local, local);
      local.x += transform.east;
      local.y += transform.north;
      if (Math.hypot(local.x, local.y) > 5000)
        throw new Error("变换后超出锚点 5 km，请拆分操作。");
      let { lng, lat } = p;
      if (!horizontalIdentity) {
        if (
          p.lng === anchor.lng &&
          p.lat === anchor.lat &&
          transform.east === 0 &&
          transform.north === 0
        ) {
          ({ lng, lat } = target);
        } else {
          ({ lng, lat } = targetFrame.unproject(local));
        }
      }
      return {
        lng,
        lat,
        altitude:
          target.altitude +
          (p.altitude - anchor.altitude) * transform.scale +
          transform.up,
        bearing: p.bearing + transform.bearing,
        scale: p.scale * transform.scale,
      };
    }),
  }));
  return {
    changes,
    description: `整体变换 ${models.length} 个模型图层、${count} 个实例；锚点为所选首个图层的首个实例。`,
  };
}

/** One Zustand write gives the existing zundo history one atomic operation. */
export function applyModelPlan(plan: ModelPlan): void {
  if (plan.registration && !plan.registration.acceptable)
    throw new Error("控制点或独立检查点超出误差限值，请核对后重新配准。");
  if (
    !plan.changes.length ||
    new Set(plan.changes.map((c) => c.before.id)).size !== plan.changes.length
  )
    throw new Error("方案为空或包含重复模型。");
  useAppStore.setState((state) => {
    if (
      plan.projectGeneration !== undefined &&
      plan.projectGeneration !== state.projectGeneration
    )
      throw new Error("预览后项目已切换，请重新生成方案。");
    for (const change of plan.changes) {
      if (
        state.layers.find((layer) => layer.id === change.before.id) !==
        change.before
      )
        throw new Error("预览后数据已变化，请重新生成方案。");
      if (
        change.after.id !== change.before.id ||
        !modelConfig(change.after) ||
        !modelConfig(change.before)
      )
        throw new Error("无效模型方案。");
      placements(change.after).forEach(validatePlacement);
    }
    const changes = new Map(plan.changes.map((c) => [c.before.id, c.after]));
    let processingHistory = state.processingHistory;
    if (plan.registration) {
      const startedAt = new Date().toISOString();
      const run: ProcessingRun = {
        id: crypto.randomUUID(),
        kind: "sandbox",
        toolId: "geosandbox-control-registration",
        toolName: "控制点配准",
        engine: "browser",
        status: "success",
        startedAt,
        parameters: { ...plan.registration },
        inputLayerNames: Object.fromEntries(
          plan.changes.map(({ before }) => [before.id, before.name])
        ),
      };
      processingHistory = [...processingHistory, run].slice(
        -MAX_PROCESSING_HISTORY
      );
    }
    return {
      layers: state.layers.map((layer) => changes.get(layer.id) ?? layer),
      processingHistory,
      isDirty: true,
    };
  });
}
