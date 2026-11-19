"""Container-only capability enforcement for the normalized sidecar URI."""

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

# Any one owning capability grants the entire route prefix. Conversion is also
# polled by raster jobs and used when adding data, so both owners must work.
ROUTE_CAPABILITIES = {
    "whitebox": frozenset({"processing:run"}),
    "raster": frozenset({"processing:run"}),
    "vector": frozenset({"processing:run"}),
    "pointcloud": frozenset({"processing:run"}),
    "obia": frozenset({"processing:run"}),
    "ml": frozenset({"processing:run"}),
    "sql": frozenset({"processing:run"}),
    "postgis": frozenset({"data:add"}),
    "mssql": frozenset({"data:add"}),
    "conversion": frozenset({"processing:run", "data:add"}),
}

# Explicit exceptions checked against FastAPI's routes by the backend suite.
# These retain their existing behavior whenever the sidecar is running.
UNGUARDED_PREFIXES = frozenset(
    {
        "health",
        "algorithms",
        "shutdown",
        "run",
        "docs",
        "redoc",
        "openapi.json",
    }
)
RESERVED_PREFIXES = frozenset({"sandbox", "ai"})
SANDBOX_CAPABILITIES = frozenset({"project:edit", "data:add", "processing:run", "export:data"})

_DENY = (
    "    default_type application/json;\n"
    '    return 403 \'{"detail":"Sidecar disabled by deployment policy"}\';\n'
    "    types {}\n"
)


def generate_snippets(policy, disabled=False):
    """Return (prefix guards, whole-sidecar off directives, should start)."""
    capabilities = policy.get("capabilities")
    # Omitted means unrestricted; [] is an explicit empty grant.
    granted = (
        frozenset().union(*ROUTE_CAPABILITIES.values())
        if capabilities is None
        else frozenset(capabilities)
    )
    start = not disabled and any(granted & required for required in ROUTE_CAPABILITIES.values())
    guards = "# Generated sidecar capability guards.\n"
    for prefix, required in ROUTE_CAPABILITIES.items():
        if not granted & required:
            # nginx matches its normalized URI (percent decoding and slash
            # merging), not $request_uri. ^~ also defeats static-asset regexes.
            guards += f"location ^~ /sidecar/{prefix} {{\n{_DENY}}}\n"
    for prefix in sorted(RESERVED_PREFIXES):
        guards += f"location ^~ /sidecar/{prefix} {{\n{_DENY}}}\n"
    off = "# Generated whole-sidecar switch.\n" + ("" if start else _DENY)
    return guards, off, start


_PROXY = '''    proxy_http_version 1.1;
    proxy_set_header Host 127.0.0.1;
    proxy_set_header X-GeoLibre-Token "__GEOLIBRE_SIDECAR_TOKEN__";
    proxy_set_header Authorization "";
    proxy_read_timeout 180s;
    proxy_buffering off;
    add_header Cache-Control "no-store" always;
'''


def sandbox_proxy(policy, env):
    if env.get("GEOSANDBOX_SERVER") != "1":
        return "# GeoSandbox server profile disabled.\n"
    if not env.get("GEOLIBRE_AUTH_USER") or not env.get("GEOLIBRE_AUTH_PASSWORD"):
        raise SystemExit("ERROR: GeoSandbox server requires GEOLIBRE_AUTH_USER and GEOLIBRE_AUTH_PASSWORD.")
    if env.get("GEOLIBRE_DISABLE_SIDECAR") == "1":
        raise SystemExit("ERROR: GeoSandbox server requires the Python sidecar.")
    capabilities = policy.get("capabilities")
    if capabilities is not None and not SANDBOX_CAPABILITIES <= set(capabilities):
        raise SystemExit("ERROR: GeoSandbox server requires project:edit, data:add, processing:run and export:data.")
    origin = env.get("GEOSANDBOX_PUBLIC_ORIGIN", "")
    try:
        parsed = urlsplit(origin)
        parsed.port
        loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        valid_origin = (
            parsed.hostname
            and not (parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment)
            and (parsed.scheme == "https" or (parsed.scheme == "http" and loopback))
            and origin == f"{parsed.scheme}://{parsed.netloc}"
            and all(c.isascii() and (c.isalnum() or c in "-.:[]/+") for c in origin)
        )
    except ValueError:
        valid_origin = False
    if not valid_origin:
        raise SystemExit("ERROR: GEOSANDBOX_PUBLIC_ORIGIN must be the HTTPS site origin, or HTTP loopback for a local smoke test.")
    writable_root = Path("/data").resolve()
    data_root = Path(env.get("GEOSANDBOX_DATA_DIR", "")).resolve()
    if not data_root.is_relative_to(writable_root) or data_root == writable_root:
        raise SystemExit("ERROR: GEOSANDBOX_DATA_DIR must be a dedicated subdirectory of /data.")
    routes = "location ^~ /sandbox-api/ {\n    client_max_body_size 300m;\n    proxy_pass http://127.0.0.1:8765/sandbox/;\n" + _PROXY + "}\n"
    if policy.get("ai", {}).get("enabled") is True:
        routes += "location = /ai/v1/chat/completions {\n    client_max_body_size 2m;\n    proxy_pass http://127.0.0.1:8765;\n" + _PROXY + "}\n"
    return routes


def main(argv):
    if len(argv) != 2:
        print("usage: sidecar_policy.py <deployment-policy-path>", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as source:
        policy = json.load(source)
    guards, off, start = generate_snippets(
        policy, disabled=os.environ.get("GEOLIBRE_DISABLE_SIDECAR") == "1"
    )
    directory = Path("/etc/nginx")
    (directory / "geolibre-sidecar-guards.conf").write_text(guards, encoding="utf-8")
    (directory / "geolibre-sidecar-off.conf").write_text(off, encoding="utf-8")
    sandbox = sandbox_proxy(policy, os.environ).replace("__GEOLIBRE_SIDECAR_TOKEN__", os.environ["GEOLIBRE_SIDECAR_TOKEN"])
    sandbox_conf = directory / "geolibre-sandbox-proxy.conf"
    sandbox_conf.write_text(sandbox, encoding="utf-8")
    sandbox_conf.chmod(0o640)
    print(f"SIDECAR_START={int(start)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
