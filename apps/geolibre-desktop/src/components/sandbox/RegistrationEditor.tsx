import { useEffect, useRef, useState } from "react";
import { normalizeLongitude, useAppStore } from "@geolibre/core";
import { Button, Input, Label } from "@geolibre/ui";
import type { ModelPlan } from "../../lib/sandbox/assembly";
import {
  MAX_CONTROL_PAIRS,
  registrationPlan,
  type ControlPair,
  type RegistrationMode,
  type RegistrationReport,
} from "../../lib/sandbox/registration";

type Side = "source" | "target";
type Draft = {
  id: number;
  role: ControlPair["role"];
  source: string[];
  target: string[];
};
const SIDES = [
  ["source", "源"],
  ["target", "目标"],
] as const;
const AXES = [
  [0, "经度"],
  [1, "纬度"],
] as const;
const draft = (id: number, role: Draft["role"]): Draft => ({
  id,
  role,
  source: ["", ""],
  target: ["", ""],
});

export function RegistrationEditor({
  ids,
  busy,
  execute,
  onPreview,
  onInvalidate,
  onMapClick,
}: {
  ids: string[];
  busy: boolean;
  execute: (action: () => void) => Promise<boolean>;
  onPreview: (plan: ModelPlan) => void;
  onInvalidate: () => void;
  onMapClick: (callback: (coords: [number, number]) => void) => () => void;
}) {
  const [points, setPoints] = useState(() => [
    draft(0, "fit"),
    draft(1, "fit"),
    draft(2, "fit"),
    draft(3, "check"),
  ]);
  const [mode, setMode] = useState<RegistrationMode>("rigid");
  const [tolerance, setTolerance] = useState("1");
  const [picking, setPicking] = useState("");
  const nextId = useRef(4);
  const dispose = useRef<(() => void) | null>(null);
  useEffect(() => () => dispose.current?.(), [onMapClick]);

  function stopPicking() {
    dispose.current?.();
    dispose.current = null;
    setPicking("");
  }

  function changePoint(id: number, update: (point: Draft) => Draft) {
    setPoints((previous) =>
      previous.map((point) => (point.id === id ? update(point) : point))
    );
    onInvalidate();
  }

  function pick(id: number, side: Side) {
    const key = `${id}-${side}`;
    const alreadyPicking = picking === key;
    stopPicking();
    if (alreadyPicking) return;
    void execute(() => {
      dispose.current = onMapClick(([lng, lat]) => {
        stopPicking();
        changePoint(id, (point) => ({
          ...point,
          [side]: [String(normalizeLongitude(lng)), String(lat)],
        }));
      });
      setPicking(key);
    });
  }

  function generatePreview() {
    stopPicking();
    onInvalidate();
    const pairs = points.map(({ source, target, role }, i): ControlPair => {
      if ([...source, ...target].some((value) => !value.trim()))
        throw new Error(`请补齐第 ${i + 1} 对的源点和目标点坐标。`);
      return {
        source: { lng: Number(source[0]), lat: Number(source[1]) },
        target: { lng: Number(target[0]), lat: Number(target[1]) },
        role,
      };
    });
    const { layers, projectGeneration } = useAppStore.getState();
    onPreview(
      registrationPlan(
        layers,
        ids,
        pairs,
        mode,
        Number(tolerance),
        projectGeneration
      )
    );
  }

  return (
    <details
      className="space-y-3 rounded-md border p-3"
      onToggle={(e) => {
        if (!e.currentTarget.open) stopPicking();
      }}
    >
      <summary className="cursor-pointer text-sm font-semibold">
        控制点配准
      </summary>
      <p className="text-xs text-muted-foreground">
        配准应用于已勾选的模型。输入 WGS84 经纬度或在地图拾取，至少 3 对拟合点和
        1 对独立检查点。相似变换会同时改变模型尺寸。
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="gs-registration-mode">变换方式</Label>
          <select
            id="gs-registration-mode"
            value={mode}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            onChange={(e) => {
              setMode(e.target.value === "similarity" ? "similarity" : "rigid");
              onInvalidate();
            }}
          >
            <option value="rigid">平移与旋转</option>
            <option value="similarity">平移、旋转与缩放</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="gs-registration-tolerance">误差限值（米）</Label>
          <Input
            id="gs-registration-tolerance"
            type="number"
            step="any"
            value={tolerance}
            onChange={(e) => {
              setTolerance(e.target.value);
              onInvalidate();
            }}
          />
        </div>
      </div>
      {points.map((point, index) => (
        <fieldset className="space-y-2 rounded-md border p-2" key={point.id}>
          <legend className="px-1 text-xs font-medium">点对 {index + 1}</legend>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={point.role === "check"}
                onChange={(e) =>
                  changePoint(point.id, (previous) => ({
                    ...previous,
                    role: e.target.checked ? "check" : "fit",
                  }))
                }
              />
              独立检查点
            </label>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`删除点对 ${index + 1}`}
              disabled={points.length <= 4}
              onClick={() => {
                stopPicking();
                setPoints((current) =>
                  current.filter(({ id }) => id !== point.id)
                );
                onInvalidate();
              }}
            >
              删除
            </Button>
          </div>
          {SIDES.map(([side, name]) => (
            <div key={side} className="grid grid-cols-2 gap-2">
              {AXES.map(([axis, label]) => (
                <div key={axis} className="space-y-1">
                  <Label htmlFor={`gs-control-${point.id}-${side}-${axis}`}>
                    {name}
                    {label}
                    <span className="sr-only"> {index + 1}</span>
                  </Label>
                  <Input
                    id={`gs-control-${point.id}-${side}-${axis}`}
                    type="number"
                    step="any"
                    value={point[side][axis]}
                    onChange={(e) => {
                      const value = e.target.value;
                      changePoint(point.id, (previous) => ({
                        ...previous,
                        [side]: previous[side].map((n, i) =>
                          i === axis ? value : n
                        ),
                      }));
                    }}
                  />
                </div>
              ))}
              <Button
                className="col-span-2 hidden sm:inline-flex"
                size="sm"
                variant="outline"
                disabled={busy}
                aria-pressed={picking === `${point.id}-${side}`}
                onClick={() => pick(point.id, side)}
              >
                {picking === `${point.id}-${side}`
                  ? "等待拾取，点此取消"
                  : `在地图拾取${name}点`}
              </Button>
            </div>
          ))}
        </fieldset>
      ))}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          disabled={points.length >= MAX_CONTROL_PAIRS}
          onClick={() => {
            const point = draft(nextId.current++, "fit");
            setPoints((current) => [...current, point]);
            onInvalidate();
          }}
        >
          添加点对
        </Button>
        <Button
          disabled={busy || !ids.length}
          onClick={() => void execute(generatePreview)}
        >
          预览配准
        </Button>
      </div>
    </details>
  );
}

const metric = (value: number) =>
  Math.abs(value) < 0.001 && value !== 0
    ? value.toExponential(2)
    : String(Number(value.toFixed(3)));

export function RegistrationReview({ report }: { report: RegistrationReport }) {
  return (
    <div className="space-y-2 text-xs" aria-label="配准误差报告" role="region">
      <p>
        顺时针 {metric(report.transform.bearing)}° · 倍率{" "}
        {metric(report.transform.scale)}
      </p>
      <p>
        拟合点 RMSE {metric(report.fitRmse)} 米 · 独立检查点 RMSE{" "}
        {metric(report.checkRmse)} 米
      </p>
      <p className={report.acceptable ? undefined : "text-destructive"}>
        最大误差 {metric(report.maximumError)} 米 · 限值{" "}
        {metric(report.tolerance)} 米 ·{" "}
        {report.acceptable ? "通过" : "超出限值"}
      </p>
      <ol className="max-h-28 space-y-1 overflow-auto rounded-md border p-2">
        {report.points.map((point, index) => (
          <li key={index}>
            {index + 1}. {point.role === "fit" ? "拟合点" : "独立检查点"} ·{" "}
            {metric(point.error)} 米
          </li>
        ))}
      </ol>
    </div>
  );
}
