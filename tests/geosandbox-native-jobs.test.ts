import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  cancelNativeJob,
  importNativeGis,
} from "../apps/geolibre-desktop/src/lib/sandbox/native-jobs";
import { createSandboxTasks } from "../apps/geolibre-desktop/src/lib/sandbox/tasks";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
const result = {
  layers: [
    {
      name: "constructed",
      geojson: { type: "FeatureCollection", features: [] },
    },
  ],
};
const options = {
  id: "constructed-native",
  label: "构造原生导入",
  record: false,
};

test("lost submit acknowledgment recovers by the same ID without a second submission", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input),
      method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "POST")
      throw new TypeError("constructed lost acknowledgment");
    return Response.json(
      url.endsWith("/result")
        ? result
        : { status: "succeeded", stage: "done", processStopped: true }
    );
  };
  let applied = false;
  const runner = createSandboxTasks(() => {});
  assert.equal(
    await runner.run(options, async (task) => {
      assert.deepEqual(
        await importNativeGis(new FormData(), "vector", task),
        result
      );
      task.commit(() => {
        applied = true;
      });
    }),
    true
  );
  assert.equal(applied, true);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls[1].url, calls[0].url);
  assert.equal(calls[2].url, calls[0].url + "/result");
});

test("cancel helper requires explicit process-stop confirmation", async () => {
  globalThis.fetch = async () =>
    Response.json({ status: "interrupted", processStopped: null });
  await assert.rejects(cancelNativeJob("constructed"), /停止尚未确认/);
  globalThis.fetch = async () =>
    Response.json({ status: "cancelled", processStopped: true });
  await cancelNativeJob("constructed");
});

test("lost cancellation acknowledgment is verified through the durable job receipt", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/cancel"))
      throw new TypeError("constructed lost stop response");
    return Response.json({ status: "cancelled", processStopped: true });
  };
  await cancelNativeJob("constructed");
  assert.deepEqual(calls, [
    "/sandbox-api/native-jobs/constructed/cancel",
    "/sandbox-api/native-jobs/constructed",
  ]);
});

test("cancelling while submit is pending stops the known job and never requests its result", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/cancel"))
      return Response.json({ status: "cancelled", processStopped: true });
    entered();
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true }
      )
    );
  };
  const phases: string[] = [];
  const runner = createSandboxTasks((state) => phases.push(state.phase));
  const pending = runner.run(options, async (task) => {
    await importNativeGis(new FormData(), "vector", task);
    task.commit(() => assert.fail("late import must not apply"));
  });
  await ready;
  runner.cancel();
  assert.equal(await pending, false);
  assert.deepEqual(calls, [calls[0], calls[0] + "/cancel"]);
  assert.ok(phases.includes("cancelling"));
  assert.equal(phases.at(-1), "cancelled");
});
