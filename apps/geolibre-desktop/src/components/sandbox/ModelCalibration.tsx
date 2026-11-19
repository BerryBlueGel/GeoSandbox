import { useState } from "react";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Button, Input, Label } from "@geolibre/ui";
import { placements } from "../../lib/sandbox/model";
import {
  calibrateModel,
  measureLayer,
  modelMeasurement,
  type UNIT_FACTORS,
} from "../../lib/sandbox/measure-model";
import type { ModelPlan } from "../../lib/sandbox/assembly";
import type { SandboxTaskExecute } from "../../lib/sandbox/tasks";

export function ModelCalibration({
  layer,
  index,
  busy,
  execute,
  executeTask,
  onPreview,
}: {
  layer: GeoLibreLayer;
  index: number;
  busy: boolean;
  execute: (action: () => Promise<void> | void) => Promise<boolean>;
  executeTask: SandboxTaskExecute;
  onPreview: (plan: ModelPlan) => void;
}) {
  const [unit, setUnit] = useState<keyof typeof UNIT_FACTORS>("m");
  const [width, setWidth] = useState("");
  const measurement = modelMeasurement(layer),
    p = placements(layer)[index];
  return (
    <section className="space-y-3 border-t pt-4" aria-label="模型单位与尺寸">
      <h3 className="text-sm font-semibold">单位与实际尺寸</h3>
      {measurement && p ? (
        <div className="rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
          <p>
            最近测量 X宽 / Y高 / Z深（glTF 标准米）：
            {measurement.dimensions
              .map((v) => Number(v.toFixed(4)))
              .join(" × ")}
          </p>
          <p className="mt-1 font-medium">
            当前实例（米）：
            {measurement.dimensions
              .map((v) => Number((v * p.scale).toFixed(4)))
              .join(" × ")}
          </p>
          <p>{measurement.vertices.toLocaleString()} 个模型顶点 · 静态包围盒</p>
        </div>
      ) : null}
      <Button
        variant="outline"
        disabled={busy}
        className="w-full"
        onClick={() =>
          void executeTask(
            {
              id: "geosandbox-measure-model",
              label: "测量模型尺寸",
              inputs: [layer],
              parameters: { layer: layer.id },
            },
            async (task) => {
              await task.stage("读取源模型并在 Worker 中测量静态几何");
              const measured = await measureLayer(layer, task.signal);
              await task.stage("校验模型版本并提交尺寸");
              task.commit(() =>
                useAppStore
                  .getState()
                  .updateLayer(layer.id, { metadata: measured.metadata })
              );
            }
          )
        }
      >
        {measurement ? "重新测量源模型" : "测量模型尺寸"}
      </Button>
      <Label htmlFor="gs-model-unit">源模型数值单位</Label>
      <select
        id="gs-model-unit"
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        value={unit}
        onChange={(e) => setUnit(e.target.value as keyof typeof UNIT_FACTORS)}
      >
        <option value="m">米 → 米（倍率 1）</option>
        <option value="cm">厘米 → 米（倍率 0.01）</option>
        <option value="mm">毫米 → 米（倍率 0.001）</option>
        <option value="ft">英尺 → 米（倍率 0.3048）</option>
      </select>
      <Button
        className="w-full"
        variant="outline"
        disabled={busy || !p}
        onClick={() =>
          void execute(() =>
            onPreview({
              changes: [
                {
                  before: layer,
                  after: calibrateModel(layer, index, { unit }),
                },
              ],
              description: `单位校准：${layer.name} · 实例 ${
                index + 1
              } · 按源数值设置米制倍率`,
            })
          )
        }
      >
        预览单位校准
      </Button>
      <Label htmlFor="gs-target-width">目标 X 宽度（米）</Label>
      <div className="flex gap-2">
        <Input
          id="gs-target-width"
          type="number"
          min="0"
          value={width}
          onChange={(e) => setWidth(e.target.value)}
          placeholder="已知实物宽度"
        />
        <Button
          variant="outline"
          disabled={busy || !measurement || !width}
          onClick={() =>
            void executeTask(
              {
                id: "geosandbox-preview-width",
                label: "尺寸校准预览",
                inputs: [layer],
                parameters: {
                  layer: layer.id,
                  index,
                  widthMetres: Number(width),
                  mode: "preview",
                },
              },
              async (task) => {
                await task.stage("重新读取源模型并计算实际宽度");
                const measured = await measureLayer(layer, task.signal);
                const plan: ModelPlan = {
                  changes: [
                    {
                      before: layer,
                      after: calibrateModel(measured, index, {
                        widthMetres: Number(width),
                      }),
                    },
                  ],
                  description: `尺寸校准：${layer.name} · 实例 ${
                    index + 1
                  } · 目标宽度 ${width} m`,
                  projectGeneration: useAppStore.getState().projectGeneration,
                };
                await task.stage("校验输入版本并生成待应用方案");
                task.commit(() => onPreview(plan));
              }
            )
          }
        >
          预览尺寸
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        glTF
        标准单位是米；源文件不遵守标准时人工校准。预览设置绝对缩放，只影响当前实例，保留原模型字节。替换模型后请重新测量；按宽度校准会重新读取源文件。
      </p>
    </section>
  );
}
