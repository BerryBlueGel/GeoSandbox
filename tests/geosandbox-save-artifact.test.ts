import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { saveLocalArtifact } from "../apps/geolibre-desktop/src/lib/sandbox/save-artifact";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const bytes = new Uint8Array([1, 2, 3, 4]);

test("a lost save acknowledgement is recovered by a verified receipt without a second upload", async () => {
  let requestId = "",
    uploads = 0,
    reads = 0;
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (v) => v.toString(16).padStart(2, "0")
  ).join("");
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      uploads++;
      requestId = new Headers(init.headers).get("X-GeoSandbox-Export-Id")!;
      assert.match(requestId, /^[a-f0-9]{32}$/);
      throw new TypeError("Constructed lost acknowledgement after commit");
    }
    reads++;
    assert.equal(String(url), `/sandbox-api/export-receipts/${requestId}`);
    return Response.json({
      requestId,
      bytes: bytes.length,
      sha256,
      path: "D:/constructed/result.geosandbox",
      downloadUrl: `/sandbox-api/exports/${requestId}_result.geosandbox`,
    });
  };
  const saved = await saveLocalArtifact(
    bytes,
    "result.geosandbox",
    "application/zip"
  );
  assert.equal(saved.requestId, requestId);
  assert.equal(uploads, 1);
  assert.equal(reads, 1);
});

test("a mismatched receipt cannot turn an uncertain save into success", async () => {
  let uploads = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") {
      uploads++;
      throw new TypeError("unavailable");
    }
    return Response.json({
      requestId: "incorrect",
      bytes: bytes.length,
      sha256: "invalid",
      path: "D:/wrong",
      downloadUrl: "/sandbox-api/exports/wrong",
    });
  };
  await assert.rejects(
    saveLocalArtifact(bytes, "result.geosandbox", "application/zip"),
    /保存状态未确认.*文件可能已经写入/
  );
  assert.equal(uploads, 1);
});

test("a definite disk failure stays a failure after receipt checks", async () => {
  globalThis.fetch = async (_url, init) =>
    init?.method === "POST"
      ? Response.json({ detail: "构造磁盘不可写" }, { status: 507 })
      : Response.json({}, { status: 404 });
  await assert.rejects(
    saveLocalArtifact(bytes, "result.geosandbox", "application/zip"),
    /构造磁盘不可写/
  );
});
