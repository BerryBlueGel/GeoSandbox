import type { GeoLibreLayer } from "@geolibre/core";
import type { Cartesian3 } from "cesium";
import {
  assemblyFrame,
  assemblyPlan,
  type AssemblyTransform,
  type HorizontalPoint,
  type ModelPlan,
} from "./assembly";

export type RegistrationMode = "rigid" | "similarity";
export interface ControlPair {
  source: HorizontalPoint;
  target: HorizontalPoint;
  role: "fit" | "check";
}
export interface RegistrationReport {
  mode: RegistrationMode;
  tolerance: number;
  transform: AssemblyTransform;
  fitRmse: number;
  checkRmse: number;
  maximumError: number;
  acceptable: boolean;
  points: Array<ControlPair & { error: number }>;
}

export const MAX_CONTROL_PAIRS = 20;

function requireDistinct(points: Cartesian3[]) {
  for (let i = 0; i < points.length; i++) {
    for (let j = 0; j < i; j++) {
      if (
        Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < 0.01
      )
        throw new Error("同侧控制点或检查点距离不足 1 厘米，请选择不同位置。");
    }
  }
}

function centered(points: Cartesian3[]) {
  const x = points.reduce((total, point) => total + point.x, 0) / points.length;
  const y = points.reduce((total, point) => total + point.y, 0) / points.length;
  const offsets = points.map((point) => ({ x: point.x - x, y: point.y - y }));
  const xx = offsets.reduce((sum, point) => sum + point.x ** 2, 0);
  const xy = offsets.reduce((sum, point) => sum + point.x * point.y, 0);
  const yy = offsets.reduce((sum, point) => sum + point.y ** 2, 0);
  const variance = xx + yy;
  if (variance < 1e-4 || xx * yy - xy ** 2 <= 1e-8 * variance ** 2)
    throw new Error("控制点共线或过于集中，请选三个以上分布开的位置。");
  return { x, y, offsets, variance };
}

/** The closed-form least-squares fit for a rotation (and optional uniform scale) in local ENU. */
export function registrationPlan(
  layers: GeoLibreLayer[],
  ids: string[],
  pairs: ControlPair[],
  mode: RegistrationMode,
  tolerance: number,
  projectGeneration: number
): ModelPlan {
  if (!Number.isFinite(tolerance) || tolerance <= 0)
    throw new Error("误差限值必须为大于 0 的有限米数。");
  const fit = pairs.filter((pair) => pair.role === "fit");
  if (
    pairs.length > MAX_CONTROL_PAIRS ||
    fit.length < 3 ||
    fit.length === pairs.length
  )
    throw new Error("需要至少 3 对拟合点和 1 对独立检查点，合计最多 20 对。");
  const reference = fit[0];
  const sourceFrame = assemblyFrame(reference.source);
  const targetFrame = assemblyFrame(reference.target);
  const local = pairs.map((pair) => ({
    role: pair.role,
    source: sourceFrame.project(pair.source),
    target: targetFrame.project(pair.target),
  }));
  requireDistinct(local.map((pair) => pair.source));
  requireDistinct(local.map((pair) => pair.target));
  const controls = local.filter((pair) => pair.role === "fit");
  const S = centered(controls.map((pair) => pair.source));
  const T = centered(controls.map((pair) => pair.target));
  let dot = 0;
  let cross = 0;
  for (const [i, from] of S.offsets.entries()) {
    const to = T.offsets[i];
    dot += from.x * to.x + from.y * to.y;
    cross += from.x * to.y - from.y * to.x;
  }
  const correlation = Math.hypot(dot, cross);
  if (correlation <= Math.sqrt(S.variance * T.variance) * 1e-8)
    throw new Error("控制点无法确定稳定的旋转，请核对点对顺序。");
  const scale = mode === "rigid" ? 1 : correlation / S.variance;
  const a = (scale * dot) / correlation;
  const b = (scale * cross) / correlation;
  const transform = {
    east: T.x - a * S.x + b * S.y,
    north: T.y - b * S.x - a * S.y,
    up: 0,
    bearing: (-Math.atan2(cross, dot) * 180) / Math.PI,
    scale,
  };
  const points = pairs.map((pair, i) => {
    const { source, target } = local[i];
    return {
      ...pair,
      error: Math.hypot(
        a * source.x - b * source.y + transform.east - target.x,
        b * source.x + a * source.y + transform.north - target.y
      ),
    };
  });
  const meanError = (role: ControlPair["role"]) => {
    const group = points.filter((point) => point.role === role);
    return Math.sqrt(
      group.reduce((sum, point) => sum + point.error ** 2, 0) / group.length
    );
  };
  const maximumError = Math.max(...points.map((point) => point.error));
  return {
    ...assemblyPlan(layers, ids, transform, reference.target, reference.source),
    description: `以 ${fit.length} 对控制点拟合，另用 ${
      pairs.length - fit.length
    } 对检查点核对平面误差。`,
    projectGeneration,
    registration: {
      mode,
      tolerance,
      transform,
      points,
      fitRmse: meanError("fit"),
      checkRmse: meanError("check"),
      maximumError,
      acceptable: maximumError <= tolerance,
    },
  };
}
