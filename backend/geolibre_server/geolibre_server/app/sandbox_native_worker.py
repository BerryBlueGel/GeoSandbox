"""GIS implementations shared by compatibility routes and managed native jobs."""
from pathlib import Path


def watch_parent(parent_pid: int):
    """Exit when our owning server exits, including forced Windows shutdown."""
    import os
    import threading
    import time
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_bool, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.WaitForSingleObject.restype = ctypes.c_ulong
        handle = kernel.OpenProcess(0x00100000, False, parent_pid)
        if not handle:
            raise RuntimeError("Cannot watch owning server")
        def watch():
            while kernel.WaitForSingleObject(handle, 500) == 258:
                pass
            os._exit(75)
    else:
        def watch():
            while os.getppid() == parent_pid:
                time.sleep(0.5)
            os._exit(75)
    threading.Thread(target=watch, daemon=True).start()


def run(params):
    import json
    from .sandbox_storage import atomic_write
    watch_parent(params["parent_pid"])
    print("读取图层与 CRS" if params.get("operation") == "inspect" else "读取并转换数据", flush=True)
    try:
        path = Path(params["input_path"])
        if params.get("operation") == "inspect":
            result = {"layers": inspect_vector(path)}
        elif params["kind"] == "vector":
            overrides = json.loads(Path(params["layer_crs_path"]).read_bytes()) if params.get("layer_crs_path") else None
            result = {"layers": convert_vector(path, params["filename"], params["source_crs"], params["force_crs"], overrides)}
        else:
            result = convert_raster(path, Path(params["preview_path"]), params["source_crs"], params["force_crs"])
    except ValueError as exc:
        # Only our own curated validation errors may cross the process boundary.
        raise SystemExit(str(exc)) from None
    print("写入转换结果", flush=True)
    encoded = json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(encoded) > 64 * 1024 * 1024:
        raise SystemExit("转换结果超过 64 MiB，请拆分数据后导入")
    atomic_write(Path(params["output_path"]), lambda output: output.write(encoded))
    print('__GEOLIBRE_CONVERSION_RESULT__' + json.dumps({"ready": True}), flush=True)


def _vector_layers(path: Path):
    import pyogrio
    suffix = path.suffix.lower()
    reader = f"/vsizip/{path.as_posix()}" if suffix == ".zip" else str(path)
    expected = {".gpkg": "GPKG", ".geojson": "GeoJSON", ".json": "GeoJSON", ".zip": "ESRI Shapefile"}[suffix]
    entries = pyogrio.list_layers(reader)
    if len(entries) > 32:
        raise ValueError("文件包含超过 32 个图层，请拆分后导入")
    layers = []
    for name, geometry_type in entries:
        info = pyogrio.read_info(reader, layer=name)
        if info.get("driver") != expected:
            label = {"GPKG": "GeoPackage", "GeoJSON": "GeoJSON", "ESRI Shapefile": "ZIP Shapefile"}[expected]
            raise ValueError(f"文件内容不是 {label}；请按实际格式导入。")
        if geometry_type:
            layers.append({"name": str(name), "geometryType": str(geometry_type), "declaredCrs": info.get("crs")})
    if not layers:
        raise ValueError("没有可导入的矢量几何图层")
    return reader, layers


def inspect_vector(path: Path):
    return _vector_layers(path)[1]


def convert_vector(path: Path, original_name: str, source_crs: str = "", force_crs: bool = False, layer_crs: dict[str, str] | None = None):
    import json
    import numpy as np
    import pyogrio
    from pyproj import CRS
    from pyproj.exceptions import CRSError

    suffix = path.suffix.lower()
    reader, layers = _vector_layers(path)
    overrides = layer_crs or {}
    source_crs = source_crs.strip()
    if set(overrides) - {layer["name"] for layer in layers}:
        raise ValueError("CRS 纠错包含不存在的图层；请重新检查图层列表。")
    if overrides and (source_crs or force_crs):
        raise ValueError("请使用逐图层 CRS 或单层 CRS，不能同时填写。")
    if len(layers) > 1 and (force_crs or source_crs):
        raise ValueError("文件包含多个图层；请检查图层与 CRS，并只填写需要纠错的图层。")
    if force_crs and not source_crs:
        raise ValueError("覆盖源 CRS 时必须填写明确的坐标系")
    result = []
    for layer in layers:
        name = layer["name"]
        frame = pyogrio.read_dataframe(reader, layer=name, max_features=100001)
        if len(frame) > 100000:
            raise ValueError("单层超过 100000 个要素，请先按区域拆分")
        declared = frame.crs.to_string() if frame.crs else None
        correction = overrides.get(name) or (source_crs if force_crs or frame.crs is None else "")
        if correction:
            try:
                crs = CRS.from_user_input(correction)
            except (CRSError, ValueError):
                raise ValueError(f"图层「{name}」的源 CRS 无效，请检查 EPSG 编号或 WKT。") from None
            frame = frame.set_crs(crs, allow_override=True)
        elif frame.crs is None:
            raise ValueError(f"图层「{name}」的源 CRS 缺失。请填写该图层的源 CRS（例如 EPSG:4548 或完整 WKT）。")
        source = frame.crs.to_string()
        projected = frame.to_crs("EPSG:4326")
        present = projected.geometry.notna() & ~projected.geometry.is_empty
        bounds = projected.loc[present].bounds.to_numpy()
        if bounds.size and (not np.isfinite(bounds).all() or (bounds[:, [0,2]] < -180).any() or (bounds[:, [0,2]] > 180).any() or (bounds[:, [1,3]] < -90).any() or (bounds[:, [1,3]] > 90).any()):
            raise ValueError(f"图层「{name}」转换结果超出有效经纬度范围，请检查该图层的源 CRS。")
        display_name = Path(original_name or "data").stem if suffix in {".geojson", ".json"} else str(name)
        result.append({"name": display_name, "geometryType": layer["geometryType"], "sourceCrs": source, "declaredCrs": declared, "crsOverridden": bool(correction and declared), "geojson": json.loads(projected.to_json()), "count": len(projected)})
    return result


def convert_raster(original: Path, preview_path: Path, source_crs: str = "", force_crs: bool = False):
    import numpy as np
    import rasterio
    from rasterio.vrt import WarpedVRT
    from rasterio.warp import calculate_default_transform, transform_bounds
    from rasterio.transform import from_bounds
    from rasterio.enums import ColorInterp, Resampling
    with rasterio.open(original) as source:
        if source.driver != "GTiff":
            raise ValueError("文件内容不是 TIFF / GeoTIFF；请按实际格式导入。")
        if source.transform.is_identity:
            raise ValueError("影像缺少可用的像素到地理坐标的仿射变换。请先对影像配准并保存为 GeoTIFF；填写 CRS 只能解释已有坐标。")
        if force_crs and not source_crs.strip():
            raise ValueError("覆盖源 CRS 时必须填写明确的坐标系")
        crs = source_crs.strip() if force_crs else (source.crs or source_crs.strip())
        if not crs:
            raise ValueError("影像缺失 CRS，请填写源 CRS 后重新导入；系统不会猜测坐标系。")
        bounds = transform_bounds(crs, "EPSG:4326", *source.bounds, densify_pts=21)
        w, s, e, n = bounds
        if not (np.isfinite(bounds).all() and -180 <= w < e <= 180 and -90 <= s < n <= 90):
            raise ValueError("此预览入口暂不支持跨日期变更线或无效范围的影像")
        _, width, height = calculate_default_transform(crs, "EPSG:4326", source.width, source.height, *source.bounds)
        factor = max(width / 2048, height / 2048, 1)
        width, height = max(1, round(width / factor)), max(1, round(height / factor))
        indexes = [1, 2, 3] if source.count >= 3 else [1, 1, 1]
        palette = source.colormap(1) if source.colorinterp[0] == ColorInterp.palette else None
        with WarpedVRT(source, src_crs=crs, crs="EPSG:4326", transform=from_bounds(*bounds, width, height), width=width, height=height, resampling=Resampling.nearest if palette else Resampling.bilinear) as warped:
            pixels = warped.read([1] if palette else indexes, masked=True)
            alpha = warped.dataset_mask()
        if palette:
            lookup = np.zeros((max(palette) + 1, 4), dtype="uint8")
            for code, color in palette.items():
                lookup[code] = color
            codes = pixels[0].filled(0)
            known = (codes >= 0) & (codes < len(lookup)) & ~np.ma.getmaskarray(pixels[0])
            rgba = np.zeros((height, width, 4), dtype="uint8")
            rgba[known] = lookup[codes[known]]
            rgb = rgba[:, :, :3].transpose(2, 0, 1)
            alpha = (alpha.astype("uint16") * rgba[:, :, 3] // 255).astype("uint8")
        else:
            rgb = np.zeros((3, height, width), dtype="uint8")
            for index in range(3):
                band = pixels[index]
                valid = band.compressed()
                valid = valid[np.isfinite(valid)]
                if not len(valid):
                    continue
                values = np.nan_to_num(band.filled(0).astype("float64"))
                if source.dtypes[indexes[index] - 1] == "uint8":
                    rgb[index] = np.clip(values, 0, 255).astype("uint8")
                else:
                    lo, hi = np.percentile(valid, [2, 98])
                    rgb[index] = np.clip((values - lo) / (hi - lo if hi > lo else 1) * 255, 0, 255).astype("uint8")
        with rasterio.open(preview_path, "w", driver="PNG", width=width, height=height, count=4, dtype="uint8") as target:
            target.write(np.concatenate([rgb, alpha[None, :, :]], axis=0))
        return {"bounds": bounds, "sourceCrs": str(crs), "declaredCrs": str(source.crs) if source.crs else None, "crsOverridden": force_crs, "width": width, "height": height, "bandCount": source.count, "sourceDtypes": list(source.dtypes)}
