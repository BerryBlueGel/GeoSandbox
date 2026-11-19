import { useAppStore } from "@geolibre/core";
import { z } from "zod";
import {
  registerAssistantGuidance,
  registerAssistantToolSpec,
} from "@geolibre/plugins/assistant-tool-registry";
import {
  modelConfig,
  placements,
  transformInstance,
  type Placement,
} from "./model";

import { assemblyPlan, type ModelPlan } from "./assembly";
import {
  calibrateModel,
  measureLayer,
  modelMeasurement,
} from "./measure-model";
export type { ModelPlan } from "./assembly";

const target = {
  layerId: z.string().min(1).max(256),
  index: z.number().int().nonnegative(),
};
const transformInput = z
  .object({
    ...target,
    lng: z.number().finite().min(-180).max(180).optional(),
    lat: z.number().finite().min(-90).max(90).optional(),
    altitude: z.number().finite().optional(),
    bearing: z.number().finite().optional(),
    scale: z.number().finite().positive().max(1e6).optional(),
  })
  .strict()
  .refine((args) => Object.keys(args).length > 2, "需要至少一种变换参数。");
const calibrationInput = z
  .object({
    ...target,
    unit: z.enum(["m", "cm", "mm", "ft"]).optional(),
    widthMetres: z.number().finite().positive().optional(),
  })
  .strict()
  .refine(
    (args) => (args.unit !== undefined) !== (args.widthMetres !== undefined),
    "请指定一种校准方式。"
  );
const assemblyInput = z
  .object({
    layerIds: z
      .array(target.layerId)
      .min(1)
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length, "模型 ID 不得重复。"),
    east: z.number().finite().optional(),
    north: z.number().finite().optional(),
    up: z.number().finite().optional(),
    bearing: z.number().finite().optional(),
    scale: z.number().finite().positive().max(1000).optional(),
  })
  .strict()
  .refine((args) => Object.keys(args).length > 1, "需要至少一种组合变换参数。");

export function registerSandboxTools(
  preview: (plan: ModelPlan) => void,
  getAssemblySelection: () => string[] = () => []
): () => void {
  const lifetime = new AbortController();
  let pending: AbortController | undefined;
  function request(signal: AbortSignal) {
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    pending?.abort();
    pending = new AbortController();
    const combined = AbortSignal.any([signal, lifetime.signal, pending.signal]);
    const generation = useAppStore.getState().projectGeneration;
    combined.throwIfAborted();
    return {
      signal: combined,
      publish(plan: ModelPlan) {
        combined.throwIfAborted();
        const state = useAppStore.getState();
        if (
          state.projectGeneration !== generation ||
          plan.changes.some(({ before }) => !state.layers.includes(before))
        )
          throw new Error("任务期间项目或模型已变化，请重新生成方案。");
        preview({ ...plan, projectGeneration: generation });
      },
    };
  }
  const dispose = [
    registerAssistantGuidance(
      "GeoSandbox 空间装配：使用 sandbox_inspect_models 查看模型。单位或宽度校准使用 sandbox_preview_calibration；多个模型整体移动、旋转或缩放使用 sandbox_preview_assembly。所有这些工具都只预览，需用户应用。修改位置、朝向或缩放时调用 sandbox_preview_transform，生成待用户应用的方案；此工具不直接修改数据。告诉用户在空间装配面板中应用。禁止声称预览已执行，也不要以脚本绕过预览。坐标必须是 WGS84 经度/纬度；高度为相对地面偏移（米），不能将绝对海拔直接填入；朝向单位为度，缩放为无量纲倍率。单位、高程基准和对象不明确时先澄清。",
      "geosandbox"
    ),
    registerAssistantToolSpec(
      {
        name: "sandbox_inspect_models",
        description:
          "读取沙盒模型及各实例的位置、朝向和缩放，不读取模型二进制或凭据。",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        callback: (input, { signal } = { signal: lifetime.signal }) => {
          z.object({}).strict().parse(input);
          signal.throwIfAborted();
          lifetime.signal.throwIfAborted();
          return useAppStore
            .getState()
            .layers.filter((l) => modelConfig(l))
            .map((l) => ({
              id: l.id,
              selectedInLayers: useAppStore.getState().selectedLayerId === l.id,
              selectedForAssembly: getAssemblySelection().includes(l.id),
              name: l.name,
              instances: placements(l),
              measurement: (() => {
                const m = modelMeasurement(l);
                return m
                  ? {
                      dimensions: m.dimensions,
                      vertices: m.vertices,
                      basis: m.basis,
                    }
                  : null;
              })(),
              heightUnit: "metre",
              heightMode: "relative-to-ground",
            }));
        },
      },
      "geosandbox"
    ),
    registerAssistantToolSpec(
      {
        name: "sandbox_preview_transform",
        description:
          "预览一个模型实例的变换。用户需要在空间装配中应用；该工具不执行修改。index 从 0 开始。",
        inputSchema: {
          type: "object",
          properties: {
            layerId: { type: "string" },
            index: { type: "integer", minimum: 0 },
            lng: { type: "number" },
            lat: { type: "number" },
            altitude: { type: "number" },
            bearing: { type: "number" },
            scale: { type: "number" },
          },
          required: ["layerId", "index"],
          additionalProperties: false,
        },
        callback: (input, { signal } = { signal: lifetime.signal }) => {
          const args = transformInput.parse(input);
          const current = request(signal);
          const layer = useAppStore
            .getState()
            .layers.find((l) => l.id === args.layerId);
          if (!layer || !modelConfig(layer))
            throw new Error("模型不存在，请重新查询。");
          const index = args.index,
            p = placements(layer)[index];
          if (!p) throw new Error("实例不存在。");
          const next: Placement = { ...p };
          for (const key of [
            "lng",
            "lat",
            "altitude",
            "bearing",
            "scale",
          ] as const)
            if (args[key] !== undefined) {
              next[key] = args[key];
            }
          const after = transformInstance(layer, index, next);
          current.publish({
            changes: [{ before: layer, after }],
            description: `AI：${layer.name} · 实例 ${index + 1}`,
          });
          return {
            status: "awaiting_user_apply",
            before: p,
            after: next,
            undoable: true,
          };
        },
      },
      "geosandbox"
    ),
    registerAssistantToolSpec(
      {
        name: "sandbox_preview_calibration",
        description:
          "以用户明确给出的源单位或目标 X 宽度（米）预览单个实例校准。只生成待应用方案，不猜测单位。unit 和 widthMetres 二选一。",
        inputSchema: {
          type: "object",
          properties: {
            layerId: { type: "string" },
            index: { type: "integer", minimum: 0 },
            unit: { type: "string", enum: ["m", "cm", "mm", "ft"] },
            widthMetres: { type: "number", exclusiveMinimum: 0 },
          },
          required: ["layerId", "index"],
          additionalProperties: false,
        },
        callback: async (input, { signal } = { signal: lifetime.signal }) => {
          const args = calibrationInput.parse(input);
          const current = request(signal);
          const before = useAppStore
            .getState()
            .layers.find((l) => l.id === args.layerId);
          if (
            !before ||
            !modelConfig(before) ||
            !placements(before)[args.index]
          )
            throw new Error("请指定有效模型、实例和一种校准方式。");
          const measured =
            args.widthMetres !== undefined
              ? await measureLayer(before, current.signal)
              : before;
          const after = calibrateModel(
            measured,
            args.index,
            args.unit !== undefined
              ? { unit: args.unit }
              : { widthMetres: args.widthMetres! }
          );
          current.publish({
            changes: [{ before, after }],
            description: `AI 单位/尺寸校准：${before.name} · 实例 ${
              args.index + 1
            }`,
          });
          return {
            status: "awaiting_user_apply",
            before: placements(before)[args.index],
            after: placements(after)[args.index],
          };
        },
      },
      "geosandbox"
    ),
    registerAssistantToolSpec(
      {
        name: "sandbox_preview_assembly",
        description:
          "将明确选定的模型图层作为局部组合，按米平移、按度整体转向和统一倍率缩放。只预览，用户应用后可整体撤销；首层首实例为锚点，范围限5km。",
        inputSchema: {
          type: "object",
          properties: {
            layerIds: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 64,
            },
            east: { type: "number" },
            north: { type: "number" },
            up: { type: "number" },
            bearing: { type: "number" },
            scale: { type: "number", exclusiveMinimum: 0 },
          },
          required: ["layerIds"],
          additionalProperties: false,
        },
        callback: (input, { signal } = { signal: lifetime.signal }) => {
          const args = assemblyInput.parse(input);
          const current = request(signal);
          const plan = assemblyPlan(
            useAppStore.getState().layers,
            args.layerIds,
            {
              east: args.east ?? 0,
              north: args.north ?? 0,
              up: args.up ?? 0,
              bearing: args.bearing ?? 0,
              scale: args.scale ?? 1,
            }
          );
          current.publish(plan);
          return {
            status: "awaiting_user_apply",
            modelCount: plan.changes.length,
          };
        },
      },
      "geosandbox"
    ),
  ];
  return () => {
    lifetime.abort();
    pending?.abort();
    dispose.forEach((fn) => fn());
  };
}
