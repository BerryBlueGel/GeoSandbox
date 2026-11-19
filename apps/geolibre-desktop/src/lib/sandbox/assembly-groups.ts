import {
  useAppStore,
  type GeoLibreLayer,
  type LayerGroup,
} from "@geolibre/core";
import { assemblyPlan, type AssemblyAnchor } from "./assembly";
import { modelPlacementCount } from "./model";

export const ASSEMBLY_NAME_LIMIT = 80;
const KEEP_SHAPE = { east: 0, north: 0, up: 0, bearing: 0, scale: 1 };

export function modelGroupMembers(
  layers: GeoLibreLayer[],
  groups: LayerGroup[],
  id: string
) {
  const members = layers.filter((layer) => layer.groupId === id);
  if (groups.some((group) => group.parentId === id) || !members.length)
    return [];
  return members.every((layer) => modelPlacementCount(layer) > 0)
    ? members
    : [];
}

export function saveModelGroup(name: string, ids: string[]): string {
  const title = name.trim();
  if (!title || title.length > ASSEMBLY_NAME_LIMIT)
    throw new Error(`请填写 1～${ASSEMBLY_NAME_LIMIT} 字的组合名称。`);
  const state = useAppStore.getState();
  const selected = new Set(ids);
  const ordered = state.layers
    .filter((layer) => selected.has(layer.id))
    .map((layer) => layer.id);
  if (ordered.length !== selected.size)
    throw new Error("所选模型已变化，请重新选择。");
  const plan = assemblyPlan(state.layers, ordered, KEEP_SHAPE);
  const [first] = plan.changes;
  const parentId = first.before.groupId;
  if (plan.changes.some(({ before }) => before.groupId !== parentId))
    throw new Error("请从同一图层分组或同一顶层选择模型，以保留原有分组设置。");
  return state.addLayerGroup(title, ordered, parentId);
}

export interface ModelGroupCopy {
  source: LayerGroup;
  members: GeoLibreLayer[];
  layers: GeoLibreLayer[];
  anchor: AssemblyAnchor;
  projectGeneration: number;
}

export function previewModelGroupCopy(
  id: string,
  destination: AssemblyAnchor
): ModelGroupCopy {
  const state = useAppStore.getState();
  const source = state.layerGroups.find((group) => group.id === id);
  const members = modelGroupMembers(state.layers, state.layerGroups, id);
  if (!source || !members.length)
    throw new Error("请选择只包含模型图层的组合。");
  const { changes } = assemblyPlan(
    members,
    members.map((layer) => layer.id),
    KEEP_SHAPE,
    destination
  );
  return {
    source,
    members,
    layers: changes.map(({ after }) => after),
    anchor: { ...destination },
    projectGeneration: state.projectGeneration,
  };
}

export function applyModelGroupCopy(plan: ModelGroupCopy): LayerGroup {
  const state = useAppStore.getState();
  const members = modelGroupMembers(
    state.layers,
    state.layerGroups,
    plan.source.id
  );
  if (
    state.projectGeneration !== plan.projectGeneration ||
    !state.layerGroups.includes(plan.source) ||
    members.length !== plan.members.length ||
    members.some((layer, i) => layer !== plan.members[i])
  )
    throw new Error("组合内容已变化，请重新预览。");

  const id = crypto.randomUUID();
  const existing = new Set(state.layerGroups.map((group) => group.name));
  const base = `${plan.source.name.slice(0, ASSEMBLY_NAME_LIMIT - 10)} 副本`;
  let name = base;
  for (let n = 2; existing.has(name); n++) name = `${base} ${n}`;
  const copy = { ...plan.source, id, name, collapsed: false, visible: true };
  const layers = plan.layers.map((layer) => ({
    ...layer,
    id: crypto.randomUUID(),
    groupId: id,
    beforeId: undefined,
  }));
  useAppStore.setState({
    layers: [...state.layers, ...layers],
    layerGroups: [...state.layerGroups, copy],
    isDirty: true,
  });
  return copy;
}
