"""Independently check a saved project against its static assembly GLB (no browser).

Usage: .venv/Scripts/python scripts/geosandbox-verify-artifacts.py PROJECT GLB ANCHOR_JSON
Uses SHA-256, standard GLB parsing and PROJ/Geod instead of the browser's Cesium math.
"""
import argparse
import hashlib
import json
import math
import struct
from pathlib import Path
from zipfile import ZipFile

from pyproj import Geod


def verify(project_path: Path, glb_path: Path, anchor_path: Path):
    with ZipFile(project_path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        project = json.loads(archive.read("project.json"))
        assert manifest["format"] == "geosandbox"
        for asset in manifest["assets"]:
            content = archive.read(asset["path"])
            assert len(content) == asset["bytes"], "Asset length mismatch"
            assert hashlib.sha256(content).hexdigest() == asset["sha256"], "Asset hash mismatch"

    binary = glb_path.read_bytes()
    magic, version, length = struct.unpack_from("<III", binary)
    assert (magic, version, length) == (0x46546C67, 2, len(binary))
    json_length, chunk_type = struct.unpack_from("<II", binary, 12)
    assert chunk_type == 0x4E4F534A
    gltf = json.loads(binary[20:20 + json_length])
    metadata = json.loads(anchor_path.read_text(encoding="utf-8"))
    assert gltf["extras"]["geosandbox"] == metadata, "GLB and anchor JSON differ"

    expected = []
    groups = {group["id"]: group for group in project.get("layerGroups", [])}
    for layer in project["layers"]:
        config = layer.get("metadata", {}).get("vizConfig", {})
        if not layer.get("visible") or config.get("layerKind") != "scenegraph":
            continue
        group_id, ancestors, visible = layer.get("groupId"), set(), True
        while group_id in groups and group_id not in ancestors:
            ancestors.add(group_id)
            group = groups[group_id]
            visible = visible and group.get("visible", True)
            group_id = group.get("parentId")
        if not visible:
            continue
        mapping = config["fieldMapping"]
        scene = config["scenegraph"]
        for row in layer["source"]["data"]:
            def field(name, fallback):
                value = row.get(mapping.get(name), fallback)
                return float(fallback if value is None or value == "" else value)
            expected.append({
                "layerId": layer["id"], "name": layer["name"],
                "placement": {
                    "lng": field("lng", math.nan), "lat": field("lat", math.nan),
                    "altitude": field("altitude", 0) + scene.get("altitude", 0),
                    "bearing": field("bearing", scene.get("bearing", 0)),
                    "scale": field("scale", 1) * scene.get("sizeScale", 1),
                },
            })
    assert expected and expected == metadata["instances"], "Project and GLB instances differ"
    roots = gltf["scenes"][gltf.get("scene", 0)]["nodes"]
    assert len(roots) == len(expected), "GLB root instance count differs"
    anchor = metadata["importPlacement"]
    geod = Geod(ellps="WGS84")
    errors = []
    for index, record in zip(roots, expected):
        node = gltf["nodes"][index]
        placement = record["placement"]
        if "matrix" in node:
            matrix = node["matrix"]
            xyz = matrix[12:15]
            scales = [math.sqrt(sum(matrix[c * 4 + r] ** 2 for r in range(3))) for c in range(3)]
        else:
            xyz = node.get("translation", [0, 0, 0])
            scales = node.get("scale", [1, 1, 1])
        assert all(abs(value - placement["scale"]) < 1e-5 for value in scales), "Scale mismatch"
        _, _, distance = geod.inv(anchor["lng"], anchor["lat"], placement["lng"], placement["lat"])
        errors.append(abs(distance - math.hypot(xyz[0], xyz[2])))
    assert max(errors) < .02, "Horizontal distances differ by more than 2 cm"
    return {
        "passed": True, "projectLayers": len(project["layers"]),
        "verifiedAssets": len(manifest["assets"]), "modelInstances": len(expected),
        "maxDistanceDifferenceMetres": max(errors),
        "note": "Checks numeric conversion on the supplied artifacts, not survey accuracy.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("glb", type=Path)
    parser.add_argument("anchor", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.project, args.glb, args.anchor), indent=2))
