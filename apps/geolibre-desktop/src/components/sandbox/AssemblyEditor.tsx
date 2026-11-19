import { useState } from "react";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Button, Input, Label } from "@geolibre/ui";
import { AssemblyGroups } from "./AssemblyGroups";
import { RegistrationEditor } from "./RegistrationEditor";
import {
  assemblyPlan,
  type AssemblyTransform,
  type ModelPlan,
} from "../../lib/sandbox/assembly";

const FIELDS = [
  ["east", "向东（米）"],
  ["north", "向北（米）"],
  ["up", "升高（米）"],
  ["bearing", "顺时针（度）"],
  ["scale", "整体倍率"],
] as const;
export function AssemblyEditor({
  models,
  busy,
  execute,
  onPreview,
  ids,
  setIds,
  readCenter,
  onCommit,
  onInvalidateRegistration,
  onMapClick,
}: {
  models: GeoLibreLayer[];
  busy: boolean;
  execute: (action: () => void) => Promise<boolean>;
  onPreview: (plan: ModelPlan) => void;
  ids: string[];
  setIds: (ids: string[]) => void;
  readCenter: () => [number, number];
  onCommit: (message: string) => void;
  onInvalidateRegistration: () => void;
  onMapClick: (callback: (coords: [number, number]) => void) => () => void;
}) {
  const [values, setValues] = useState<Record<keyof AssemblyTransform, string>>(
    { east: "0", north: "0", up: "0", bearing: "0", scale: "1" }
  );
  const layerGroups = useAppStore((state) => state.layerGroups);
  const renderer = useAppStore((state) => state.primaryRenderer);
  const groupNames = new Map(layerGroups.map(({ id, name }) => [id, name]));
  return (
    <section className="space-y-3 border-t pt-4" aria-label="模型整体变换">
      <h3 className="text-sm font-semibold">多模型整体变换</h3>
      <div className="max-h-36 space-y-2 overflow-y-auto rounded-md border p-3">
        {models.map((model) => (
          <label key={model.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ids.includes(model.id)}
              onChange={(e) => {
                setIds(
                  e.target.checked
                    ? [...ids, model.id]
                    : ids.filter((id) => id !== model.id)
                );
                onInvalidateRegistration();
              }}
            />
            <span className="min-w-0 break-words">
              {model.name}
              {model.groupId && groupNames.has(model.groupId) && (
                <span className="text-xs text-muted-foreground">
                  {` · ${groupNames.get(model.groupId)}`}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        锚点：{models.find((l) => l.id === ids[0])?.name ?? "请先选择模型"}{" "}
        的首个实例。每个勾选图层的全部实例一起变换。
      </p>
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map(([key, label]) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`gs-group-${key}`}>{label}</Label>
            <Input
              id={`gs-group-${key}`}
              type="number"
              step="any"
              value={values[key]}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        className="w-full"
        disabled={busy || !ids.length}
        onClick={() =>
          void execute(() => {
            if (Object.values(values).some((s) => !s.trim()))
              throw new Error("请填写全部整体变换参数。");
            onPreview(
              assemblyPlan(
                models,
                ids,
                Object.fromEntries(
                  Object.entries(values).map(([key, value]) => [
                    key,
                    Number(value),
                  ])
                ) as unknown as AssemblyTransform
              )
            );
          })
        }
      >
        预览整体变换
      </Button>
      <p className="text-xs leading-relaxed text-muted-foreground">
        局部场景限锚点 5
        km。源模型保持独立；整体旋转和缩放同时影响实例间距，应用后可一步撤销。
      </p>
      <Button
        variant="outline"
        className="w-full"
        onClick={() => useAppStore.getState().setAssistantOpen(true)}
      >
        打开 AI 助手操作组合
      </Button>
      <RegistrationEditor
        key={renderer}
        ids={ids}
        busy={busy}
        execute={execute}
        onPreview={onPreview}
        onInvalidate={onInvalidateRegistration}
        onMapClick={onMapClick}
      />
      <AssemblyGroups
        ids={ids}
        busy={busy}
        execute={execute}
        readCenter={readCenter}
        onCommit={onCommit}
      />
    </section>
  );
}
