import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  executeStorageCleanup,
  type CleanupPlan,
} from "../apps/geolibre-desktop/src/lib/sandbox/storage";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
const plan = { fingerprint: "a".repeat(64) } as CleanupPlan;
const id = "b".repeat(32);
const selection = { checkpointIds: [], orphanedFiles: true };
const receipt = {
  id,
  fingerprint: plan.fingerprint,
  status: "completed",
  removedBytes: 100,
  removedFiles: 2,
  message: "constructed cleanup",
};

test("lost cleanup acknowledgment recovers the same receipt with one POST", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/cleanup/"))
      throw new TypeError("constructed lost response");
    return Response.json(receipt);
  };
  assert.deepEqual(await executeStorageCleanup(id, selection, plan), receipt);
  assert.deepEqual(calls, [
    `/sandbox-api/storage/cleanup/${id}`,
    `/sandbox-api/storage/receipts/${id}`,
  ]);
});

test("stale preview validation stays explicit and never retries cleanup", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ detail: "请重新预览" }, { status: 409 });
  };
  await assert.rejects(executeStorageCleanup(id, selection, plan), /重新预览/);
  assert.equal(calls, 1);
});

test("unknown cleanup outcome includes its receipt ID instead of claiming zero deletion", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("constructed offline");
  };
  await assert.rejects(
    executeStorageCleanup(id, selection, plan),
    new RegExp(`状态未确认.*${id}`)
  );
});

test("partial and interrupted receipts remain distinguishable from completion", async () => {
  for (const status of ["partial", "interrupted"]) {
    globalThis.fetch = async () =>
      Response.json({
        ...receipt,
        status,
        removedBytes: status === "interrupted" ? null : 30,
      });
    assert.equal(
      (await executeStorageCleanup(id, selection, plan)).status,
      status
    );
  }
});

test("mismatched receipt can never confirm a different cleanup plan", async () => {
  globalThis.fetch = async () =>
    Response.json({ ...receipt, fingerprint: "c".repeat(64) });
  await assert.rejects(executeStorageCleanup(id, selection, plan), /无法匹配/);
});
