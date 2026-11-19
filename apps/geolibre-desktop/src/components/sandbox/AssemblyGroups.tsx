import { useMemo, useState } from "react";
import { normalizeLongitude, useAppStore } from "@geolibre/core";
import { Button, Input, Label } from "@geolibre/ui";
import {
  applyModelGroupCopy,
  ASSEMBLY_NAME_LIMIT,
  modelGroupMembers,
  previewModelGroupCopy,
  saveModelGroup,
  type ModelGroupCopy,
} from "../../lib/sandbox/assembly-groups";
import { modelPlacementCount, placements } from "../../lib/sandbox/model";

const FIELDS = [
  ["lng", "目标经度"],
  ["lat", "目标纬度"],
  ["altitude", "离地高度（米）"],
] as const;

export function AssemblyGroups({
  ids,
  busy,
  execute,
  readCenter,
  onCommit,
}: {
  ids: string[];
  busy: boolean;
  execute: (action: () => void) => Promise<boolean>;
  readCenter: () => [number, number];
  onCommit: (message: string) => void;
}) {
  const groups = useAppStore((s) => s.layerGroups);
  const layers = useAppStore((s) => s.layers);
  const options = useMemo(
    () =>
      groups.flatMap((group) => {
        const members = modelGroupMembers(layers, groups, group.id);
        return members.length ? [{ group, members }] : [];
      }),
    [groups, layers]
  );
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [target, setTarget] = useState({ lng: "", lat: "", altitude: "" });
  const [preview, setPreview] = useState<ModelGroupCopy | null>(null);
  const selected = options.find(({ group }) => group.id === id);
  const stale =
    preview &&
    (selected?.group !== preview.source ||
      selected.members.length !== preview.members.length ||
      selected.members.some((layer, i) => layer !== preview.members[i]));

  function selectGroup(nextId: string) {
    setId(nextId);
    setPreview(null);
    const state = useAppStore.getState();
    const first = modelGroupMembers(state.layers, state.layerGroups, nextId)[0];
    if (!first) return;
    const anchor = placements(first)[0];
    const [lng, lat] = readCenter();
    setTarget({
      lng: String(normalizeLongitude(lng)),
      lat: String(lat),
      altitude: String(anchor.altitude),
    });
  }

  return (
    <section className="space-y-3 border-t pt-4" aria-label="可复用的模型组合">
      <h3 className="text-sm font-semibold">可复用的模型组合</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="gs-assembly-name">组合名称</Label>
          <Input
            id="gs-assembly-name"
            value={name}
            maxLength={ASSEMBLY_NAME_LIMIT}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          disabled={busy || !ids.length || !name.trim()}
          onClick={() =>
            void execute(() => {
              selectGroup(saveModelGroup(name, ids));
              setName("");
              onCommit("已将所选模型保存为组合，可在图层树中管理。");
            })
          }
        >
          保存所选为组合
        </Button>
      </div>
      <Label htmlFor="gs-assembly-source">用于放置副本的组合</Label>
      <select
        id="gs-assembly-source"
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        value={selected?.group.id ?? ""}
        disabled={busy}
        onChange={(e) => selectGroup(e.target.value)}
      >
        <option value="">请选择组合</option>
        {options.map(({ group, members }) => (
          <option key={group.id} value={group.id}>
            {group.name} · {members.length} 层
          </option>
        ))}
      </select>
      {selected && (
        <>
          <p className="text-xs text-muted-foreground">
            锚点为 {selected.members[0].name}{" "}
            的首个实例。副本保留各实例的相对位置、朝向和倍率。
          </p>
          <div className="grid grid-cols-2 gap-3">
            {FIELDS.map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`gs-copy-${key}`}>{label}</Label>
                <Input
                  id={`gs-copy-${key}`}
                  type="number"
                  step="any"
                  value={target[key]}
                  onChange={(e) => {
                    setTarget({ ...target, [key]: e.target.value });
                    setPreview(null);
                  }}
                />
              </div>
            ))}
            <Button
              className="self-end"
              variant="outline"
              disabled={busy}
              onClick={() => {
                const [lng, lat] = readCenter();
                setTarget({
                  ...target,
                  lng: String(normalizeLongitude(lng)),
                  lat: String(lat),
                });
                setPreview(null);
              }}
            >
              取地图中心
            </Button>
          </div>
          <Button
            className="w-full"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void execute(() => {
                setPreview(null);
                if (Object.values(target).some((value) => !value.trim()))
                  throw new Error("请填写完整的放置坐标和离地高度。");
                setPreview(
                  previewModelGroupCopy(id, {
                    lng: Number(target.lng),
                    lat: Number(target.lat),
                    altitude: Number(target.altitude),
                  })
                );
              })
            }
          >
            预览放置副本
          </Button>
        </>
      )}
      {preview && (
        <div
          className="space-y-2 rounded-md border bg-muted/40 p-3"
          aria-label="组合副本预览"
          role="region"
        >
          {stale ? (
            <p role="status" className="text-xs text-destructive">
              组合内容已变化，请重新预览。
            </p>
          ) : (
            <p className="text-xs leading-relaxed">
              将新增 {preview.layers.length} 个图层、
              {preview.layers.reduce(
                (count, layer) => count + modelPlacementCount(layer),
                0
              )}{" "}
              个实例。锚点为 {Number(preview.anchor.lng.toFixed(6))},{" "}
              {Number(preview.anchor.lat.toFixed(6))}，离地{" "}
              {preview.anchor.altitude} 米。
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              disabled={busy || !!stale}
              onClick={() =>
                void execute(() => {
                  const copy = applyModelGroupCopy(preview);
                  setPreview(null);
                  onCommit(`已放置「${copy.name}」，可一步撤销。`);
                })
              }
            >
              放置副本
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPreview(null)}
            >
              取消副本预览
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
