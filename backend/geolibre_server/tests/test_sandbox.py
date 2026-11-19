import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from geolibre_server.app.sandbox import router


@pytest.fixture
def client(tmp_path, monkeypatch):
    from geolibre_server.app import sandbox
    credentials = {}
    monkeypatch.setattr(sandbox.keyring, "get_password", lambda service, user: credentials.get((service, user)))
    monkeypatch.setattr(sandbox.keyring, "set_password", lambda service, user, key: credentials.__setitem__((service, user), key))
    monkeypatch.setattr(sandbox.keyring, "delete_password", lambda service, user: credentials.pop((service, user), None))
    monkeypatch.setenv("GEOSANDBOX_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_MODEL", raising=False)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_status_and_key_never_leak(client, tmp_path):
    assert client.get("/sandbox/status").json()["configured"] is False
    response = client.post("/sandbox/config", json={"apiKey": "test-secret-never-send", "model": "deepseek-flash"}, headers={"Origin": "http://127.0.0.1:5173"})
    assert response.status_code == 200
    assert response.json()["configured"] is True
    assert "test-secret-never-send" not in response.text
    assert "apiKey" not in client.get("/sandbox/status").json()
    client.post("/sandbox/config", json={"model": "another-model"})
    stored = json.loads((tmp_path / "deepseek.local.json").read_text())
    assert stored == {"keyStored": True, "model": "another-model"}
    assert client.get("/sandbox/status").json()["configured"] is True
    assert client.get("/sandbox/status").json()["keySource"] == "system-credential-store"


def test_hosted_profile_uses_exact_origin_and_environment_owned_credentials(client, monkeypatch, tmp_path):
    monkeypatch.setenv("GEOSANDBOX_SERVER", "1")
    monkeypatch.setenv("GEOSANDBOX_PUBLIC_ORIGIN", "https://sandbox.example.test")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "fixture-only-credential")
    status = client.get("/sandbox/status")
    assert status.json()["configured"] and not status.json()["settingsMutable"]
    assert "fixture-only-credential" not in status.text
    origin = {"Origin": "https://sandbox.example.test"}
    assert client.post("/sandbox/config", json={"model": "test"}, headers=origin).status_code == 403
    assert not (tmp_path / "deepseek.local.json").exists()
    upload = {"file": ("test.json", b"{}")}  # The request reaches actual payload validation only from the configured origin.
    assert client.post("/sandbox/vector-upload", files=upload, headers=origin).status_code == 422
    assert client.post("/sandbox/vector-upload", files=upload, headers={"Origin": "http://127.0.0.1:5173"}).status_code == 403


def test_legacy_plaintext_is_migrated_only_after_verified_vault_write(client, tmp_path, monkeypatch):
    from geolibre_server.app import sandbox
    path = tmp_path / "deepseek.local.json"
    legacy = {"apiKey": "legacy-test-secret", "model": "configured-model"}
    path.write_text(json.dumps(legacy), encoding="utf-8")
    def broken(*args):
        raise sandbox.keyring.errors.PasswordSetError("sensitive backend error")
    with monkeypatch.context() as patch:
        patch.setattr(sandbox.keyring, "set_password", broken)
        response = client.get("/sandbox/status")
        assert response.status_code == 503
        assert "sensitive" not in response.text
        assert json.loads(path.read_text()) == legacy
    response = client.get("/sandbox/status")
    assert response.json()["configured"] is True
    assert "legacy-test-secret" not in path.read_text()
    assert sandbox.config()["apiKey"] == "legacy-test-secret"


def test_explicit_key_clear_and_blank_model_update_semantics(client):
    client.post("/sandbox/config", json={"apiKey":"test-secret", "model":"m"})
    client.post("/sandbox/config", json={"model":"m2"})
    assert client.get("/sandbox/status").json()["configured"] is True
    client.post("/sandbox/config", json={"apiKey":"", "model":"m2"})
    assert client.get("/sandbox/status").json()["configured"] is False


def test_configuration_rejects_foreign_origin_and_invalid_model(client):
    assert client.post("/sandbox/config", json={"apiKey": "secret", "model": "m"}, headers={"Origin": "https://evil.invalid"}).status_code == 403
    assert client.post("/sandbox/config", json={"model": "bad model"}).status_code == 422


def test_missing_key_is_an_explicit_failure_not_fake_ai_output(client):
    response = client.post("/ai/v1/chat/completions", json={"messages": []})
    assert response.status_code == 503
    assert response.json()["error"]["type"] == "configuration_error"


def test_native_vector_import_and_original_asset(client):
    content = json.dumps({"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"中文建筑"},"geometry":{"type":"Point","coordinates":[118.14,39.64]}}]}, ensure_ascii=False).encode()
    response = client.post("/sandbox/vector-upload", files={"file":("points.geojson",content,"application/geo+json")})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["layers"][0]["name"] == "points"
    assert result["layers"][0]["sourceCrs"] == "EPSG:4326"
    assert result["layers"][0]["geojson"]["features"][0]["properties"]["name"] == "中文建筑"
    url = result["assetUrl"].replace("/sandbox-api", "/sandbox")
    assert client.get(url).content == content
    wrong = client.post("/sandbox/vector-upload", files={"file":("wrong.gpkg",content)})
    assert wrong.status_code == 422


def test_native_projected_vector_and_missing_crs(client, tmp_path):
    import geopandas as gpd
    from shapely.geometry import Point
    frame = gpd.GeoDataFrame({"name":["A"]}, geometry=[Point(118.14,39.64)], crs="EPSG:4326").to_crs("EPSG:3857")
    path = tmp_path / "test.gpkg"
    frame.to_file(path, driver="GPKG", layer="buildings")
    response = client.post("/sandbox/vector-upload", files={"file":("test.gpkg",path.read_bytes())})
    assert response.status_code == 200, response.text
    mislabeled = client.post("/sandbox/vector-upload", files={"file":("test.geojson",path.read_bytes())})
    assert mislabeled.status_code == 422 and "不是 GeoJSON" in mislabeled.json()["detail"]
    result = response.json()["layers"][0]
    assert result["sourceCrs"] == "EPSG:3857"
    assert result["geojson"]["features"][0]["geometry"]["coordinates"] == pytest.approx([118.14,39.64],abs=1e-9)
    unknown = tmp_path / "unknown.gpkg"
    frame.set_crs(None,allow_override=True).to_file(unknown,driver="GPKG")
    assert client.post("/sandbox/vector-upload",files={"file":("unknown.gpkg",unknown.read_bytes())}).status_code == 422
    assert client.post("/sandbox/vector-upload",files={"file":("unknown.gpkg",unknown.read_bytes())},data={"source_crs":"EPSG:3857"}).status_code == 200


def test_wrong_crs_requires_explicit_override_and_records_original_reference(client):
    from pyproj import Transformer
    x,y = Transformer.from_crs(4326,3857,always_xy=True).transform(118.14,39.64)
    content = json.dumps({"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"control"},"geometry":{"type":"Point","coordinates":[x,y]}}]}).encode()
    assert client.post("/sandbox/vector-upload",files={"file":("wrong.geojson",content)}).status_code == 422
    assert client.post("/sandbox/vector-upload",files={"file":("wrong.geojson",content)},data={"source_crs":"EPSG:3857"}).status_code == 422
    response = client.post("/sandbox/vector-upload",files={"file":("wrong.geojson",content)},data={"source_crs":"EPSG:3857","force_crs":"true"})
    assert response.status_code == 200, response.text
    layer = response.json()["layers"][0]
    assert layer["geojson"]["features"][0]["geometry"]["coordinates"] == pytest.approx([118.14,39.64],abs=1e-9)
    assert layer["sourceCrs"] == "EPSG:3857" and layer["declaredCrs"] == "EPSG:4326" and layer["crsOverridden"] is True


def test_exports_are_saved_in_configured_directory_and_download_exact_bytes(client, tmp_path):
    content = b"generated example content"
    response = client.post("/sandbox/exports",files={"file":("example.geosandbox",content)})
    assert response.status_code == 200
    result = response.json()
    from pathlib import Path
    assert Path(result["path"]).parent == tmp_path / "exports"
    assert Path(result["path"]).read_bytes() == content
    assert client.get(result["downloadUrl"].replace("/sandbox-api","/sandbox")).content == content


def test_saved_project_catalog_uses_latest_per_name_and_encoded_download_links(client, tmp_path):
    import os
    folder = tmp_path / "exports"
    assert client.get("/sandbox/projects").json()["projects"] == []
    folder.mkdir(exist_ok=True)
    for index, name in enumerate(["校园 #1.geosandbox", "other.geosandbox", "校园 #1.geosandbox"]):
        path = folder / (f"{index:032x}_" + name)
        path.write_bytes(f"project-{index}".encode())
        os.utime(path, (1000 + index, 1000 + index))
    (folder / "not-export.geosandbox").write_bytes(b"unrelated")
    (folder / ("f" * 32 + "_model.glb")).write_bytes(b"model")
    (folder / ("e" * 32 + "_folder.geosandbox")).mkdir()
    response = client.get("/sandbox/projects").json()
    assert [p["name"] for p in response["projects"]] == ["校园 #1", "other"]
    latest = response["projects"][0]
    assert "%23" in latest["downloadUrl"]
    assert client.get(latest["downloadUrl"].replace("/sandbox-api","/sandbox")).content == b"project-2"
    assert len(list(folder.glob("*.geosandbox"))) == 5  # listing never deletes old files
    assert client.get("/sandbox/projects", headers={"Origin":"https://evil.invalid"}).status_code == 403
    assert client.get("/sandbox/exports/invalid").status_code == 404
    saved = client.post("/sandbox/exports", files={"file":("new #1.geosandbox", b"new")}).json()
    assert client.get(saved["downloadUrl"].replace("/sandbox-api","/sandbox")).content == b"new"
    long_name = "p" * 180 + ".geosandbox"
    saved = client.post("/sandbox/exports", files={"file":(long_name, b"long name")}).json()
    assert saved["path"].endswith(".geosandbox")
    assert any(p["downloadUrl"] == saved["downloadUrl"] for p in client.get("/sandbox/projects").json()["projects"])
    assert client.get(saved["downloadUrl"].replace("/sandbox-api","/sandbox")).content == b"long name"


def test_saved_project_catalog_is_bounded(client, tmp_path):
    folder = tmp_path / "exports"
    folder.mkdir()
    for index in range(25):
        (folder / (f"{index:032x}_project-{index}.geosandbox")).write_bytes(b"snapshot")
    assert len(client.get("/sandbox/projects").json()["projects"]) == 20


def test_proxy_forwards_tools_and_uses_server_key_and_model(client, monkeypatch):
    import httpx
    from geolibre_server.app import sandbox
    original_client = httpx.AsyncClient
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"choices":[{"message":{"role":"assistant","content":"mock provider reply"}}]})

    monkeypatch.setattr(sandbox.httpx, "AsyncClient", lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    client.post("/sandbox/config", json={"apiKey":"local-test-secret", "model":"configured-model"})
    response = client.post("/ai/v1/chat/completions", json={"model":"browser-value", "messages":[{"role":"user","content":"inspect"}], "tools":[{"type":"function","function":{"name":"inspect","parameters":{"type":"object"}}}], "max_tokens":999999})
    assert response.status_code == 200
    body = json.loads(requests[0].content)
    assert str(requests[0].url) == "https://api.deepseek.com/chat/completions"
    assert requests[0].headers["authorization"] == "Bearer local-test-secret"
    assert body["model"] == "configured-model"
    assert body["tools"][0]["function"]["name"] == "inspect"
    assert body["max_tokens"] == 8192
    assert "local-test-secret" not in response.text


def test_raster_preview_preserves_original_and_geographic_extent(client):
    import numpy as np
    from rasterio.io import MemoryFile
    from rasterio.transform import from_bounds
    pixels = np.stack([np.full((16, 32), v, dtype="uint8") for v in [40, 120, 200]])
    with MemoryFile() as memory:
        with memory.open(driver="GTiff", width=32, height=16, count=3, dtype="uint8", crs="EPSG:4326", transform=from_bounds(118, 39, 119, 40, 32, 16)) as target:
            target.write(pixels)
        original = memory.read()
    response = client.post("/sandbox/raster-upload", files={"file":("rgb.tif", original)})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["bounds"] == pytest.approx([118, 39, 119, 40])
    assert client.get(result["assetUrl"].replace("/sandbox-api", "/sandbox")).content == original
    preview = client.get(result["previewUrl"].replace("/sandbox-api", "/sandbox"))
    assert preview.headers["content-type"] == "image/png"
    with MemoryFile(preview.content) as memory, memory.open() as image:
        assert image.count == 4
        assert image.read()[:, 0, 0].tolist() == [40, 120, 200, 255]


def test_raster_preview_requires_crs_and_caps_display_resolution(client):
    import numpy as np
    from rasterio.io import MemoryFile
    from rasterio.transform import from_bounds
    with MemoryFile() as memory:
        with memory.open(driver="GTiff", width=3000, height=30, count=1, dtype="uint16", transform=from_bounds(118, 39, 119, 40, 3000, 30)) as target:
            target.write(np.arange(90000, dtype="uint16").reshape(1, 30, 3000))
        original = memory.read()
    assert client.post("/sandbox/raster-upload", files={"file":("unknown.tif", original)}).status_code == 422
    response = client.post("/sandbox/raster-upload", files={"file":("unknown.tif", original)}, data={"source_crs":"EPSG:4326"})
    assert response.status_code == 200, response.text
    assert max(response.json()["width"], response.json()["height"]) <= 2048


def test_palette_raster_preview_preserves_class_colors_nodata_and_source(client):
    import numpy as np
    from rasterio.io import MemoryFile
    from rasterio.transform import from_bounds
    with MemoryFile() as memory:
        with memory.open(driver="GTiff", width=2, height=2, count=1, dtype="uint8", nodata=0, crs="EPSG:4326", transform=from_bounds(118, 39, 120, 41, 2, 2)) as target:
            target.write(np.array([[1, 2], [0, 1]], dtype="uint8"), 1)
            target.write_colormap(1, {1: (255, 0, 0, 255), 2: (0, 255, 0, 255)})
        raw = memory.read()
    response = client.post("/sandbox/raster-upload", files={"file": ("palette.tif", raw)})
    assert response.status_code == 200, response.text
    result = response.json()
    assert client.get(result["assetUrl"].replace("/sandbox-api", "/sandbox")).content == raw
    data = client.get(result["previewUrl"].replace("/sandbox-api", "/sandbox")).content
    with MemoryFile(data) as memory, memory.open() as image:
        pixels = image.read()
        assert pixels[:, 0, 0].tolist() == [255, 0, 0, 255]
        assert pixels[:, 0, 1].tolist() == [0, 255, 0, 255]
        assert pixels[3, 1, 0] == 0


@pytest.mark.parametrize(("driver", "message"), [("PNG", "不是 TIFF"), ("GTiff", "缺少可用的像素到地理坐标的仿射变换")])
def test_raster_format_and_georeferencing_errors_are_distinct(client, driver, message):
    import numpy as np
    from rasterio.io import MemoryFile
    with MemoryFile() as memory:
        with memory.open(driver=driver, width=2, height=2, count=1, dtype="uint8") as target:
            target.write(np.ones((2, 2), dtype="uint8"), 1)
        raw = memory.read()
    response = client.post("/sandbox/raster-upload", files={"file": ("manual.tif", raw)}, data={"source_crs":"EPSG:4326"})
    assert response.status_code == 422 and message in response.json()["detail"]


def test_raster_crs_override_reinterprets_source_and_keeps_visible_pixels(client):
    import numpy as np
    from rasterio.io import MemoryFile
    from rasterio.transform import from_bounds
    from pyproj import Transformer
    project = Transformer.from_crs(4326,3857,always_xy=True)
    w,s = project.transform(118,39)
    e,n = project.transform(119,40)
    with MemoryFile() as memory:
        with memory.open(driver="GTiff",width=16,height=16,count=1,dtype="uint8",crs="EPSG:4326",transform=from_bounds(w,s,e,n,16,16)) as target:
            target.write(np.full((1,16,16),120,dtype="uint8"))
        original=memory.read()
    response = client.post("/sandbox/raster-upload",files={"file":("wrong.tif",original)},data={"source_crs":"EPSG:3857","force_crs":"true"})
    assert response.status_code == 200, response.text
    result=response.json()
    assert result["bounds"] == pytest.approx([118,39,119,40],abs=1e-8)
    assert result["declaredCrs"] == "EPSG:4326" and result["crsOverridden"] is True
    preview=client.get(result["previewUrl"].replace("/sandbox-api","/sandbox")).content
    with MemoryFile(preview) as memory, memory.open() as image:
        assert image.read(4).max() == 255
        assert image.read(1).max() == 120


def checkpoint_payload():
    import hashlib
    data = b"original-resource-exact-bytes"
    digest = hashlib.sha256(data).hexdigest()
    path = f"assets/{digest}.bin"
    return data, digest, {
        "project": {"version":"0.2.0", "name":"Recovery control", "layers":[{"id":"layer", "asset":"geosandbox-asset:"+path}], "metadata":{"height":3}},
        "manifest": {"format":"geosandbox", "version":1, "assets":[{"path":path,"sha256":digest,"bytes":len(data),"mime":"application/octet-stream"}], "externalReferences":[]},
    }


def test_disk_checkpoint_is_incremental_exact_and_survives_new_app(client, tmp_path):
    import io
    from zipfile import ZipFile
    data, digest, payload = checkpoint_payload()
    assert client.post("/sandbox/checkpoints/missing-assets", json={"hashes":[digest]}).json()["missing"] == [digest]
    assert client.post(f"/sandbox/checkpoints/assets/{digest}", files={"file":("a.bin",data)}).json()["deduplicated"] is False
    response = client.post("/sandbox/checkpoints", json=payload)
    assert response.status_code == 200, response.text
    first = response.json()
    assert client.post("/sandbox/checkpoints", json=payload).json()["id"] == first["id"]
    assert client.post("/sandbox/checkpoints/missing-assets", json={"hashes":[digest]}).json()["missing"] == []
    assert client.post(f"/sandbox/checkpoints/assets/{digest}", files={"file":("a.bin",data)}).json()["deduplicated"] is True
    payload["project"]["metadata"]["height"] = 7
    second = client.post("/sandbox/checkpoints", json=payload).json()
    assert second["id"] != first["id"]
    assert len(list((tmp_path / "checkpoints/assets").glob("*.bin"))) == 1
    app = FastAPI()
    app.include_router(router)
    fresh = TestClient(app)
    assert len(fresh.get("/sandbox/checkpoints").json()["checkpoints"]) == 2
    bundle = fresh.get(second["downloadUrl"].replace("/sandbox-api","/sandbox"))
    assert bundle.status_code == 200
    with ZipFile(io.BytesIO(bundle.content)) as archive:
        assert json.loads(archive.read("project.json")) == payload["project"]
        assert archive.read(payload["manifest"]["assets"][0]["path"]) == data
    assert not list((tmp_path / "checkpoints").glob(".restore-*"))


def test_disk_checkpoint_rejects_missing_and_corrupted_assets_then_allows_exact_repair(client, tmp_path):
    data, digest, payload = checkpoint_payload()
    assert client.post("/sandbox/checkpoints", json=payload).status_code == 422
    assert client.post(f"/sandbox/checkpoints/assets/{digest}", files={"file":("a.bin",b"bad")}).status_code == 422
    assert not list((tmp_path / "checkpoints/assets").glob("*"))
    client.post(f"/sandbox/checkpoints/assets/{digest}", files={"file":("a.bin",data)})
    point = client.post("/sandbox/checkpoints", json=payload).json()
    asset = tmp_path / "checkpoints/assets" / (digest + ".bin")
    asset.write_bytes(b"corrupted")
    url = point["downloadUrl"].replace("/sandbox-api","/sandbox")
    assert client.get(url).status_code == 422
    assert client.post("/sandbox/checkpoints/missing-assets", json={"hashes":[digest]}).json()["missing"] == [digest]
    assert client.post(f"/sandbox/checkpoints/assets/{digest}", files={"file":("a.bin",data)}).status_code == 200
    assert client.get(url).status_code == 200


def test_checkpoint_failed_commit_preserves_previous_restore_and_hides_partial_record(client, tmp_path, monkeypatch):
    from geolibre_server.app import sandbox_storage
    data, digest, payload = checkpoint_payload()
    client.post(f"/sandbox/checkpoints/assets/{digest}", files={"file":("a.bin",data)})
    point = client.post("/sandbox/checkpoints", json=payload).json()
    original = sandbox_storage.os.replace
    def fail_record(source, target):
        if target.parent.name == "records":
            raise OSError("simulated full disk")
        original(source, target)
    payload["project"]["metadata"]["height"] = 7
    with monkeypatch.context() as patch:
        patch.setattr(sandbox_storage.os, "replace", fail_record)
        assert client.post("/sandbox/checkpoints", json=payload).status_code == 507
    assert [p["id"] for p in client.get("/sandbox/checkpoints").json()["checkpoints"]] == [point["id"]]
    assert client.get(point["downloadUrl"].replace("/sandbox-api","/sandbox")).status_code == 200
    assert not list((tmp_path / "checkpoints/records").glob(".pending-*"))


def test_checkpoint_quota_invalid_references_and_document_corruption(client, tmp_path, monkeypatch):
    from geolibre_server.app import sandbox_recovery
    data, digest, payload = checkpoint_payload()
    client.post(f"/sandbox/checkpoints/assets/{digest}", files={"file":("a.bin",data)})
    point = client.post("/sandbox/checkpoints", json=payload).json()
    payload["project"]["metadata"]["height"] = 9
    with monkeypatch.context() as patch:
        patch.setattr(sandbox_recovery, "MAX_STORAGE", 1)
        assert client.post("/sandbox/checkpoints", json=payload).status_code == 507
    payload["project"]["layers"][0]["asset"] = "geosandbox-asset:assets/unknown.bin"
    assert client.post("/sandbox/checkpoints", json=payload).status_code == 422
    document = tmp_path / "checkpoints/documents" / (point["documentHash"] + ".json")
    document.write_bytes(b"{}")
    assert client.get(point["downloadUrl"].replace("/sandbox-api","/sandbox")).status_code == 422
    assert client.get("/sandbox/checkpoints", headers={"Origin":"https://evil.invalid"}).status_code == 403
    assert client.post("/sandbox/checkpoints/missing-assets", json={"hashes":["../other"]}).status_code == 422


def test_export_write_failure_does_not_publish_partial_artifact(client, tmp_path, monkeypatch):
    from geolibre_server.app import sandbox_storage
    saved = client.post("/sandbox/exports", files={"file":("good.geosandbox",b"known good")}).json()
    def fail(*args):
        raise OSError("simulated storage failure")
    with monkeypatch.context() as patch:
        patch.setattr(sandbox_storage.os, "replace", fail)
        assert client.post("/sandbox/exports",files={"file":("bad.geosandbox",b"partial")}).status_code == 507
    assert client.get(saved["downloadUrl"].replace("/sandbox-api","/sandbox")).content == b"known good"
    assert len(client.get("/sandbox/projects").json()["projects"]) == 1
    assert not list((tmp_path / "exports").glob(".pending-*"))


def test_frozen_native_fixture_metadata_matches_m0_manifest():
    from pathlib import Path
    import pyogrio
    import rasterio
    root = Path(__file__).resolve().parents[3]
    baseline = json.loads((root / "tests/fixtures/geosandbox/acceptance.json").read_text(encoding="utf-8"))
    for case in baseline["cases"]:
        path = root / case["path"]
        expected = case["expected"]
        if case["expectedFormat"] in {"gpkg", "zip"}:
            reader = "/vsizip/" + path.as_posix() if case["expectedFormat"] == "zip" else str(path)
            frame = pyogrio.read_dataframe(reader, layer=expected["layer"])
            assert len(frame) == expected["features"]
            if "crs" in expected:
                assert frame.crs.to_string() == expected["crs"]
        elif case["expectedFormat"] == "tif":
            with rasterio.open(path) as dataset:
                assert (dataset.width, dataset.height, dataset.count) == (expected["width"], expected["height"], expected["bands"])
                assert str(dataset.crs) == expected["crs"]


def test_export_receipts_survive_new_app_and_replay_without_duplicates(client, tmp_path):
    request_id = "1" * 32
    headers = {"X-GeoSandbox-Export-Id": request_id}
    first = client.post("/sandbox/exports", headers=headers, files={"file": ("receipt.geosandbox", b"constructed bytes")})
    assert first.status_code == 200
    receipt = first.json()
    assert receipt["requestId"] == request_id
    assert client.get(f"/sandbox/export-receipts/{request_id}").json() == receipt
    replay = client.post("/sandbox/exports", headers=headers, files={"file": ("receipt.geosandbox", b"constructed bytes")})
    assert replay.json() == receipt
    assert len(list((tmp_path / "exports").iterdir())) == 1
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as restarted:
        assert restarted.get(f"/sandbox/export-receipts/{request_id}").json() == receipt


def test_export_request_id_cannot_overwrite_different_bytes_or_filename(client, tmp_path):
    request_id = "2" * 32
    headers = {"X-GeoSandbox-Export-Id": request_id}
    client.post("/sandbox/exports", headers=headers, files={"file": ("same.bin", b"original")})
    assert client.post("/sandbox/exports", headers=headers, files={"file": ("same.bin", b"changed")}).status_code == 409
    assert client.post("/sandbox/exports", headers=headers, files={"file": ("different.bin", b"original")}).status_code == 409
    files = list((tmp_path / "exports").iterdir())
    assert len(files) == 1 and files[0].read_bytes() == b"original"


def test_export_archive_is_reversible_and_keeps_legacy_download_and_receipt(client, tmp_path):
    from pathlib import Path
    raw = b"constructed export"
    name = "成果 #1.geosandbox"
    receipt = client.post("/sandbox/exports", files={"file": (name, raw)}).json()
    download = receipt["downloadUrl"].replace("/sandbox-api", "/sandbox")
    url = download.replace("/exports/", "/export-library/")
    assert client.get("/sandbox/projects").json()["projects"][0]["name"] == "成果 #1"
    assert client.patch(url, json={"archived": "false"}).status_code == 422
    assert client.patch(url, json={"archived": True}, headers={"Origin": "https://foreign.invalid"}).status_code == 403
    for _ in range(2):
        assert client.patch(url, json={"archived": True}).json() == {"archived": True}
    assert client.get("/sandbox/projects").json()["projects"] == []
    assert client.get("/sandbox/export-library").json() == {"items": [], "total": 0}
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as reopened:
        listing = reopened.get("/sandbox/export-library?archived=true").json()
        assert listing["total"] == 1 and listing["items"][0]["name"] == name
        assert reopened.get(download).content == raw == Path(receipt["path"]).read_bytes()
        assert reopened.get(f"/sandbox/export-receipts/{receipt['requestId']}").json() == receipt
        assert reopened.patch(url, json={"archived": False}).json() == {"archived": False}
        assert reopened.get("/sandbox/projects").json()["projects"][0]["name"] == "成果 #1"


def test_export_archive_catalogue_paginates_all_versions_and_formats(client, tmp_path):
    folder = tmp_path / "exports"
    folder.mkdir()
    for index in range(21):
        name = "same.geosandbox" if index < 20 else "model.glb"
        (folder / f"{index:032x}_{name}").write_bytes(b"test")
    (folder / ".pending-test").write_text("not committed")
    first = client.get("/sandbox/export-library").json()
    second = client.get("/sandbox/export-library?offset=20").json()
    assert first["total"] == second["total"] == 21
    assert len(first["items"]) == 20 and len(second["items"]) == 1
    assert len({item["exportId"] for item in first["items"] + second["items"]}) == 21
    assert len(client.get("/sandbox/projects").json()["projects"]) == 1


def test_export_receipt_rejects_invalid_ids_foreign_origins_and_uncommitted_files(client, tmp_path, monkeypatch):
    from geolibre_server.app import sandbox
    request_id = "3" * 32
    assert client.get("/sandbox/export-receipts/../invalid").status_code in {404, 422}
    assert client.get(f"/sandbox/export-receipts/{request_id}", headers={"Origin": "https://foreign.invalid"}).status_code == 403
    assert client.post("/sandbox/exports", headers={"X-GeoSandbox-Export-Id": "invalid"}, files={"file": ("x.bin", b"x")}).status_code == 422
    monkeypatch.setattr(sandbox, "atomic_write", lambda *_: (_ for _ in ()).throw(OSError("constructed disk failure")))
    assert client.post("/sandbox/exports", headers={"X-GeoSandbox-Export-Id": request_id}, files={"file": ("x.bin", b"x")}).status_code == 507
    assert client.get(f"/sandbox/export-receipts/{request_id}").status_code == 404
    assert not list((tmp_path / "exports").glob(".pending-*"))


def test_concurrent_replayed_export_requests_publish_one_artifact(client, tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    def send():
        return client.post("/sandbox/exports", headers={"X-GeoSandbox-Export-Id": "4" * 32},
                           files={"file": ("concurrent.bin", b"constructed shared bytes")})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: send(), range(2)))
    assert all(result.status_code == 200 for result in results)
    assert results[0].json() == results[1].json()
    assert len(list((tmp_path / "exports").iterdir())) == 1
