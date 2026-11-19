import { fileTypeFromBlob } from "file-type";
import { strFromU8 } from "fflate";
import { unzipArchive } from "./archive";
import { MAX_PROJECT_BUNDLE_BYTES, MAX_PROJECT_BUNDLE_ENTRIES } from "./bundle";

export const IMPORT_FORMATS = {
  glb: "GLB 模型",
  gltf: "glTF 模型",
  geojson: "GeoJSON 矢量",
  gpkg: "GeoPackage",
  zip: "ZIP Shapefile",
  tif: "TIFF / GeoTIFF",
  geosandbox: "GeoSandbox 项目包",
} as const;
export type ImportFormat = keyof typeof IMPORT_FORMATS;
export interface FileInspection {
  format: ImportFormat | null;
  evidence: string;
  warnings: string[];
}
const MAX_IMPORT = 128 * 1024 * 1024;

/** Signature detection is delegated to file-type; GIS/container semantics stay explicit. */
export async function inspectFile(
  file: Blob & { name: string },
  signal?: AbortSignal
): Promise<FileInspection> {
  signal?.throwIfAborted();
  if (!file.size || file.size > MAX_PROJECT_BUNDLE_BYTES)
    throw new Error("请选择非空文件。数据最大 128 MiB，项目包最大 256 MiB。");
  let format: ImportFormat | null = null;
  let evidence = "内容尚未识别，请手动选择已支持的解析方式。";
  const warnings: string[] = [];
  const type = await fileTypeFromBlob(file).catch(() => undefined);
  signal?.throwIfAborted();
  if (file.size > MAX_IMPORT && type?.ext !== "zip")
    throw new Error("数据文件超过 128 MiB，请拆分后导入。");
  if (type?.ext === "glb") {
    format = "glb";
    evidence = "识别到二进制 glTF 模型";
  } else if (type?.ext === "tif") {
    format = "tif";
    evidence = "识别到 TIFF 影像；导入时检查地理参考";
  } else if (type?.ext === "sqlite") {
    const header = new Uint8Array(await file.slice(68, 72).arrayBuffer());
    if (["GPKG", "GP10", "GP11"].includes(new TextDecoder().decode(header))) {
      format = "gpkg";
      evidence = "识别到 GeoPackage 容器标识";
    } else
      warnings.push(
        "识别到 SQLite 容器，尚未确认是 GeoPackage；普通数据库不能按 GPKG 导入。"
      );
  } else if (type?.ext === "zip") {
    const entries: string[] = [];
    let expanded = 0;
    const files = await unzipArchive(
      new Uint8Array(await file.arrayBuffer()),
      (entry) => {
        entries.push(entry.name);
        expanded += entry.originalSize;
        if (
          entries.length > MAX_PROJECT_BUNDLE_ENTRIES ||
          expanded > MAX_PROJECT_BUNDLE_BYTES ||
          !Number.isSafeInteger(expanded)
        )
          throw new Error("压缩包过大或条目过多，请拆分。");
        return entry.name === "manifest.json";
      },
      signal
    );
    if (files["manifest.json"] && entries.includes("project.json")) {
      try {
        const manifest = JSON.parse(strFromU8(files["manifest.json"]));
        if (manifest.format === "geosandbox" && manifest.version === 1) {
          format = "geosandbox";
          evidence = "ZIP 内的 GeoSandbox 项目清单";
        }
      } catch {
        /* Other archives may also contain a manifest. */
      }
    }
    if (!format) {
      if (file.size > MAX_IMPORT || entries.length > 4096)
        throw new Error("数据压缩包超过 128 MiB 或条目过多，请拆分后导入。");
      const names = new Set(entries.map((name) => name.toLowerCase()));
      const shapes = [...names].filter(
        (name) => name.endsWith(".shp") && !name.startsWith("__macosx/")
      );
      if (shapes.length) {
        format = "zip";
        evidence = `ZIP 中包含 ${shapes.length} 组 Shapefile`;
        for (const shape of shapes) {
          const stem = shape.slice(0, -4);
          if (![".shx", ".dbf"].every((ext) => names.has(stem + ext)))
            throw new Error(
              `Shapefile 组件不完整：${shape} 需要同名 .shx 和 .dbf。`
            );
          if (!names.has(stem + ".prj"))
            warnings.push(`${shape} 缺少 .prj；需要人工提供源 CRS。`);
        }
      }
    }
  } else {
    // JSON has no binary signature. Parse the document, rather than trusting its name.
    const prefix = new TextDecoder()
      .decode(await file.slice(0, 256).arrayBuffer())
      .replace(/^\uFEFF/, "")
      .trimStart();
    if (prefix.startsWith("{") || prefix.startsWith("[")) {
      try {
        const json = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
        if (json.asset?.version === "2.0") {
          format = "gltf";
          evidence = "识别到 glTF 2.0 模型结构";
        } else if (
          [
            "FeatureCollection",
            "Feature",
            "Point",
            "MultiPoint",
            "LineString",
            "MultiLineString",
            "Polygon",
            "MultiPolygon",
            "GeometryCollection",
          ].includes(json.type)
        ) {
          format = "geojson";
          evidence = "识别到 GeoJSON 几何或要素结构";
        }
      } catch {
        warnings.push("JSON 内容无效或尚未支持。");
      }
    }
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  const aliases: (string | null)[] =
    format === "geojson"
      ? ["geojson", "json"]
      : format === "tif"
      ? ["tif", "tiff"]
      : [format];
  if (format && !aliases.includes(extension ?? ""))
    warnings.push(
      `文件名扩展名与内容不符；将按 ${IMPORT_FORMATS[format]} 解析，保留原文件名用于追溯。`
    );
  signal?.throwIfAborted();
  return { format, evidence, warnings };
}

export function parserFile(file: File, format: ImportFormat): File {
  const name = file.name.replace(
    /\.(glb|gltf|geojson|json|gpkg|zip|tif|tiff|geosandbox)$/i,
    ""
  );
  return new File([file], `${name}.${format}`, { type: file.type });
}
