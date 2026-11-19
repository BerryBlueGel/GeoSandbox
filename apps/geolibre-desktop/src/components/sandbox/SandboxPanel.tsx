import {
  applyGroupEffects,
  diagramAnchor,
  DEFAULT_LAYER_STYLE,
  parseProject,
  redactCredentials,
  registerProjectRestoreHistory,
  serializeProject,
  undo,
  redo,
  useAppStore,
} from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  createDeckVizStoreLayer,
  DEFAULT_DECK_VIZ_STYLE,
  registerFileHandler,
} from "@geolibre/plugins";
import { Button, Input, Label } from "@geolibre/ui";
import {
  Boxes,
  Copy,
  Download,
  FolderOpen,
  Redo2,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { buildProjectSnapshot } from "../../lib/build-project-snapshot";
import { triggerDownload } from "../../lib/chart-export";
import { readDeploymentEnvValue } from "../../lib/deployment-env";
import { WORKSPACE_SECTIONS, type WorkspaceSection } from "../layout/WorkspaceDock";
import { recordExplicitProjectSave } from "../../lib/project-history-session";
import { saveLocalArtifact } from "../../lib/sandbox/save-artifact";
import { ImportInspector } from "./ImportInspector";
import { ModelCalibration } from "./ModelCalibration";
import { AssemblyEditor } from "./AssemblyEditor";
import { RegistrationReview } from "./RegistrationEditor";
import { VectorDeliveryPanel } from "./VectorDeliveryPanel";
import { RecentProjects } from "./RecentProjects";
import { ArchiveLibrary } from "./ArchiveLibrary";
import { DiskRecovery } from "./DiskRecovery";
import { StorageManagement } from "./StorageManagement";
import { useDiskRecovery } from "../../hooks/useDiskRecovery";
import { useSandboxTasks } from "../../hooks/useSandboxTasks";
import { TaskStatus } from "./TaskStatus";
import { NativeJobs } from "./NativeJobs";
import { importNativeGis } from "../../lib/sandbox/native-jobs";
import type {
  SandboxTaskContext,
  SandboxTaskExecute,
} from "../../lib/sandbox/tasks";
import type { FeatureCollection } from "geojson";
import { parserFile } from "../../lib/sandbox/inspect-file";
import { applyModelPlan } from "../../lib/sandbox/assembly";
import { measureModel } from "../../lib/sandbox/measure-model";
import { embedLocalGltf } from "../../lib/local-gltf";
import { importedModel } from "../../lib/sandbox/import-model";
import { serializeVectorDelivery, type VectorDelivery } from "../../lib/sandbox/vector-delivery";
import {
  registerSandboxTools,
  type ModelPlan,
} from "../../lib/sandbox/assistant";
import {
  exportBundle,
  importBundle,
  type BundleInput,
} from "../../lib/sandbox/bundle";
import {
  duplicateInstance,
  modelConfig,
  placements,
  placementsToFootprints,
  removeInstance,
  transformInstance,
  type Placement,
} from "../../lib/sandbox/model";

interface Props {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onOpenHistory: () => void;
  mapControllerRef: RefObject<MapEngine | null>;
  navigation?: { tab: WorkspaceSection; onTabChange: (tab: WorkspaceSection) => void };
}
const DEFAULT: Placement = {
  lng: 118.14,
  lat: 39.64,
  altitude: 0,
  bearing: 0,
  scale: 1,
};
const FIELDS: [keyof Placement, string, string][] = [
  ["lng", "经度", "0.000001"],
  ["lat", "纬度", "0.000001"],
  ["altitude", "高度（米）", "0.1"],
  ["bearing", "朝向（度）", "1"],
  ["scale", "缩放", "0.01"],
];
const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const publicDemo = readDeploymentEnvValue("VITE_GEOSANDBOX_PUBLIC_DEMO") === "1";

async function persistArtifact(bytes: Uint8Array, name: string, mime: string) {
  if (!publicDemo) return saveLocalArtifact(bytes, name, mime);
  triggerDownload(new Blob([new Uint8Array(bytes)], { type: mime }), name);
  return { path: name, downloadUrl: "" };
}

export function SandboxPanel({
  open,
  onOpen,
  onClose,
  mapControllerRef,
  onOpenHistory,
  navigation,
}: Props) {
  const diskRecovery = useDiskRecovery(mapControllerRef, !publicDemo);
  const [storageRevision, setStorageRevision] = useState(0);
  const layers = useAppStore((s) => s.layers),
    selectedLayerId = useAppStore((s) => s.selectedLayerId),
    projectGeneration = useAppStore((s) => s.projectGeneration);
  const renderer = useAppStore((s) => s.primaryRenderer);
  // eslint-disable-next-line local/no-renderer-kind-checks -- This is the renderer picker itself.
  const is2d = renderer === "maplibre";
  // eslint-disable-next-line local/no-renderer-kind-checks -- This is the renderer picker itself.
  const is3d = renderer === "cesium";
  const models = layers.filter((l) => modelConfig(l)),
    vectors = layers.filter((l) => l.geojson?.features.length);
  const [localTab, setLocalTab] = useState<WorkspaceSection>("model");
  const tab = navigation?.tab ?? localTab;
  const setTab = navigation?.onTabChange ?? setLocalTab;
  const [modelId, setModelId] = useState("");
  const selected =
    models.find((l) => l.id === modelId) ??
    models.find((l) => l.id === selectedLayerId) ??
    models[0];
  const [index, setIndex] = useState(0),
    [footprintId, setFootprintId] = useState("");
  const [form, setForm] = useState(() =>
    Object.fromEntries(Object.entries(DEFAULT).map(([k, v]) => [k, String(v)]))
  );
  const [plan, setPlan] = useState<ModelPlan | null>(null),
    [message, setMessage] = useState("");
  const [actionBusy, setBusy] = useState(false),
    [error, setError] = useState("");
  const actionLock = useRef(false);
  const {
    state: taskState,
    execute: executeTask,
    cancel: cancelTask,
    isRunning: taskRunning,
  } = useSandboxTasks();
  const busy =
    actionBusy ||
    taskState.phase === "queued" ||
    taskState.phase === "running" ||
    taskState.phase === "cancelling" ||
    taskState.phase === "writing";
  const runTask = useCallback<SandboxTaskExecute>(
    (options, action) => {
      if (actionLock.current || taskRunning()) return Promise.resolve(false);
      setError("");
      setMessage("");
      return executeTask(options, action);
    },
    [executeTask, taskRunning]
  );
  useEffect(() => {
    if (!open) cancelTask("已关闭空间装配，未提交的任务结果不会应用。");
  }, [open, cancelTask]);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [savedRevision, setSavedRevision] = useState(0);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [assemblyIds, setAssemblyIds] = useState<string[]>([]);
  const assemblySelection = useRef<string[]>([]);
  const subscribeControlPoint = useCallback((callback: (coords: [number, number]) => void) => {
    const engine = mapControllerRef.current;
    if (!engine) throw new Error("地图尚未就绪，请输入坐标或稍后再试。");
    return engine.onMapClick(callback);
  }, [mapControllerRef]);
  const [ai, setAi] = useState<{ configured: boolean; model: string; settingsMutable?: boolean } | null>(
      null
    ),
    [key, setKey] = useState(""),
    [aiModel, setAiModel] = useState("deepseek-flash"),
    [verifiedModel, setVerifiedModel] = useState("");
  const modelInput = useRef<HTMLInputElement>(null),
    bundleInput = useRef<HTMLInputElement>(null);
  const disposePlacement = useRef<(() => void) | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const planIsStale =
    !!plan &&
    ((plan.projectGeneration !== undefined &&
      plan.projectGeneration !== projectGeneration) ||
      plan.changes.some((change) => !layers.includes(change.before)));
  const ps = selected ? placements(selected) : [];
  const activeIndex = Math.min(index, Math.max(0, ps.length - 1));
  useEffect(() => {
    assemblySelection.current = assemblyIds;
  }, [assemblyIds]);
  useEffect(() => {
    setAssemblyIds((previous) =>
      previous.every((id) => layers.some((l) => l.id === id))
        ? previous
        : previous.filter((id) => layers.some((l) => l.id === id))
    );
  }, [layers]);

  useEffect(() => {
    if (layers.some((l) => l.id === selectedLayerId && modelConfig(l)))
      setModelId(selectedLayerId ?? "");
  }, [selectedLayerId, layers]);
  useEffect(() => {
    const p = selected ? placements(selected)[activeIndex] : DEFAULT;
    if (p)
      setForm(
        Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]))
      );
  }, [selected, activeIndex]);
  useEffect(
    () => () => {
      disposePlacement.current?.();
      disposePlacement.current = null;
    },
    [open, selected?.id, activeIndex, renderer]
  );
  useEffect(
    () =>
      registerSandboxTools(
        (next) => {
          setPlan(next);
          const first = next.changes[0];
          setModelId(first.before.id);
          useAppStore.getState().selectLayer(first.before.id);
          const before = placements(first.before);
          const changedIndex = placements(first.after).findIndex((p, i) =>
            FIELDS.some(([key]) => p[key] !== before[i]?.[key])
          );
          setIndex(Math.max(0, changedIndex));
          setTab(next.changes.length > 1 ? "assembly" : "model");
          onOpen();
        },
        () => assemblySelection.current
      ),
    [onOpen, setTab]
  );
  useEffect(() => {
    if (open && plan) bodyRef.current?.scrollTo({ top: 0 });
  }, [open, plan]);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [tab]);
  useEffect(() => {
    if (publicDemo || !open || tab !== "delivery") return;
    const controller = new AbortController();
    fetch("/sandbox-api/status", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error("后端未就绪");
        return r.json();
      })
      .then((result) => {
        setAi(result);
        setAiModel(result.model);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAi(null);
      });
    return () => controller.abort();
  }, [open, tab]);

  useEffect(() => {
    if (error) bodyRef.current?.scrollTo({ top: 0 });
  }, [error]);

  async function run(action: () => Promise<void> | void) {
    if (actionLock.current || taskRunning()) return false;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  function commit(after: GeoLibreLayer) {
    useAppStore.getState().updateLayer(after.id, after);
    setPlan(null);
    setMessage("已应用，可使用撤销恢复。");
  }
  function numericForm(): Placement {
    if (FIELDS.some(([k]) => !form[k]?.trim()))
      throw new Error("请填写全部变换参数。");
    return Object.fromEntries(
      FIELDS.map(([k]) => [k, Number(form[k])])
    ) as unknown as Placement;
  }
  function placeOnMap() {
    if (!selected) throw new Error("请先选择模型。");
    const engine = mapControllerRef.current;
    if (!engine?.capabilities.onMapDrawing)
      throw new Error("地图尚未就绪或当前引擎不支持地图定位。");
    disposePlacement.current?.();
    const before = selected;
    let next = placements(before)[activeIndex];
    disposePlacement.current = engine.startManualPlacement(
      [next.lng, next.lat],
      {
        hint: "拖动定位点，点击完成后更新模型；整次定位可撤销。",
        doneLabel: "完成模型定位",
        onMove: ([lng, lat]) => {
          next = { ...next, lng, lat };
          setForm((previous) => ({
            ...previous,
            lng: String(lng),
            lat: String(lat),
          }));
        },
        onDone: () => {
          try {
            if (
              useAppStore.getState().layers.find((l) => l.id === before.id) !==
              before
            )
              throw new Error("定位期间模型已变化，请重新定位。");
            commit(transformInstance(before, activeIndex, next));
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
          disposePlacement.current?.();
          disposePlacement.current = null;
        },
      }
    );
    setMessage("在地图中拖动定位点，然后点击“完成模型定位”。");
  }
  const addModel = useCallback(
    async (file: Pick<File, "name" | "arrayBuffer">) =>
      runTask(
        {
          id: "geosandbox-import-model",
          label: "导入模型",
          parameters: { filename: file.name },
        },
        async (task) => {
          const state = useAppStore.getState(),
            generation = state.projectGeneration;
          const center =
            mapControllerRef.current?.readView().center ?? state.mapView.center;
          await task.stage("读取并验证模型资源");
          const data = await file.arrayBuffer();
          task.check();
          const layer = await importedModel(
            file.name,
            data,
            center,
            task.signal
          );
          if (useAppStore.getState().projectGeneration !== generation)
            throw new Error("导入期间项目已切换，请重新导入。");
          await task.stage("校验当前项目并加入模型");
          task.commit(() => {
            state.addLayer(layer);
            state.selectLayer(layer.id);
            setModelId(layer.id);
            setIndex(0);
            setMessage(
              "模型已导入。有 GeoSandbox 地理锚点时沿用原定位，否则放在当前视图中心。请校准尺寸与相对地面高度。"
            );
            setTab("model");
          });
        }
      ),
    [mapControllerRef, runTask, setTab]
  );
  async function loadDemo() {
    const state = useAppStore.getState(),
      generation = state.projectGeneration;
    if (state.layers.some((l) => l.metadata.geosandboxDemo)) {
      setMessage("示例已在当前项目中。");
      return;
    }
    const base = import.meta.env.BASE_URL;
    const [response, model] = await Promise.all([
      fetch(`${base}geosandbox/site.geojson`),
      fetch(`${base}geosandbox/teaching-block.glb`),
    ]);
    if (!response.ok || !model.ok) throw new Error("无法读取本地示例资源。");
    const geojson = await response.json(),
      modelBytes = await model.arrayBuffer(),
      url = await embedLocalGltf(modelBytes),
      measurement = await measureModel(new Uint8Array(modelBytes));
    const footprintsResponse = await fetch(
      `${base}geosandbox/footprints.geojson`
    );
    if (!footprintsResponse.ok) throw new Error("示例轮廓读取失败。");
    const footprintGeojson = await footprintsResponse.json();
    if (useAppStore.getState().projectGeneration !== generation)
      throw new Error("加载期间项目已切换，请重试。");
    const groundId = state.addGeoJsonLayer(
      "示例场地（构造数据）",
      geojson,
      "inline-demo.geojson"
    );
    state.updateLayer(groundId, {
      metadata: {
        ...useAppStore.getState().layers.find((l) => l.id === groundId)!
          .metadata,
        geosandboxDemo: true,
      },
    });
    state.setLayerStyle(groundId, {
      fillColor: "#d8e7c8",
      fillOpacity: 0.85,
      strokeColor: "#8ca38c",
      strokeWidth: 1,
    });
    const footprintLayer = state.addGeoJsonLayer(
      "建筑轮廓（构造数据）",
      footprintGeojson,
      "inline-footprints.geojson"
    );
    state.setLayerStyle(footprintLayer, {
      fillColor: "#a9b7c9",
      fillOpacity: 0.15,
      strokeColor: "#3478cf",
      strokeWidth: 2,
    });
    const layer = createDeckVizStoreLayer({
      name: "教学楼 A",
      config: {
        layerKind: "scenegraph",
        format: "csv-rows",
        fieldMapping: {
          lng: "lng",
          lat: "lat",
          altitude: "altitude",
          bearing: "bearing",
          scale: "scale",
        },
        style: DEFAULT_DECK_VIZ_STYLE,
        scenegraph: {
          modelUrl: url,
          sizeScale: 1,
          sizeMinPixels: 0,
          bearing: 0,
          orientationRoll: 90,
          translation: [0, 0, 0],
          altitude: 0,
        },
      },
      rows: [
        { lng: 118.14, lat: 39.64, altitude: 0, bearing: 0, scale: 1 },
        { lng: 118.1406, lat: 39.64035, altitude: 0, bearing: 90, scale: 1 },
        { lng: 118.13945, lat: 39.64025, altitude: 0, bearing: 0, scale: 0.85 },
      ],
      bounds: [118.139, 39.6396, 118.141, 39.641],
    });
    layer.metadata.geosandboxMeasurement = measurement;
    state.addLayer(layer);
    state.addLayerGroup("示例装配场景", [groundId, footprintLayer, layer.id]);
    state.selectLayer(layer.id);
    setModelId(layer.id);
    setIndex(0);
    setFootprintId(footprintLayer);
    state.setMapView({
      center: [118.14, 39.6401],
      zoom: 16.8,
      pitch: 0,
      bearing: 0,
      bbox: undefined,
    });
    state.setPrimaryRenderer("cesium");
    setMessage(
      "已加载本地构造场景：3 个模型实例与建筑轮廓。示例不是实测成果。"
    );
  }
  function previewAlignment(all: boolean) {
    if (!selected) throw new Error("请先选择模型。");
    const footprint = vectors.find((l) => l.id === footprintId);
    const points =
      footprint?.geojson?.features
        .filter(
          (f) =>
            f.geometry?.type === "Polygon" ||
            f.geometry?.type === "MultiPolygon"
        )
        .map((f) => diagramAnchor(f.geometry))
        .filter((p): p is [number, number] => !!p) ?? [];
    if (!points.length) throw new Error("请选择包含有效面要素的建筑轮廓图层。");
    const after = all
      ? placementsToFootprints(selected, points)
      : transformInstance(selected, activeIndex, {
          ...ps[activeIndex],
          lng: points[0][0],
          lat: points[0][1],
        });
    setPlan({
      changes: [{ before: selected, after }],
      description: all
        ? `按要素顺序放置 ${points.length} 个实例；使用各轮廓中心`
        : "将当前实例移到该图层第一个面要素的中心",
    });
  }
  async function mergeVectors(task: SandboxTaskContext) {
    const state = useAppStore.getState();
    const ids = mergeIds.filter((id) => state.layers.some((l) => l.id === id));
    if (ids.length < 2) throw new Error("请至少选择两个矢量图层。");
    await task.stage("加载已有矢量合并算法");
    const { getVectorTool, runAlgorithmInBackground } = await import(
      "@geolibre/processing"
    );
    const tool = getVectorTool("merge-layers");
    if (!tool) throw new Error("已有合并算法未加载。");
    const logs: string[] = [];
    const outputs: { name: string; geojson: FeatureCollection }[] = [];
    await task.stage("合并矢量要素；结果暂存，完成校验后才加入项目");
    await runAlgorithmInBackground(tool, {
      layers: state.layers,
      parameters: {
        layers: ids,
        addSourceField: true,
        sourceFieldName: "_gs_source",
      },
      signal: task.signal,
      log: (line) => {
        if (!task.signal.aborted) logs.push(line);
      },
      addResultLayer: (name, geojson) => {
        if (!task.signal.aborted) outputs.push({ name, geojson });
      },
    });
    if (logs.some((line) => line.startsWith("Error:")))
      throw new Error(logs.join("\n"));
    if (outputs.length !== 1)
      throw new Error("合并未返回唯一有效图层，未修改项目。");
    await task.stage("校验输入版本并提交合并结果");
    task.commit(() => {
      const id = state.addGeoJsonLayer(outputs[0].name, outputs[0].geojson);
      state.selectLayer(id);
      setMessage(logs.join("\n") || "已追加合并，可撤销。");
    });
  }
  async function saveBundle() {
    return runTask(
      { id: "geosandbox-save-project", label: "保存项目包", record: false },
      async (task) => {
        const generation = useAppStore.getState().projectGeneration;
        const snapshot = redactCredentials(
          buildProjectSnapshot(mapControllerRef)
        );
        await task.stage("收集、校验资源并异步压缩项目包");
        const result = await exportBundle(snapshot, { signal: task.signal });
        const saved = await task.persist(publicDemo ? "下载项目包" : "写入 D 盘并核对项目包回执", () =>
          persistArtifact(
            result.bytes,
            `${snapshot.name || "GeoSandbox"}.geosandbox`,
            "application/zip"
          )
        );
        task.commit(() => {
          // Match the actual snapshot, so a concurrent edit or project switch remains dirty.
          if (
            useAppStore.getState().projectGeneration === generation &&
            serializeProject(
              redactCredentials(buildProjectSnapshot(mapControllerRef))
            ) === serializeProject(snapshot)
          ) {
            useAppStore.getState().markSaved();
            recordExplicitProjectSave();
          }
          setDownloadUrl(saved.downloadUrl);
          setSavedRevision((revision) => revision + 1);
          setMessage(
            `${publicDemo ? "已发起下载" : "已保存开始时的项目快照到"} ${saved.path}\n内含 ${result.assetCount} 份本地资源；${result.externalReferences.length} 个在线引用仍需网络。`
          );
        });
      }
    );
  }
  const openBundle = useCallback(
    async (file: BundleInput) =>
      runTask(
        {
          id: "geosandbox-open-project",
          label: "校验并打开项目包",
          record: false,
          replaceProject: true,
          parameters: { filename: file.name ?? "项目包" },
        },
        async (task) => {
          await task.stage("读取项目包");
          const bytes = await file.arrayBuffer(task.signal);
          await task.stage("异步解包并校验资源哈希");
          const result = await importBundle(new Uint8Array(bytes), {
            signal: task.signal,
          });
          const project = parseProject(result.projectText),
            state = useAppStore.getState();
          const before = buildProjectSnapshot(mapControllerRef),
            beforePath = state.projectPath;
          await task.stage("检查等待期间的编辑并打开项目");
          task.commit(() => {
            state.loadProject(project, null);
            registerProjectRestoreHistory(before, beforePath, {
              ...project,
              id: useAppStore.getState().projectId,
            });
            setModelId("");
            setIndex(0);
            setPlan(null);
            setMessage("项目包已校验并打开；可撤销本次项目切换。");
          });
        }
      ),
    [mapControllerRef, runTask]
  );
  async function addBrowserGeoJson(file: File) {
    return runTask({ id: "geosandbox-import-geojson", label: "导入 GeoJSON" }, async (task) => {
      const { parseGeoJsonText } = await import("../../lib/file-io/vector-text-formats");
      const data = await parseGeoJsonText(await file.text());
      task.commit(() => {
        const state = useAppStore.getState();
        const id = state.addGeoJsonLayer(file.name, data);
        state.selectLayer(id);
        setMessage(`已导入 ${data.features.length} 个要素。`);
      });
    });
  }

  const addVector = useCallback(
    async (
      file: Pick<File, "name" | "arrayBuffer">,
      crs = "",
      originalName = file.name,
      forceCrs = false,
      layerCrs?: Record<string, string>
    ) =>
      runTask(
        {
          id: "geosandbox-import-gis",
          label: "导入 GIS 数据",
          engine: "native-gdal",
          parameters: {
            filename: originalName,
            sourceCrs: crs,
            forceCrs,
            ...(layerCrs && Object.keys(layerCrs).length ? { layerCrs } : {}),
          },
        },
        async (task) => {
          const generation = useAppStore.getState().projectGeneration;
          const formData = new FormData();
          await task.stage("读取原始 GIS 文件");
          formData.append(
            "file",
            new Blob([await file.arrayBuffer()]),
            file.name
          );
          formData.append("source_crs", crs);
          formData.append("force_crs", String(forceCrs));
          if (layerCrs && Object.keys(layerCrs).length)
            formData.append("layer_crs", JSON.stringify(layerCrs));
          const raster = /\.tiff?$/i.test(file.name);
          const result = await importNativeGis(
            formData,
            raster ? "raster" : "vector",
            task
          );
          if (useAppStore.getState().projectGeneration !== generation)
            throw new Error("导入期间项目已切换，请重新导入。");
          const state = useAppStore.getState();
          if (
            raster &&
            (!Array.isArray(result.bounds) ||
              result.bounds.length !== 4 ||
              !result.bounds.every(Number.isFinite) ||
              typeof result.previewUrl !== "string")
          )
            throw new Error("GIS 响应缺少有效影像范围，未修改项目。");
          if (
            !raster &&
            (!Array.isArray(result.layers) ||
              !result.layers.length ||
              result.layers.some(
                (item: { name?: unknown; geojson?: FeatureCollection }) =>
                  typeof item?.name !== "string" ||
                  item.geojson?.type !== "FeatureCollection" ||
                  !Array.isArray(item.geojson.features)
              ))
          )
            throw new Error("GIS 响应缺少有效图层，未修改项目。");
          await task.stage("检查解析结果并加入项目");
          task.commit(() => {
            if (raster) {
              const [w, s, e, n] = result.bounds;
              const id = crypto.randomUUID();
              state.addLayer({
                id,
                name: `${originalName}（显示预览）`,
                type: "image",
                visible: true,
                opacity: 1,
                style: { ...DEFAULT_LAYER_STYLE },
                source: {
                  type: "image",
                  url: result.previewUrl,
                  coordinates: [
                    [w, n],
                    [e, n],
                    [e, s],
                    [w, s],
                  ],
                },
                sourcePath: originalName,
                metadata: {
                  bounds: result.bounds,
                  sourceCrs: result.sourceCrs,
                  declaredSourceCrs: result.declaredCrs,
                  sourceCrsOverridden: result.crsOverridden,
                  originalAsset: result.assetUrl,
                  geosandboxOriginalName: originalName,
                  geosandboxRasterPreview: true,
                  sourceBandCount: result.bandCount,
                  sourceDtypes: result.sourceDtypes,
                },
              });
              state.selectLayer(id);
              mapControllerRef.current?.fitBounds([w, s, e, n]);
              setMessage(
                `已使用 GDAL 生成 ${result.width} × ${result.height} 的 8 位显示预览，原始 GeoTIFF 保留在 D 盘。预览不是无损转换或定量分析数据。`
              );
              return;
            }
            for (const item of result.layers) {
              const id = state.addGeoJsonLayer(
                item.name,
                item.geojson,
                originalName
              );
              const added = useAppStore
                .getState()
                .layers.find((l) => l.id === id)!;
              state.updateLayer(id, {
                metadata: {
                  ...added.metadata,
                  sourceCrs: item.sourceCrs,
                  declaredSourceCrs: item.declaredCrs,
                  sourceCrsOverridden: item.crsOverridden,
                  originalAsset: result.assetUrl,
                  geosandboxOriginalName: originalName,
                },
              });
              state.selectLayer(id);
            }
            setMessage(
              `已导入 ${
                result.layers.length
              } 个图层，保留 D 盘原件；显示数据为 WGS84。${
                result.layers.some((layer) => layer.crsOverridden)
                  ? "已按指定图层纠正源 CRS，原标注另行记录。"
                  : ""
              }`
            );
          });
        }
      ),
    [mapControllerRef, runTask]
  );
  useEffect(
    () =>
      registerFileHandler(
        {
          id: "geosandbox-assets",
          name: "GeoSandbox",
          extensions: publicDemo ? [".glb", ".gltf", ".geosandbox"] : [".glb", ".gltf", ".geosandbox", ".gpkg"],
          claim: (files) => files,
          open: async (files) => {
            onOpen();
            setError("");
            try {
              let completed = 0;
              for (const file of files) {
                let ok: boolean;
                if (/\.geosandbox$/i.test(file.name))
                  ok = await openBundle(file);
                else if (/\.gpkg$/i.test(file.name)) {
                  setTab("data");
                  ok = await addVector(file);
                } else {
                  setTab("model");
                  ok = await addModel(file);
                }
                if (!ok)
                  throw new Error(
                    `已停止批量导入（已完成 ${completed}/${files.length} 个文件）；已完成的导入仍保留，失败或取消的文件未应用。`
                  );
                completed++;
              }
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              throw e;
            }
          },
        },
        "geosandbox"
      ),
    [onOpen, openBundle, addModel, addVector, setTab]
  );
  async function saveVector(plan: VectorDelivery) {
    return runTask({ id: "geosandbox-export-vector", label: "导出矢量成果", record: false }, async (task) => {
      const assertCurrent = () => {
        if (!useAppStore.getState().layers.includes(plan.layer))
          throw new Error("图层内容已变化，请重新检查后导出。");
      };
      assertCurrent();
      await task.stage("生成所选格式的矢量文件");
      const file = await serializeVectorDelivery(plan);
      assertCurrent();
      const saved = await task.persist(publicDemo ? "下载矢量文件" : "写入矢量文件并核对回执", () => persistArtifact(file.data, file.name, file.mimeType));
      task.commit(() => {
        setStorageRevision((value) => value + 1);
        setSavedRevision((value) => value + 1);
        setDownloadUrl(saved.downloadUrl);
        setMessage(`${publicDemo ? "已发起下载" : "已保存矢量成果到"} ${saved.path}`);
      });
    });
  }

  async function saveModels() {
    return runTask(
      {
        id: "geosandbox-export-models",
        label: "导出装配 GLB",
        record: false,
        inputs: useAppStore
          .getState()
          .layers.filter((layer) => !!modelConfig(layer)),
      },
      async (task) => {
        await task.stage("读取模型并构建静态装配；可在处理阶段取消");
        const { exportModelAssembly } = await import(
          "../../lib/sandbox/export-models"
        );
        const { layers, layerGroups } = useAppStore.getState();
        const result = await exportModelAssembly(
          applyGroupEffects(layers, layerGroups),
          task.signal
        );
        const { saved, metadata } = await task.persist(
          publicDemo ? "下载装配 GLB" : "写入 GLB 与独立锚点说明并核对回执",
          async () => {
            const saved = await persistArtifact(
              result.bytes,
              "GeoSandbox_assembly.glb",
              "model/gltf-binary"
            );
            if (publicDemo) return { saved, metadata: null };
            try {
              const metadata = await saveLocalArtifact(
                new TextEncoder().encode(
                  JSON.stringify(result.metadata, null, 2)
                ),
                "GeoSandbox_assembly.geo.json",
                "application/json"
              );
              return { saved, metadata };
            } catch (error) {
              throw new Error(
                `GLB 本体已保存到 ${
                  saved.path
                }（内含地理锚点），独立锚点 JSON 尚未确认：${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
        );
        task.commit(() => {
          setDownloadUrl(saved.downloadUrl);
          setMessage(
            metadata
              ? `已保存到 ${saved.path}\n锚点说明：${metadata.path}\n地理锚点同时位于 glTF extras.geosandbox；不烘入地形高度。`
              : `已发起下载 ${saved.path}，地理锚点随模型一同导出。`
          );
        });
      }
    );
  }
  async function saveAi() {
    setVerifiedModel("");
    const response = await fetch("/sandbox-api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: aiModel.trim(),
        ...(key.trim() ? { apiKey: key.trim() } : {}),
      }),
    });
    if (!response.ok)
      throw new Error("保存失败，请确认本地后端已启动且模型名称有效。");
    const result = await response.json();
    setAi(result);
    setKey("");
    setMessage(
      result.configured
        ? "DeepSeek 配置已保存。可打开已有 AI 助手使用。"
        : "模型配置已保存，仍需填写 API Key。"
    );
  }
  async function checkAi() {
    setVerifiedModel("");
    const response = await fetch("/ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "This is a connection test. Reply OK." },
        ],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error?.message ?? result.detail ?? "DeepSeek 连接测试失败。"
      );
    if (
      typeof result.choices?.[0]?.message?.content !== "string" ||
      !result.choices[0].message.content.trim()
    )
      throw new Error("DeepSeek 未返回有效文本，请检查模型配置。");
    setVerifiedModel(result.model);
    setMessage(
      `真实生成测试通过 · 模型 ${result.model} · ${
        result.usage?.total_tokens ?? "未知"
      } tokens。使用固定短提示，未发送图层数据。`
    );
  }

  if (!open) return null;
  return (
    <aside
      aria-label="空间装配面板"
      data-testid="sandbox-panel"
      className={navigation
        ? "gs-workspace-inspector z-40 flex min-h-0 flex-col bg-card text-card-foreground"
        : "absolute end-0 top-14 bottom-7 z-40 flex w-full flex-col border-l bg-card text-card-foreground shadow-lg sm:w-[360px] md:top-11"}
    >
      <div className="flex items-start justify-between px-4 pt-4 pb-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {navigation ? WORKSPACE_SECTIONS[tab].title : "空间装配"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {navigation ? WORKSPACE_SECTIONS[tab].description
              : publicDemo ? "加载示例开始体验，成果可下载到本机" : "模型定位、组合与交付"}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="关闭空间装配"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {!navigation && <div className="flex border-b px-4" role="tablist" aria-label="装配功能">
        {(
          [
            ["model", "模型"],
            ["assembly", "组合"],
            ["data", "数据"],
            ["delivery", "交付"],
          ] as const
        ).map(([value, name]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`flex-1 border-b-2 py-3 text-sm ${
              tab === value
                ? "border-primary font-medium text-primary"
                : "border-transparent text-muted-foreground"
            }`}
          >
            {name}
          </button>
        ))}
      </div>}
      <TaskStatus
        state={taskState}
        cancel={() => cancelTask()}
        history={() => useAppStore.getState().setProcessingHistoryOpen(true)}
      />
      <div
        ref={bodyRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              useAppStore.getState().setPrimaryRenderer("maplibre")
            }
            aria-pressed={is2d}
          >
            二维
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => useAppStore.getState().setPrimaryRenderer("cesium")}
            aria-pressed={is3d}
          >
            三维
          </Button>
          <span className="flex-1" />
          <Button
            size="icon"
            variant="ghost"
            aria-label="撤销装配操作"
            onClick={undo}
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="重做装配操作"
            onClick={redo}
          >
            <Redo2 className="h-4 w-4" />
          </Button>
        </div>
        {error && (
          <p
            role="alert"
            className="whitespace-pre-wrap break-all text-xs leading-relaxed text-destructive"
          >
            {error}
          </p>
        )}
        {plan && (
          <section
            aria-label="待应用方案"
            className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3"
          >
            <h3 className="text-sm font-semibold">待应用方案</h3>
            {planIsStale && (
              <p role="alert" className="text-xs text-destructive">
                原图层已变化，此方案已过期。请取消后重新生成。
              </p>
            )}
            <p className="text-xs leading-relaxed">{plan.description}</p>
            {plan.registration && <RegistrationReview report={plan.registration} />}
            <p className="text-xs text-muted-foreground">
              模型图层：{plan.changes.length} · 实例数量：
              {plan.changes.reduce(
                (n, c) => n + placements(c.before).length,
                0
              )}{" "}
              →{" "}
              {plan.changes.reduce((n, c) => n + placements(c.after).length, 0)}
            </p>
            <div className="max-h-36 space-y-2 overflow-auto text-xs">
              {plan.changes.flatMap((change) =>
                placements(change.after).map((p, i) => {
                  const before = placements(change.before)[i];
                  const changes = FIELDS.filter(
                    ([key]) => !before || p[key] !== before[key]
                  );
                  return changes.length ? (
                    <p key={`${change.before.id}-${i}`}>
                      {change.before.name} · 实例 {i + 1}：
                      {changes
                        .map(
                          ([key, label]) =>
                            `${label} ${before?.[key] ?? "新增"} → ${Number(
                              p[key].toFixed(6)
                            )}`
                        )
                        .join("；")}
                    </p>
                  ) : null;
                })
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                disabled={planIsStale || busy || plan.registration?.acceptable === false}
                onClick={() =>
                  void run(() => {
                    applyModelPlan(plan);
                    setPlan(null);
                    setMessage("已整体应用，可一步撤销。");
                  })
                }
              >
                应用方案
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPlan(null)}>
                取消预览
              </Button>
            </div>
          </section>
        )}
        {tab === "model" && (
          <>
            <div className={`grid grid-cols-2 gap-2 ${navigation ? "gs-model-actions" : ""}`}>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => modelInput.current?.click()}
              >
                <Upload className="me-2 h-4 w-4" />
                导入 GLB
              </Button>
              <Button
                variant={navigation ? "default" : "outline"}
                disabled={busy}
                onClick={() => void run(loadDemo)}
              >
                <Boxes className="me-2 h-4 w-4" />
                加载示例
              </Button>
            </div>
            <input
              ref={modelInput}
              hidden
              type="file"
              accept=".glb,.gltf"
              aria-label="选择模型文件"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void addModel(file);
              }}
            />
            <div className="grid grid-cols-[44px_1fr] items-center gap-3">
              <Label htmlFor="gs-model">模型</Label>
              <select
                id="gs-model"
                className={selectClass}
                value={selected?.id ?? ""}
                onChange={(e) => {
                  setModelId(e.target.value);
                  setIndex(0);
                  useAppStore.getState().selectLayer(e.target.value);
                }}
              >
                <option value="" disabled>
                  导入模型以开始
                </option>
                {models.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <Label htmlFor="gs-instance">实例</Label>
              <select
                id="gs-instance"
                className={selectClass}
                value={activeIndex}
                disabled={!ps.length}
                onChange={(e) => setIndex(Number(e.target.value))}
              >
                {ps.map((_, i) => (
                  <option key={i} value={i}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {FIELDS.map(([field, label, step]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={`gs-${field}`}>{label}</Label>
                  <Input
                    id={`gs-${field}`}
                    type="number"
                    step={step}
                    value={form[field] ?? ""}
                    disabled={!selected || busy}
                    onChange={(e) =>
                      setForm((previous) => ({
                        ...previous,
                        [field]: e.target.value,
                      }))
                    }
                  />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                disabled={!selected || busy}
                onClick={() => void run(placeOnMap)}
              >
                地图拖动定位
              </Button>
              <Button
                variant="outline"
                disabled={!selected}
                onClick={() => {
                  if (selected) mapControllerRef.current?.fitLayer(selected);
                }}
              >
                定位模型
              </Button>
            </div>
            <Button
              className="w-full"
              disabled={!selected || busy}
              onClick={() =>
                void run(() => {
                  if (selected)
                    commit(
                      transformInstance(selected, activeIndex, numericForm())
                    );
                })
              }
            >
              应用变换
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                disabled={!selected || busy}
                onClick={() =>
                  void run(() => {
                    if (selected) {
                      commit(duplicateInstance(selected, activeIndex));
                      setIndex(ps.length);
                    }
                  })
                }
              >
                <Copy className="me-2 h-4 w-4" />
                复制实例
              </Button>
              <Button
                variant="outline"
                disabled={!selected || busy}
                onClick={() =>
                  void run(() => {
                    if (!selected) return;
                    if (ps.length === 1)
                      useAppStore.getState().removeLayer(selected.id);
                    else commit(removeInstance(selected, activeIndex));
                    setIndex(0);
                  })
                }
              >
                <Trash2 className="me-2 h-4 w-4" />
                删除实例
              </Button>
            </div>
            {selected && (
              <ModelCalibration
                key={`${selected.id}-${activeIndex}`}
                layer={selected}
                index={activeIndex}
                busy={busy}
                execute={run}
                executeTask={runTask}
                onPreview={setPlan}
              />
            )}

            <section className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-semibold">轮廓对齐</h3>
              <select
                aria-label="建筑轮廓图层"
                className={selectClass}
                value={footprintId}
                onChange={(e) => setFootprintId(e.target.value)}
              >
                <option value="">选择建筑轮廓</option>
                {vectors.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  disabled={!selected || busy}
                  onClick={() => void run(() => previewAlignment(false))}
                >
                  预览对齐
                </Button>
                <Button
                  variant="outline"
                  disabled={!selected || busy}
                  onClick={() => void run(() => previewAlignment(true))}
                >
                  按轮廓批量放置
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                使用轮廓中心辅助摆放。批量按要素顺序生成实例，保留源模型；不推断模型语义和精确配准。
              </p>
            </section>
          </>
        )}
        {tab === "assembly" && (
          <AssemblyEditor
            key={projectGeneration}
            ids={assemblyIds}
            setIds={setAssemblyIds}
            models={models}
            busy={busy}
            execute={run}
            onPreview={setPlan}
            onMapClick={subscribeControlPoint}
            onInvalidateRegistration={() => setPlan((previous) => previous?.registration ? null : previous)}
            readCenter={() => (mapControllerRef.current?.readView() ?? useAppStore.getState().mapView).center}
            onCommit={(status) => {
              setPlan(null);
              setMessage(status);
            }}
          />
        )}
        {tab === "data" && (
          <>
            <ImportInspector
              busy={busy}
              browserOnly={publicDemo}
              executeTask={runTask}
              onImport={(file, format, crs, forceCrs, layerCrs) => {
                if (format === "glb" || format === "gltf") {
                  return addModel(file);
                } else if (format === "geosandbox") {
                  return openBundle(file);
                } else if (publicDemo && format === "geojson") {
                  return addBrowserGeoJson(file);
                } else {
                  return addVector(
                    parserFile(file, format),
                    crs,
                    file.name,
                    forceCrs,
                    layerCrs
                  );
                }
              }}
            />
            {!publicDemo && <NativeJobs refreshWhen={taskState.phase} />}
            <div className="divide-y rounded-md border">
              {layers.length ? (
                layers.map((l) => (
                  <button
                    key={l.id}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-muted"
                    onClick={() => useAppStore.getState().selectLayer(l.id)}
                  >
                    <span className="truncate">{l.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {modelConfig(l)
                        ? `${placements(l).length} 个实例`
                        : l.geojson
                        ? `${l.geojson.features.length} 个要素`
                        : l.type}
                    </span>
                  </button>
                ))
              ) : (
                <p className="p-3 text-sm text-muted-foreground">
                  尚未导入数据。
                </p>
              )}
            </div>
            <section className="space-y-3 border-t pt-3">
              <h3 className="text-sm font-semibold">矢量追加合并</h3>
              {vectors.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={mergeIds.includes(l.id)}
                    onChange={(e) =>
                      setMergeIds((previous) =>
                        e.target.checked
                          ? [...previous, l.id]
                          : previous.filter((id) => id !== l.id)
                      )
                    }
                  />
                  {l.name}
                </label>
              ))}
              <Button
                variant="outline"
                className="w-full"
                disabled={busy || mergeIds.length < 2}
                onClick={() =>
                  void runTask(
                    {
                      id: "geosandbox-merge-layers",
                      label: "沙盒矢量合并",
                      inputs: layers.filter((layer) =>
                        mergeIds.includes(layer.id)
                      ),
                      parameters: { layers: mergeIds },
                    },
                    mergeVectors
                  )
                }
              >
                追加合并所选图层
              </Button>
              <p className="text-xs text-muted-foreground">
                保留原图层，补齐缺失字段并记录 _gs_source；操作可撤销。
              </p>
            </section>
            <Button
              className="w-full"
              variant="outline"
              onClick={() => useAppStore.getState().setProcessingOpen(true)}
            >
              打开完整处理工具
            </Button>
          </>
        )}
        {tab === "delivery" && (
          <>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">完整项目包</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                打包当前项目、矢量数据与本地模型/影像资源，逐项校验哈希。在线底图和服务仍需网络。当前包不包含可跨会话重放的撤销栈。
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button disabled={busy} onClick={() => void saveBundle()}>
                  <Download className="me-2 h-4 w-4" />
                  {publicDemo ? "下载项目包" : "保存项目包"}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => bundleInput.current?.click()}
                >
                  <FolderOpen className="me-2 h-4 w-4" />
                  打开项目包
                </Button>
              </div>
              <input
                ref={bundleInput}
                type="file"
                hidden
                accept=".geosandbox"
                aria-label="选择项目包"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void openBundle(file);
                }}
              />
            </section>
            {!publicDemo && <>
            <DiskRecovery
              {...diskRecovery}
              revision={storageRevision}
              busy={busy}
              execute={run}
              openBundle={openBundle}
            />
            <StorageManagement
              busy={busy}
              executeTask={runTask}
              onChanged={() => setStorageRevision((value) => value + 1)}
            />
            <RecentProjects
              revision={savedRevision}
              busy={busy}
              openBundle={openBundle}
              onOpenHistory={onOpenHistory}
            />
            <ArchiveLibrary
              busy={busy}
              revision={savedRevision}
              onChanged={() => setSavedRevision((value) => value + 1)}
              openBundle={openBundle}
            />
            </>}
            <VectorDeliveryPanel key={projectGeneration} layers={vectors} busy={busy} execute={run} onExport={saveVector} />
            <section className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-semibold">三维成果</h3>
              <Button
                className="w-full"
                variant="outline"
                disabled={!models.length || busy}
                onClick={() => void saveModels()}
              >
                导出可见模型 GLB
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                支持静态模型组装；地理锚点保存在 GLB 扩展信息中，不烘入地形。GIS
                数据请用项目菜单或图层菜单导出。
              </p>
            </section>
            {!publicDemo && <section className="space-y-3 border-t pt-4">
              <div className="flex justify-between">
                <h3 className="text-sm font-semibold">DeepSeek</h3>
                <span className="text-xs text-muted-foreground">
                  {ai
                    ? ai.configured
                      ? verifiedModel === ai.model
                        ? "真实连接已验证"
                        : "已配置"
                      : "待配置"
                    : "后端未连接"}
                </span>
              </div>
              {ai?.settingsMutable === false ? (
                <p className="text-xs text-muted-foreground">
                  服务器由部署者配置 DeepSeek。当前模型 {ai.model}。
                </p>
              ) : (
                <>
              <Label htmlFor="gs-ai-model">模型名称</Label>
              <Input
                id="gs-ai-model"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
              />
              <Label htmlFor="gs-ai-key">API Key（留空保留已有密钥）</Label>
              <Input
                id="gs-ai-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="仅提交到本机服务"
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                密钥保存在系统凭据库，不写入配置文件或项目包；也可使用
                DEEPSEEK_API_KEY 环境变量。
              </p>
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={busy || !ai}
                  onClick={() => void run(saveAi)}
                >
                  保存 AI 配置
                </Button>
                </>
              )}
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={busy || !ai?.configured}
                  onClick={() => void run(checkAi)}
                >
                  测试已保存配置
                </Button>
              <p className="text-xs text-muted-foreground">
                连接测试发送固定短提示，产生少量 token 用量。
              </p>
              <Button
                className="w-full"
                onClick={() => useAppStore.getState().setAssistantOpen(true)}
              >
                打开 AI 助手
              </Button>
            </section>}
          </>
        )}
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            正在处理…
          </p>
        )}
        {message && (
          <p
            role="status"
            className="whitespace-pre-wrap break-all text-xs leading-relaxed text-muted-foreground"
          >
            {message}
          </p>
        )}
        {downloadUrl && (
          <a
            className="inline-block text-sm text-primary underline"
            href={downloadUrl}
            download
          >
            下载成果副本
          </a>
        )}
      </div>
      <div className="border-t px-4 py-3 text-xs text-muted-foreground">
        使用现有项目与撤销历史 · 基于 GeoLibre
      </div>
    </aside>
  );
}
