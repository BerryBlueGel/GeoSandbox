"""Unit coverage for container sidecar capability enforcement."""

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "sidecar_policy", ROOT / "docker" / "sidecar_policy.py"
)
sp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sp)

PROCESSING = {"whitebox", "raster", "vector", "pointcloud", "obia", "ml", "sql"}


def test_route_ownership_contract():
    assert sp.ROUTE_CAPABILITIES == {
        **{prefix: frozenset({"processing:run"}) for prefix in PROCESSING},
        "postgis": frozenset({"data:add"}),
        "mssql": frozenset({"data:add"}),
        "conversion": frozenset({"processing:run", "data:add"}),
    }


@pytest.mark.parametrize(
    "capabilities,denied,start",
    [
        (None, set(), True),
        ([], PROCESSING | {"postgis", "mssql", "conversion"}, False),
        (["export:data"], PROCESSING | {"postgis", "mssql", "conversion"}, False),
        (["data:add"], PROCESSING, True),
        (["processing:run"], {"postgis", "mssql"}, True),
        (["processing:run", "data:add"], set(), True),
        (["project:edit", "sharing:embed"], PROCESSING | {"postgis", "mssql", "conversion"}, False),
    ],
)
def test_capability_matrix(capabilities, denied, start):
    policy = {"version": 1}
    if capabilities is not None:
        policy["capabilities"] = capabilities
    guards, off, should_start = sp.generate_snippets(policy)
    assert should_start is start
    for prefix in sp.ROUTE_CAPABILITIES:
        assert (f"location ^~ /sidecar/{prefix} {{" in guards) == (prefix in denied)
    for prefix in sp.RESERVED_PREFIXES:
        assert f"location ^~ /sidecar/{prefix} {{" in guards
    assert guards.count("return 403") == len(denied) + len(sp.RESERVED_PREFIXES)
    assert ("return 403" in off) == (not start)
    for snippet in (guards, off):
        if "return 403" in snippet:
            assert "default_type application/json;" in snippet
            assert '"detail":' in snippet
    for prefix in sp.UNGUARDED_PREFIXES:
        assert f"location ^~ /sidecar/{prefix} {{" not in guards


@pytest.mark.parametrize(
    "policy", [{"version": 1}, {"version": 1, "capabilities": ["processing:run", "data:add"]}]
)
def test_disable_override_turns_unrestricted_sidecar_off(policy):
    _, off, start = sp.generate_snippets(policy, disabled=True)
    assert start is False
    assert "return 403" in off
    assert "default_type application/json;" in off


def server_env(**overrides):
    return {"GEOSANDBOX_SERVER": "1", "GEOLIBRE_AUTH_USER": "owner", "GEOLIBRE_AUTH_PASSWORD": "test-only",
            "GEOSANDBOX_PUBLIC_ORIGIN": "https://sandbox.example.test", "GEOSANDBOX_DATA_DIR": "/data/geosandbox", **overrides}


@pytest.mark.parametrize("overrides,reason", [
    ({"GEOLIBRE_AUTH_PASSWORD": ""}, "requires GEOLIBRE_AUTH"),
    ({"GEOSANDBOX_PUBLIC_ORIGIN": "http://sandbox.example.test"}, "HTTPS site origin"),
    ({"GEOSANDBOX_PUBLIC_ORIGIN": "https://sandbox.example.test/path"}, "HTTPS site origin"),
    ({"GEOSANDBOX_DATA_DIR": "/data/../tmp"}, "dedicated subdirectory"),
    ({"GEOLIBRE_DISABLE_SIDECAR": "1"}, "requires the Python sidecar"),
])
def test_profile_fails_closed(overrides, reason):
    with pytest.raises(SystemExit, match=reason):
        sp.sandbox_proxy({"version": 1}, server_env(**overrides))


def test_sandbox_routes_are_scoped_to_the_private_profile_and_ai_policy():
    assert "location" not in sp.sandbox_proxy({"version": 1}, {})
    with pytest.raises(SystemExit, match="requires project:edit"):
        sp.sandbox_proxy({"version": 1, "capabilities": ["data:add"]}, server_env())
    disabled_ai = sp.sandbox_proxy({"version": 1}, server_env())
    assert "location ^~ /sandbox-api/" in disabled_ai and "client_max_body_size 300m" in disabled_ai
    assert "location = /ai" not in disabled_ai
    enabled_ai = sp.sandbox_proxy({"version": 1, "ai": {"enabled": True}}, server_env())
    assert "location = /ai/v1/chat/completions" in enabled_ai
    assert enabled_ai.count('proxy_set_header Authorization "";') == 2
