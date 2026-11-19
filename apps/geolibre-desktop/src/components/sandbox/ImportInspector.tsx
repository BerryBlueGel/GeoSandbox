import { useRef, useState } from "react";
import { Button, Input, Label } from "@geolibre/ui";
import {
  IMPORT_FORMATS,
  inspectFile,
  parserFile,
  type FileInspection,
  type ImportFormat,
} from "../../lib/sandbox/inspect-file";
import type { SandboxTaskExecute } from "../../lib/sandbox/tasks";
import {
  inspectNativeVector,
  type VectorLayerInfo,
} from "../../lib/sandbox/native-jobs";

export function ImportInspector({
  busy,
  executeTask,
  onImport,
  browserOnly = false,
}: {
  busy: boolean;
  browserOnly?: boolean;
  executeTask: SandboxTaskExecute;
  onImport: (
    file: File,
    format: ImportFormat,
    crs: string,
    forceCrs: boolean,
    layerCrs?: Record<string, string>
  ) => Promise<boolean>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<{
    file: File;
    result: FileInspection;
  } | null>(null);
  const [format, setFormat] = useState<ImportFormat | "">("");
  const [crs, setCrs] = useState("");
  const [forceCrs, setForceCrs] = useState(false);
  const [layers, setLayers] = useState<VectorLayerInfo[]>([]);
  const [corrections, setCorrections] = useState(new Map<string, string>());
  const detected = draft?.result.format;
  const formatConflict = !!detected && !!format && detected !== format;
  const container = format === "gpkg" || format === "zip";
  const singleCrs = !browserOnly && (format === "geojson" || format === "tif");
  const availableFormats = Object.entries(IMPORT_FORMATS).filter(([key]) =>
    !browserOnly || ["geojson", "gltf", "glb", "geosandbox"].includes(key)
  );
  const unavailable = !!detected && !availableFormats.some(([key]) => key === detected);
  const missingCrs = layers.some(
    (layer) => !layer.declaredCrs && !corrections.get(layer.name)?.trim()
  );
  function resetCrs() {
    setCrs("");
    setForceCrs(false);
    setLayers([]);
    setCorrections(new Map());
  }
  return (
    <section className="space-y-3" aria-label="文件识别与导入">
      <Button
        className="w-full"
        variant="outline"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        检查并导入文件
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        aria-label="选择待识别文件"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file)
            void executeTask(
              {
                id: "geosandbox-inspect-file",
                label: "检查文件格式",
                record: false,
                parameters: { filename: file.name },
              },
              async (task) => {
                setDraft(null);
                resetCrs();
                await task.stage("按内容检查格式与资源配套");
                const result = await inspectFile(file, task.signal);
                task.commit(() => {
                  setFormat(result.format && availableFormats.some(([key]) => key === result.format) ? result.format : "");
                  setDraft({ file, result });
                });
              }
            );
        }}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        {browserOnly ? "可在浏览器中导入 GeoJSON、GLB、自包含 glTF 和 GeoSandbox 项目包。" :
          "按内容检查常用格式，扩展名错误也可识别；未知内容可手动指定解析方式。识别不调用 AI。"}
      </p>
      {draft && (
        <div
          className="space-y-3 rounded-md border bg-muted/30 p-3"
          aria-label="导入检查结果"
        >
          <p className="break-all text-sm font-medium">{draft.file.name}</p>
          <p className="text-xs text-muted-foreground">
            {draft.file.size < 1024
              ? `${draft.file.size} B`
              : `${(draft.file.size / 1024).toFixed(1)} KiB`}{" "}
            · {draft.result.evidence}
          </p>
          {draft.result.warnings.map((warning) => (
            <p
              key={warning}
              className="text-xs leading-relaxed text-amber-700 dark:text-amber-300"
            >
              {warning}
            </p>
          ))}
          <Label htmlFor="gs-import-format">解析格式</Label>
          <select
            id="gs-import-format"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={format}
            disabled={busy}
            onChange={(e) => {
              setFormat(e.target.value as ImportFormat);
              resetCrs();
            }}
          >
            <option value="">请选择格式</option>
            {availableFormats.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          {unavailable && <p role="alert" className="text-xs text-destructive">此格式需要使用完整部署版。</p>}
          {formatConflict && detected && (
            <p role="alert" className="text-xs text-destructive">
              文件内容已识别为 {IMPORT_FORMATS[detected]}，请选回对应格式。
            </p>
          )}
          {container && !formatConflict && (
            <fieldset className="min-w-0 space-y-2 rounded-md border p-2">
              <legend className="px-1 text-xs font-medium">逐图层 CRS</legend>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void executeTask(
                    {
                      id: "geosandbox-inspect-vector",
                      label: "检查图层与 CRS",
                      record: false,
                    },
                    async (task) => {
                      const result = await inspectNativeVector(
                        parserFile(draft.file, format),
                        task
                      );
                      task.commit(() => {
                        setLayers(result.layers);
                        setCorrections(new Map());
                      });
                    }
                  );
                }}
              >
                检查图层与 CRS
              </Button>
              <p className="text-xs text-muted-foreground">
                按原 CRS 导入可直接继续。纠正标注或补充缺失 CRS
                时，请先检查图层，仅填写对应的行。
              </p>
              {layers.map((layer, index) => (
                <div key={layer.name} className="space-y-1 border-t pt-2">
                  <Label
                    className="break-all"
                    htmlFor={`gs-layer-crs-${index}`}
                  >
                    图层 {layer.name} 的源 CRS
                  </Label>
                  <p className="break-all text-xs text-muted-foreground">
                    {layer.geometryType} ·{" "}
                    {layer.declaredCrs
                      ? `原标注 ${layer.declaredCrs}`
                      : "缺少 CRS，必须填写"}
                  </p>
                  <Input
                    id={`gs-layer-crs-${index}`}
                    disabled={busy}
                    value={corrections.get(layer.name) ?? ""}
                    placeholder={
                      layer.declaredCrs ? "留空保留原标注" : "例如 EPSG:3857"
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setCorrections((previous) =>
                        new Map(previous).set(layer.name, value)
                      );
                    }}
                  />
                </div>
              ))}
            </fieldset>
          )}
          {singleCrs && !formatConflict && (
            <>
              <Label htmlFor="gs-source-crs">
                源 CRS（补充缺失或明确纠正）
              </Label>
              <Input
                id="gs-source-crs"
                value={crs}
                onChange={(e) => setCrs(e.target.value)}
                placeholder="例如 EPSG:3857 或完整 WKT"
                disabled={busy}
              />
              <label className="flex items-start gap-2 text-xs leading-relaxed">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={busy || !crs.trim()}
                  checked={forceCrs}
                  onChange={(e) => setForceCrs(e.target.checked)}
                />
                覆盖文件中的源 CRS 标注（仅确认标注错误时使用）
              </label>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            手动指定解析方式不会转换文件内容。模型单位在导入后校准；GIS
            坐标系不会凭空猜测。
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              disabled={busy || !format || formatConflict || unavailable || missingCrs}
              onClick={() => {
                if (format)
                  void onImport(
                    draft.file,
                    format,
                    singleCrs ? crs : "",
                    singleCrs && forceCrs && !!crs.trim(),
                    container
                      ? Object.fromEntries(
                          [...corrections]
                            .map(([name, value]) => [name, value.trim()])
                            .filter(([, value]) => value)
                        )
                      : undefined
                  ).then((ok) => {
                    if (ok) setDraft(null);
                  });
              }}
            >
              导入到项目
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              取消导入
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
