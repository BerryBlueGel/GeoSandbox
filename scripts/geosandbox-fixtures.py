"""Small constructed GIS fixtures for independent GDAL round-trip checks."""
import json
from pathlib import Path
import zipfile

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.transform import from_bounds

root = Path(__file__).resolve().parents[1]
source = root / "apps/geolibre-desktop/public/geosandbox"
target = root / ".geosandbox/sample-data"
target.mkdir(parents=True, exist_ok=True)
frame = gpd.read_file(source / "footprints.geojson")
frame.to_crs("EPSG:3857").to_file(target / "buildings_3857.gpkg", layer="buildings", driver="GPKG")
shp_dir = target / "shapefile"
shp_dir.mkdir(exist_ok=True)
frame.to_file(shp_dir / "buildings.shp", driver="ESRI Shapefile", encoding="UTF-8")
with zipfile.ZipFile(target / "buildings_shp.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    for path in shp_dir.glob("buildings.*"):
        archive.write(path, path.name)
frame.set_crs(None, allow_override=True).to_file(target / "missing_crs.gpkg", layer="unknown", driver="GPKG")
height = width = 256
y, x = np.mgrid[:height, :width]
rgb = np.stack([(110+x//3).astype("uint8"), (155+y//4).astype("uint8"), np.full_like(x,120,dtype="uint8")])
with rasterio.open(target / "constructed_rgb.tif", "w", driver="GTiff", height=height, width=width, count=3, dtype="uint8", crs="EPSG:4326", transform=from_bounds(118.1389,39.63935,118.1411,39.64085,width,height), tiled=True, blockxsize=128, blockysize=128, compress="DEFLATE") as output:
    output.write(rgb)
    output.update_tags(source="Constructed test raster, not observed imagery")
print(json.dumps({"directory":str(target),"formats":["GPKG EPSG:3857","ZIP Shapefile","missing CRS GPKG","GeoTIFF RGB EPSG:4326"]}))
