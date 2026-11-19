"""Every backend route prefix must have an explicit container policy owner."""

import importlib.util
from pathlib import Path

from geolibre_server.app.main import app

ROOT = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location(
    "sidecar_policy", ROOT / "docker" / "sidecar_policy.py"
)
sp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sp)


def route_paths(routes, prefix=""):
    for route in routes:
        if hasattr(route, "path"):
            yield prefix + route.path
        else:
            # Recent FastAPI versions retain lazy include_router wrappers.
            # Inspect all routes, including those excluded from OpenAPI.
            yield from route_paths(
                route.original_router.routes, prefix + route.include_context.prefix
            )


def test_every_sidecar_route_prefix_is_classified():
    prefixes = {path.lstrip("/").split("/", 1)[0] for path in route_paths(app.routes)}
    guarded = set(sp.ROUTE_CAPABILITIES)
    unguarded = set(sp.UNGUARDED_PREFIXES)
    reserved = set(sp.RESERVED_PREFIXES)
    expected = guarded | unguarded | reserved
    assert len(expected) == len(guarded) + len(unguarded) + len(reserved)
    assert prefixes == expected, (
        f"Unclassified backend prefixes: {prefixes - expected}; "
        f"policy prefixes without routes: {expected - prefixes}"
    )
