"""Real subprocess imports, cancellation, durable receipts and owner lifetime."""
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from geolibre_server.app import conversion, sandbox_native_jobs as native

BASE = "/sandbox/native-jobs"
POINT = b'{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"constructed"},"geometry":{"type":"Point","coordinates":[118,39]}}]}'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOSANDBOX_DATA_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(native.router)
    with TestClient(app) as value:
        yield value
        # Only processes registered by these tests are touched, never a saved PID.
        for job_id in list(native._ACTIVE):
            value.post(f"{BASE}/{job_id}/cancel")
        assert not native._ACTIVE


def submit(client, content=POINT, name="constructed.geojson", kind="vector", **data):
    job_id = str(uuid.uuid4())
    response = client.post(f"{BASE}/{job_id}", files={"file": (name, content)}, data={"kind": kind, **data})
    assert response.status_code == 200, response.text
    return job_id


def finished(client, job_id, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        record = client.get(f"{BASE}/{job_id}").json()
        if record["status"] in native._TERMINAL:
            return record
        time.sleep(0.05)
    pytest.fail("Native job did not finish")


def test_vector_real_worker_preserves_original_and_result_receipt(client, tmp_path):
    job_id = submit(client)
    record = finished(client, job_id)
    assert record["status"] == "succeeded", record
    assert record["processStopped"] is True
    assert record["inputSha256"] == hashlib.sha256(POINT).hexdigest()
    assert record["inputBytes"] == len(POINT)
    result = client.get(f"{BASE}/{job_id}/result").json()
    assert result["layers"][0]["geojson"]["features"][0]["geometry"]["coordinates"] == [118, 39]
    assert (tmp_path / "assets" / Path(result["assetUrl"]).name).read_bytes() == POINT
    assert "workerPid" not in record and "inputSuffix" not in record
    assert client.get(BASE).json()["jobs"][0]["id"] == job_id
    url = f"{BASE}/{job_id}/archive"
    assert client.patch(url, json={"archived": True}).json() == {"archived": True}
    assert client.get(BASE).json()["jobs"] == []
    archived = client.get(BASE + "?archived=true&offset=0").json()
    assert archived["total"] == 1 and archived["jobs"][0]["id"] == job_id
    assert client.get(f"{BASE}/{job_id}/result").json() == result
    assert client.patch(url, json={"archived": False}).json() == {"archived": False}
    assert client.get(BASE).json()["jobs"][0]["id"] == job_id
    # Same request ID never causes a second process or changes the stored input.
    replay = client.post(f"{BASE}/{job_id}", files={"file": ("other.geojson", b"wrong")}, data={"kind": "vector"})
    assert replay.json()["inputSha256"] == record["inputSha256"]
    (tmp_path / "native-jobs" / job_id / "result.json").write_text("{}")
    assert client.get(f"{BASE}/{job_id}/result").status_code == 409


def test_raster_real_worker_preserves_samples_and_preview(client, tmp_path):
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds
    path = tmp_path / "constructed.tif"
    with rasterio.open(path, "w", driver="GTiff", width=8, height=8, count=1, dtype="uint16", crs="EPSG:4326", transform=from_bounds(118,39,119,40,8,8)) as dst:
        dst.write(np.arange(64, dtype="uint16").reshape(1,8,8))
    raw = path.read_bytes()
    job_id = submit(client, raw, path.name, "raster")
    record = finished(client, job_id)
    assert record["status"] == "succeeded", record
    result = client.get(f"{BASE}/{job_id}/result").json()
    assert result["bounds"] == [118,39,119,40]
    assert result["sourceDtypes"] == ["uint16"]
    assert (tmp_path / "assets" / Path(result["assetUrl"]).name).read_bytes() == raw
    with rasterio.open(tmp_path / "assets" / Path(result["previewUrl"]).name) as preview:
        assert preview.count == 4 and preview.dtypes == ("uint8",) * 4


def test_vector_inspection_and_scoped_crs_override_preserve_correct_layer(client, tmp_path):
    import geopandas as gpd
    import pyogrio
    from pyproj import Transformer

    original = tmp_path / "mixed.gpkg"
    expected = (118.14, 39.64)
    wrong = Transformer.from_crs(4326, 3857, always_xy=True).transform(*expected)
    for name, point in [("正常图层", expected), ("误标图层", wrong)]:
        frame = gpd.GeoDataFrame(geometry=gpd.points_from_xy([point[0]], [point[1]]), crs="EPSG:4326")
        pyogrio.write_dataframe(frame, original, layer=name, driver="GPKG")

    raw = original.read_bytes()
    inspection = submit(client, raw, original.name, operation="inspect")
    assert finished(client, inspection)["status"] == "succeeded"
    inspected = client.get(f"{BASE}/{inspection}/result").json()
    assert {layer["name"]: layer["declaredCrs"] for layer in inspected["layers"]} == {"正常图层": "EPSG:4326", "误标图层": "EPSG:4326"}
    assert not (tmp_path / "native-jobs" / inspection / "input.gpkg").exists()
    assert not (tmp_path / "assets").exists()

    unsafe = submit(client, raw, original.name, source_crs="EPSG:3857", force_crs="true")
    refused = finished(client, unsafe)
    assert refused["status"] == "failed" and "多个图层" in refused["stage"]
    stale = submit(client, raw, original.name, layer_crs=json.dumps({"unknown": "EPSG:3857"}))
    assert "不存在的图层" in finished(client, stale)["stage"]
    assert not (tmp_path / "assets").exists()

    scoped = submit(client, raw, original.name, layer_crs=json.dumps({"误标图层": "EPSG:3857"}))
    assert finished(client, scoped)["status"] == "succeeded"
    result = client.get(f"{BASE}/{scoped}/result").json()
    for layer in result["layers"]:
        changed = layer["name"] == "误标图层"
        assert layer["geojson"]["features"][0]["geometry"]["coordinates"] == pytest.approx(expected)
        assert layer["declaredCrs"] == "EPSG:4326"
        assert layer["sourceCrs"] == ("EPSG:3857" if changed else "EPSG:4326")
        assert layer["crsOverridden"] is changed
    assert (tmp_path / "assets" / Path(result["assetUrl"]).name).read_bytes() == raw


def slow_script():
    return """import sys, json, time
from pathlib import Path
p=json.loads(sys.argv[1])
sys.path.insert(0,p['package_root'])
from geolibre_server.app.sandbox_native_worker import watch_parent
watch_parent(p['parent_pid'])
Path(p['output_path']).with_name('entered').write_text('ready')
time.sleep(60)
"""


def test_cancel_running_reaps_owned_process_and_never_publishes(client, tmp_path, monkeypatch):
    monkeypatch.setattr(native, "_SCRIPT", slow_script())
    job_id = submit(client)
    folder = tmp_path / "native-jobs" / job_id
    deadline = time.monotonic() + 10
    while not (folder / "entered").exists() and time.monotonic() < deadline:
        time.sleep(.05)
    assert (folder / "entered").exists()
    with conversion._JOBS_LOCK:
        process = conversion._PROCESSES[job_id]
    assert client.patch(f"{BASE}/{job_id}/archive", json={"archived": True}).status_code == 409
    response = client.post(f"{BASE}/{job_id}/cancel")
    assert response.json()["status"] == "cancelled"
    assert response.json()["processStopped"] is True
    assert process.poll() is not None
    assert job_id not in conversion._PROCESSES
    assert client.get(f"{BASE}/{job_id}/result").status_code == 409
    assert not (tmp_path / "assets").exists()
    assert (folder / "input.geojson").read_bytes() == POINT


def test_cancel_before_submit_is_a_durable_tombstone(client):
    job_id = str(uuid.uuid4())
    assert client.post(f"{BASE}/{job_id}/cancel").json()["processStopped"] is True
    response = client.post(f"{BASE}/{job_id}", files={"file": ("late.geojson", POINT)}, data={"kind": "vector"})
    assert response.json()["status"] == "cancelled"
    assert job_id not in conversion._JOBS


def test_restart_marks_unowned_work_interrupted_without_killing_saved_pid(client, tmp_path, monkeypatch):
    job_id = str(uuid.uuid4())
    folder = tmp_path / "native-jobs" / job_id
    native._write(folder, dict(id=job_id, kind="vector", filename="constructed", status="running", stage="old", workerPid=os.getpid(), createdAt=0, processStopped=False))
    monkeypatch.setattr(conversion, "_cancel_job", lambda _: pytest.fail("Must not kill saved PID"))
    record = client.get(f"{BASE}/{job_id}").json()
    assert record["status"] == "interrupted" and record["processStopped"] is None
    assert client.post(f"{BASE}/{job_id}/cancel").json()["status"] == "interrupted"
    assert client.get(f"{BASE}/{job_id}/result").status_code == 409
    assert json.loads((folder / "job.json").read_text())["status"] == "interrupted"


def test_native_limit_and_timeout_use_shared_runner(client, monkeypatch):
    monkeypatch.setattr(native, "_SCRIPT", slow_script())
    monkeypatch.setattr(native, "TIMEOUT", 1)
    first, second = submit(client), submit(client)
    third = client.post(f"{BASE}/{uuid.uuid4()}", files={"file": ("third.geojson", POINT)}, data={"kind":"vector"})
    assert third.status_code == 429
    for job_id in (first, second):
        record = finished(client, job_id)
        assert record["status"] == "failed" and record["processStopped"] is True
        assert job_id not in conversion._PROCESSES


def test_size_type_and_origin_guards(client, monkeypatch):
    monkeypatch.setattr(native, "MAX_INPUT", 2)
    response = client.post(f"{BASE}/{uuid.uuid4()}", files={"file": ("big.geojson", POINT)}, data={"kind":"vector"})
    assert response.status_code == 413
    response = client.post(f"{BASE}/{uuid.uuid4()}", files={"file": ("bad.exe", b"x")}, data={"kind":"vector"})
    assert response.status_code == 422
    assert client.get(BASE, headers={"Origin":"https://other.example"}).status_code == 403
    assert client.post(f"{BASE}/bad-id/cancel").status_code == 422


def test_curated_crs_failure_and_generic_driver_failure(client):
    bad = submit(client, b"not GIS", "bad.gpkg")
    record = finished(client, bad)
    assert record["status"] == "failed"
    assert "\\" not in record["stage"]
    assert record["processStopped"] is True


@pytest.mark.skipif(os.name != "nt", reason="Windows process-handle owner guard")
def test_parent_death_guard_stops_child_without_pid_kill(tmp_path):
    import ctypes
    ready = tmp_path / "child-ready"
    package = str(Path(native.__file__).resolve().parents[2])
    child = f"import sys,time; sys.path.insert(0,{package!r}); from geolibre_server.app.sandbox_native_worker import watch_parent; watch_parent(int(sys.argv[1])); from pathlib import Path; Path({str(ready)!r}).write_text('ready'); time.sleep(60)"
    controller = f"import subprocess,sys,os; p=subprocess.Popen([sys.executable,'-c',{child!r},str(os.getpid())],creationflags=subprocess.CREATE_NO_WINDOW); print(p.pid,flush=True); sys.stdin.readline(); os._exit(0)"
    parent = subprocess.Popen([sys.executable,"-c",controller], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_bool, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = None
    try:
        pid = int(parent.stdout.readline())
        handle = kernel.OpenProcess(0x00100000, False, pid)
        assert handle
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(.05)
        assert ready.exists()
        parent.stdin.write("exit\n")
        parent.stdin.flush()
        parent.wait(timeout=5)
        assert kernel.WaitForSingleObject(handle, 5000) == 0
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        if handle:
            kernel.CloseHandle(handle)


def test_worker_environment_excludes_credentials(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "constructed-secret")
    monkeypatch.setenv("OTHER_API_KEY", "constructed-secret")
    assert not any("KEY" in key for key in native._environment())
