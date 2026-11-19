import { useState } from "react";
import type { GeoLibreLayer } from "@geolibre/core";
import { Button, Label } from "@geolibre/ui";
import {
  DELIVERY_FORMATS,
  prepareVectorDelivery,
  type DeliveryFormat,
  type VectorDelivery,
} from "../../lib/sandbox/vector-delivery";

export function VectorDeliveryPanel({
  layers,
  busy,
  execute,
  onExport,
}: {
  layers: GeoLibreLayer[];
  busy: boolean;
  execute: (action: () => void) => Promise<boolean>;
  onExport: (plan: VectorDelivery) => Promise<boolean>;
}) {
  const [id, setId] = useState("");
  const [format, setFormat] = useState<DeliveryFormat>("geojson");
  const [review, setReview] = useState<VectorDelivery | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const layer = layers.find((item) => item.id === id);
  const stale = review !== null && layer !== review.layer;
  function clearReview() {
    setReview(null);
    setConfirmed(false);
  }

  return (
    <section className="space-y-3 border-t pt-4" aria-label="矢量成果导出">
      <h3 className="text-sm font-semibold">矢量成果导出</h3>
      <Label htmlFor="gs-export-vector-layer">导出图层</Label>
      <select
        id="gs-export-vector-layer"
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        value={layer?.id ?? ""}
        onChange={(e) => {
          setId(e.target.value);
          clearReview();
        }}
      >
        <option value="">请选择含要素的矢量图层</option>
        {layers.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <Label htmlFor="gs-export-vector-format">输出格式</Label>
      <select
        id="gs-export-vector-format"
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        value={format}
        onChange={(e) => {
          setFormat(e.target.value as DeliveryFormat);
          clearReview();
        }}
      >
        {Object.entries(DELIVERY_FORMATS).map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
      <Button
        className="w-full"
        variant="outline"
        disabled={busy || !layer}
        onClick={() =>
          void execute(() => {
            clearReview();
            if (layer) setReview(prepareVectorDelivery(layer, format));
          })
        }
      >
        检查导出内容
      </Button>
      {review && (
        <div
          aria-label="矢量导出检查"
          role="region"
          className="space-y-2 rounded-md border bg-muted/40 p-3"
        >
          {stale ? (
            <p className="text-xs text-destructive">
              图层内容已变化，请重新检查。
            </p>
          ) : (
            <>
              <p className="text-xs leading-relaxed">
                {DELIVERY_FORMATS[review.format]} · WGS84（经度、纬度） ·{" "}
                {review.data.features.length} 个要素 · {review.fieldCount}{" "}
                个字段
              </p>
              <p className="text-xs text-muted-foreground">
                仅交付要素及可导出的属性。样式、图层关系和影像原件可随项目包交付。
              </p>
              {review.warnings.length > 0 && (
                <>
                  <ul className="max-h-36 list-disc space-y-1 overflow-auto break-words ps-4 text-xs">
                    {review.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      className="mt-0.5"
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    已核对格式差异
                  </label>
                </>
              )}
              <Button
                className="w-full"
                disabled={busy || (review.warnings.length > 0 && !confirmed)}
                onClick={() => void onExport(review)}
              >
                导出矢量成果
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
