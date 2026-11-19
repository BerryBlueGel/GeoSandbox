"""Destructive cases run only in isolated pytest directories on D via launcher TEMP."""
import hashlib
import io
import json
import os
import time
import uuid
from pathlib import Path
from zipfile import ZipFile

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from geolibre_server.app import sandbox_maintenance as maintenance
from geolibre_server.app import sandbox_recovery as recovery

BASE = "/sandbox/storage"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("GEOSANDBOX_DATA_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(recovery.router)
    app.include_router(maintenance.router)
    return TestClient(app)


def checkpoint(client, name="constructed project", data=b"constructed shared original", revision=1, project_id="fixture"):
    digest = hashlib.sha256(data).hexdigest()
    response = client.post(f"/sandbox/checkpoints/assets/{digest}", files={"file":("a.bin",data)})
    assert response.status_code == 200
    payload = {"project":{"version":"0.2.0","name":name,"layers":[{"id":"constructed","data":"geosandbox-asset:assets/"+digest+".bin"}],"revision":revision},
               "manifest":{"format":"geosandbox","version":1,"assets":[{"path":f"assets/{digest}.bin","mime":"application/octet-stream","sha256":digest,"bytes":len(data)}],"externalReferences":[]}}
    if project_id is not None:
        payload["project"]["id"] = str(uuid.uuid5(uuid.NAMESPACE_DNS, name)) if project_id == "fixture" else project_id
    response = client.post("/sandbox/checkpoints", json=payload)
    assert response.status_code == 200, response.text
    return response.json(), digest


def age(root):
    old = time.time() - 48 * 3600
    for kind in ("assets", "documents"):
        for path in (root / "checkpoints" / kind).glob("*"):
            os.utime(path, (old, old))


def preview(client, ids=(), orphans=True):
    response = client.post(BASE+"/preview", json={"checkpointIds":list(ids),"orphanedFiles":orphans})
    assert response.status_code == 200, response.text
    return response.json()


def execute(client, plan, ids=(), request_id=None):
    return client.post(BASE+"/cleanup/"+(request_id or uuid.uuid4().hex), json={"checkpointIds":list(ids),"orphanedFiles":True,"fingerprint":plan["fingerprint"]})


def assert_bundle(client, point, data):
    response = client.get(point["downloadUrl"].replace("/sandbox-api", "/sandbox"))
    assert response.status_code == 200, response.text
    with ZipFile(io.BytesIO(response.content)) as bundle:
        manifest = json.loads(bundle.read("manifest.json"))
        assert bundle.read(manifest["assets"][0]["path"]) == data


def test_shared_assets_latest_project_and_unrelated_outputs_survive(client, tmp_path):
    first, digest = checkpoint(client)
    latest, _ = checkpoint(client, revision=2)
    other, _ = checkpoint(client, "another project", revision=1)
    for directory in ("assets","exports","native-jobs","logs"):
        folder=tmp_path/directory;folder.mkdir(exist_ok=True);(folder/"keep-original.bin").write_bytes(b"never-delete")
    age(tmp_path)
    plan=preview(client,[first["id"]])
    assert len(plan["files"]) == 2  # old record + its unique document, shared asset retained
    assert not any(item["path"].startswith("assets/") for item in plan["files"])
    response=execute(client,plan,[first["id"]]);assert response.status_code==200,response.text
    assert response.json()["status"]=="completed"
    assert (tmp_path/"checkpoints/assets"/(digest+".bin")).is_file()
    assert_bundle(client,latest,b"constructed shared original")
    assert_bundle(client,other,b"constructed shared original")
    assert all((tmp_path/directory/"keep-original.bin").read_bytes()==b"never-delete" for directory in ("assets","exports","native-jobs","logs"))


def test_unique_old_asset_is_reclaimed_and_capacity_accounting_matches(client, tmp_path):
    first,digest=checkpoint(client,data=b"old unique original")
    latest,_=checkpoint(client,data=b"new unique original",revision=2)
    age(tmp_path)
    before=recovery.usage();plan=preview(client,[first["id"]])
    assert len(plan["files"])==3
    result=execute(client,plan,[first["id"]]).json()
    assert result["removedBytes"]==plan["reclaimableBytes"]
    assert before-recovery.usage()==result["removedBytes"]
    assert not (tmp_path/"checkpoints/assets"/(digest+".bin")).exists()
    assert_bundle(client,latest,b"new unique original")


def test_recent_missing_asset_check_pins_inflight_save_and_invalidates_preview(client,tmp_path):
    first,digest=checkpoint(client,data=b"old unique")
    checkpoint(client,data=b"new unique",revision=2)
    age(tmp_path)
    stale=preview(client,[first["id"]])
    assert client.post("/sandbox/checkpoints/missing-assets",json={"hashes":[digest]}).json()["missing"]==[]
    assert execute(client,stale,[first["id"]]).status_code==409
    plan=preview(client,[first["id"]]);assert plan["recentOrphans"]>=1
    assert f"assets/{digest}.bin" not in [item["path"] for item in plan["files"]]
    assert execute(client,plan,[first["id"]]).json()["status"]=="completed"
    assert (tmp_path/"checkpoints/assets"/(digest+".bin")).is_file()


def test_latest_and_unknown_selection_are_rejected(client):
    point,_=checkpoint(client)
    assert client.post(BASE+"/preview",json={"checkpointIds":[point["id"]]}).status_code==409
    assert client.post(BASE+"/preview",json={"checkpointIds":[uuid.uuid4().hex]}).status_code==422
    assert client.get(BASE,headers={"Origin":"https://untrusted.example"}).status_code==403


def test_same_name_protects_two_projects_and_rename_keeps_lineage(client, tmp_path):
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    first, _ = checkpoint(client, "同名项目", project_id=a)
    other, _ = checkpoint(client, "同名项目", data=b"second project", project_id=b)
    same, _ = checkpoint(client, "同名项目", project_id=a)
    assert same["id"] == first["id"] and same["deduplicated"] is True
    before = {point["id"]: point for point in client.get(BASE).json()["points"]}
    assert before[first["id"]]["protected"] and before[other["id"]]["protected"]

    renamed, _ = checkpoint(client, "已改名", revision=2, project_id=a)
    legacy1, _ = checkpoint(client, "同名项目", revision=3, project_id=None)
    legacy2, _ = checkpoint(client, "同名项目", revision=4, project_id=None)
    # Index metadata alone cannot move a protected snapshot into another project.
    index = tmp_path / "checkpoints" / "records" / (other["id"] + ".json")
    index.write_text(json.dumps({**other, "projectId": a}), encoding="utf-8")

    points = {point["id"]: point for point in client.get(BASE).json()["points"]}
    assert points[renamed["id"]]["projectId"] == a and points[renamed["id"]]["protected"]
    assert points[other["id"]]["projectId"] == b and points[other["id"]]["protected"]
    assert not points[first["id"]]["protected"]
    for legacy in (legacy1, legacy2):
        assert points[legacy["id"]]["projectId"] is None and points[legacy["id"]]["protected"]
        assert client.post(BASE + "/preview", json={"checkpointIds": [legacy["id"]]}).status_code == 409
    age(tmp_path)
    plan = preview(client, [first["id"]])
    assert execute(client, plan, [first["id"]]).json()["status"] == "completed"
    for kept in (renamed, legacy1, legacy2):
        assert_bundle(client, kept, b"constructed shared original")
    assert_bundle(client, other, b"second project")


def test_new_checkpoint_after_preview_prevents_all_deletion(client,tmp_path):
    first,_=checkpoint(client);checkpoint(client,revision=2);age(tmp_path)
    plan=preview(client,[first["id"]])
    latest,_=checkpoint(client,revision=3)
    assert execute(client,plan,[first["id"]]).status_code==409
    assert (tmp_path/"checkpoints/records"/(first["id"]+".json")).is_file()
    assert_bundle(client,latest,b"constructed shared original")


@pytest.mark.parametrize("damage",["record","document","asset"])
def test_damaged_graph_fails_closed(client,tmp_path,damage):
    first,digest=checkpoint(client);latest,_=checkpoint(client,revision=2);age(tmp_path)
    if damage=="record":path=tmp_path/"checkpoints/records"/(latest["id"]+".json")
    elif damage=="document":path=tmp_path/"checkpoints/documents"/(latest["documentHash"]+".json")
    else:path=tmp_path/"checkpoints/assets"/(digest+".bin")
    path.write_bytes(b"broken")
    plan=preview(client);assert plan["blocked"] and not plan["files"]
    assert execute(client,plan).status_code==409
    assert (tmp_path/"checkpoints/records"/(first["id"]+".json")).is_file()


def test_orphan_grace_and_pending_files_are_preserved(client,tmp_path):
    checkpoint(client)
    old=tmp_path/"checkpoints/assets"/(hashlib.sha256(b"orphan").hexdigest()+".bin");old.write_bytes(b"orphan")
    recent=tmp_path/"checkpoints/assets"/(hashlib.sha256(b"recent").hexdigest()+".bin");recent.write_bytes(b"recent")
    age(tmp_path);os.utime(recent,None)
    pending=tmp_path/"checkpoints/assets/.pending-owned";pending.write_bytes(b"in progress")
    plan=preview(client);assert [item["path"] for item in plan["files"]]==["assets/"+old.name]
    assert execute(client,plan).json()["status"]=="completed"
    assert recent.read_bytes()==b"recent" and pending.read_bytes()==b"in progress"


def test_lost_ack_replay_and_new_server_keep_one_receipt(client,tmp_path):
    first,_=checkpoint(client);checkpoint(client,revision=2);age(tmp_path)
    plan=preview(client,[first["id"]]);request_id=uuid.uuid4().hex
    initial=execute(client,plan,[first["id"]],request_id).json()
    assert execute(client,plan,[first["id"]],request_id).json()==initial
    app=FastAPI();app.include_router(maintenance.router);fresh=TestClient(app)
    assert fresh.get(BASE+"/receipts/"+request_id).json()==initial
    assert len(list((tmp_path/"checkpoints/cleanup-receipts").glob("*.json")))==1


def test_interrupted_receipt_never_claims_exact_removed_counts(client):
    path=maintenance._receipt_path(uuid.uuid4().hex)
    maintenance._write_receipt(path,{"id":path.stem,"status":"running","removedBytes":123,"removedFiles":1,"fingerprint":"a"*64})
    result=client.get(BASE+"/receipts/"+path.stem).json()
    assert result["status"]=="interrupted" and result["removedBytes"] is None and result["removedFiles"] is None


def test_record_delete_failure_stops_before_removing_document_or_asset(client,tmp_path,monkeypatch):
    first,_=checkpoint(client);latest,_=checkpoint(client,revision=2);age(tmp_path)
    plan=preview(client,[first["id"]]);original=Path.unlink
    def failed(path,*args,**kwargs):
        if path.name==first["id"]+".json":raise PermissionError("constructed locked file")
        return original(path,*args,**kwargs)
    monkeypatch.setattr(Path,"unlink",failed)
    result=execute(client,plan,[first["id"]]).json()
    assert result["status"]=="partial" and result["removedFiles"]==0
    assert_bundle(client,first,b"constructed shared original");assert_bundle(client,latest,b"constructed shared original")


def test_quota_resumes_after_manual_cleanup(client,tmp_path,monkeypatch):
    first,_=checkpoint(client,data=b"a"*20000);checkpoint(client,data=b"b",revision=2);age(tmp_path)
    monkeypatch.setattr(recovery,"MAX_STORAGE",recovery.usage()+100)
    # Another document cannot fit, then the old unique content is reclaimed.
    with pytest.raises(HTTPException) as error:
        recovery.check_budget(200)
    assert error.value.status_code==507
    plan=preview(client,[first["id"]]);assert execute(client,plan,[first["id"]]).json()["status"]=="completed"
    recovery.check_budget(200)


def test_mid_cleanup_file_failure_keeps_remaining_restore_valid(client,tmp_path,monkeypatch):
    first,digest=checkpoint(client,data=b"old unique")
    latest,_=checkpoint(client,data=b"retained unique",revision=2);age(tmp_path)
    plan=preview(client,[first["id"]]);original=Path.unlink
    def failed(path,*args,**kwargs):
        if path.name==digest+".bin":raise PermissionError("constructed locked resource")
        return original(path,*args,**kwargs)
    monkeypatch.setattr(Path,"unlink",failed)
    result=execute(client,plan,[first["id"]]).json()
    assert result["status"]=="partial" and result["removedFiles"]>0
    assert_bundle(client,latest,b"retained unique")
    assert (tmp_path/"checkpoints/assets"/(digest+".bin")).read_bytes()==b"old unique"


def test_receipt_write_failure_after_deletion_never_claims_zero_or_full_success(client,tmp_path,monkeypatch):
    first,_=checkpoint(client);latest,_=checkpoint(client,revision=2);age(tmp_path)
    plan=preview(client,[first["id"]]);request_id=uuid.uuid4().hex
    original=maintenance._write_receipt;calls=0
    def fail_final(path,value):
        nonlocal calls
        calls+=1
        if calls==2:raise OSError("constructed full disk after deletion")
        return original(path,value)
    with monkeypatch.context() as patch:
        patch.setattr(maintenance,"_write_receipt",fail_final)
        with pytest.raises(OSError):execute(client,plan,[first["id"]],request_id)
    result=client.get(BASE+"/receipts/"+request_id).json()
    assert result["status"]=="interrupted" and result["removedBytes"] is None
    assert_bundle(client,latest,b"constructed shared original")


def test_overview_is_read_only_and_reports_categories(client,tmp_path):
    point,_=checkpoint(client);age(tmp_path)
    before={str(path.relative_to(tmp_path)):path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()}
    result=client.get(BASE).json();assert result["points"][0]["protected"] is True
    assert result["recoveryBytes"]==recovery.usage()
    assert set(result["categories"])=={"checkpoints","assets","exports","native-jobs","logs"}
    assert before=={str(path.relative_to(tmp_path)):path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()}


def test_linked_content_is_never_followed_or_deleted(client,tmp_path):
    import subprocess
    checkpoint(client)
    outside=tmp_path.parent/("outside-"+uuid.uuid4().hex);outside.mkdir();sentinel=outside/"keep";sentinel.write_bytes(b"keep")
    link=tmp_path/"checkpoints/assets"/("a"*64+".bin")
    if os.name == "nt":
        result=subprocess.run(["cmd","/c","mklink","/J",str(link),str(outside)],capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
        assert result.returncode==0
    else:link.symlink_to(outside,target_is_directory=True)
    try:
        assert preview(client)["blocked"]
        assert sentinel.read_bytes()==b"keep"
    finally:
        assert link.resolve()==outside.resolve() and link.parent.resolve()==(tmp_path/"checkpoints/assets").resolve()
        if os.name=="nt":link.rmdir()  # Remove the verified junction itself, never its target.
        else:link.unlink()
