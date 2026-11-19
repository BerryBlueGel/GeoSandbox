import { strFromU8, strToU8 } from "fflate";
import type { GeoLibreProject } from "@geolibre/core";
import { zipArchive, unzipArchive } from "./archive";

export const MAX_PROJECT_BUNDLE_BYTES = 256 * 1024 * 1024;
export const MAX_PROJECT_BUNDLE_ASSETS = 10000;
export const MAX_PROJECT_BUNDLE_ENTRIES = MAX_PROJECT_BUNDLE_ASSETS + 2;
const PREFIX = "geosandbox-asset:";
export interface BundleInput {
  name?: string;
  arrayBuffer: (signal?: AbortSignal) => Promise<ArrayBuffer>;
}
export interface Asset {
  path: string;
  mime: string;
  sha256: string;
  bytes: number;
}
export interface Manifest {
  format: "geosandbox";
  version: 1;
  assets: Asset[];
  externalReferences: string[];
}
export interface BundleResult {
  bytes: Uint8Array;
  externalReferences: string[];
  assetCount: number;
}
export interface CollectedProject {
  project: GeoLibreProject;
  manifest: Manifest;
  files: Record<string, Uint8Array>;
}
export type ResourceCache = Map<string, { data: Uint8Array; asset: Asset }>;

async function digest(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 16384)
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  return `data:${mime};base64,${btoa(parts.join(""))}`;
}

/** Rewrite resources, leaving plain project JSON and original objects untouched. */
async function mapStrings(
  value: unknown,
  map: (s: string) => Promise<string>,
  signal?: AbortSignal,
  work = { count: 0 }
): Promise<unknown> {
  signal?.throwIfAborted();
  if (signal && ++work.count % 2048 === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    signal.throwIfAborted();
  }
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value)
      result.push(await mapStrings(item, map, signal, work));
    return result;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value))
      result[key] = await mapStrings(item, map, signal, work);
    return result;
  }
  return value;
}

export async function collectProjectResources(
  project: GeoLibreProject,
  options: { cache?: ResourceCache; signal?: AbortSignal } = {}
): Promise<CollectedProject> {
  const files: Record<string, Uint8Array> = Object.create(null),
    assets: Asset[] = [],
    external = new Set<string>();
  const cached = new Map<string, string>();
  let total = 0;
  const rewritten = await mapStrings(
    project,
    async (text) => {
      if (/^https?:\/\//i.test(text)) {
        external.add(text);
        return text;
      }
      if (
        !text.startsWith("data:") &&
        !text.startsWith("blob:") &&
        !text.startsWith("/sandbox-api/assets/")
      )
        return text;
      const previous = cached.get(text);
      if (previous) return previous;
      let collected = options.cache?.get(text);
      if (!collected) {
        const response = await fetch(text, { signal: options.signal });
        if (!response.ok)
          throw new Error("有本地资源已失效，请重新导入后打包。");
        const data = new Uint8Array(await response.arrayBuffer());
        const sha256 = await digest(data);
        collected = {
          data,
          asset: {
            path: `assets/${sha256}.bin`,
            sha256,
            bytes: data.length,
            mime:
              response.headers.get("content-type")?.split(";")[0] ||
              "application/octet-stream",
          },
        };
        // Cache immutable embedded assets only. Native URLs can be replaced externally.
        if (
          text.startsWith("data:") &&
          options.cache &&
          [...options.cache.values()].reduce(
            (n, item) => n + item.data.length,
            0
          ) +
            data.length <=
            64 * 1024 * 1024
        )
          options.cache.set(text, collected);
      }
      options.signal?.throwIfAborted();
      const { data: bytes, asset } = collected;
      const path = asset.path;
      if (!files[path]) {
        total += bytes.length;
        if (total > MAX_PROJECT_BUNDLE_BYTES)
          throw new Error("便携包资源超过 256 MiB，请拆分项目。");
        if (assets.length >= MAX_PROJECT_BUNDLE_ASSETS)
          throw new Error("便携包资源超过 10000 份，请拆分项目。");
        files[path] = bytes;
        assets.push(asset);
      }
      const reference = PREFIX + path;
      cached.set(text, reference);
      return reference;
    },
    options.signal
  );
  const manifest: Manifest = {
    format: "geosandbox",
    version: 1,
    assets,
    externalReferences: [...external],
  };
  if (
    total +
      strToU8(JSON.stringify(rewritten)).length +
      strToU8(JSON.stringify(manifest)).length >
    MAX_PROJECT_BUNDLE_BYTES
  )
    throw new Error("项目与资源展开后超过 256 MiB，请拆分项目。");
  return { files, manifest, project: rewritten as GeoLibreProject };
}

export async function exportBundle(
  project: GeoLibreProject,
  options: { signal?: AbortSignal } = {}
): Promise<BundleResult> {
  const {
    files,
    manifest,
    project: rewritten,
  } = await collectProjectResources(project, options);
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  files["project.json"] = strToU8(JSON.stringify(rewritten));
  const bytes = await zipArchive(files, options.signal);
  if (bytes.length > MAX_PROJECT_BUNDLE_BYTES)
    throw new Error("项目包超过 256 MiB，请拆分项目。");
  return {
    bytes,
    externalReferences: manifest.externalReferences,
    assetCount: manifest.assets.length,
  };
}

export async function importBundle(
  bytes: Uint8Array,
  options: { signal?: AbortSignal } = {}
): Promise<{ projectText: string; manifest: Manifest }> {
  if (bytes.length > MAX_PROJECT_BUNDLE_BYTES)
    throw new Error("项目包超过 256 MiB。");
  let expanded = 0;
  let entries = 0;
  const files = await unzipArchive(
    bytes,
    (file) => {
      expanded += file.originalSize;
      if (
        expanded > MAX_PROJECT_BUNDLE_BYTES ||
        !Number.isSafeInteger(expanded)
      )
        throw new Error("项目包展开后超过 256 MiB。");
      if (++entries > MAX_PROJECT_BUNDLE_ENTRIES)
        throw new Error("项目包条目过多，请拆分项目。");
      if (
        !/^(?:manifest\.json|project\.json|assets\/[a-f0-9]{64}\.bin)$/.test(
          file.name
        )
      )
        throw new Error("项目包包含非预期资源路径。");
      return true;
    },
    options.signal
  );
  if (!files["manifest.json"] || !files["project.json"])
    throw new Error("缺少项目清单或项目文档。");
  const manifest = JSON.parse(strFromU8(files["manifest.json"])) as Manifest;
  if (
    manifest.format !== "geosandbox" ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length > MAX_PROJECT_BUNDLE_ASSETS
  )
    throw new Error("不支持的项目包版本。");
  const resources = new Map<string, string>();
  for (const asset of manifest.assets) {
    options.signal?.throwIfAborted();
    const data = files[asset.path];
    if (
      !data ||
      data.length !== asset.bytes ||
      (await digest(data)) !== asset.sha256
    )
      throw new Error("项目资源缺失或校验失败。");
    if (
      typeof asset.mime !== "string" ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(asset.mime)
    )
      throw new Error("资源类型无效。");
    resources.set(PREFIX + asset.path, toDataUrl(data, asset.mime));
  }
  const project = await mapStrings(
    JSON.parse(strFromU8(files["project.json"])),
    async (text) => {
      if (!text.startsWith(PREFIX)) return text;
      const resource = resources.get(text);
      if (!resource) throw new Error("项目引用了清单以外的资源。");
      return resource;
    },
    options.signal
  );
  options.signal?.throwIfAborted();
  return { projectText: JSON.stringify(project), manifest };
}
