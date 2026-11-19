import assert from "node:assert/strict";
import { afterEach, test, mock } from "node:test";
import { readFile } from "node:fs/promises";
import { measureModelInBackground } from "../apps/geolibre-desktop/src/lib/sandbox/measure-worker";
import { measureModel } from "../apps/geolibre-desktop/src/lib/sandbox/measure-geometry";

const originalWorker = globalThis.Worker;
let workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  buffer?: ArrayBuffer;
  terminated = 0;
  constructor() {
    workers.push(this);
  }
  postMessage(buffer: ArrayBuffer) {
    this.buffer = structuredClone(buffer, { transfer: [buffer] });
  }
  terminate() {
    this.terminated++;
  }
}
afterEach(() => {
  globalThis.Worker = originalWorker;
  workers = [];
  mock.timers.reset();
});
const fake = () => {
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
};

test("measurement transfers a copy, returns actual fixture dimensions and terminates its worker", async () => {
  fake();
  const bytes = await readFile(
    new URL(
      "../apps/geolibre-desktop/public/geosandbox/teaching-block.glb",
      import.meta.url
    )
  );
  const original = new Uint8Array(bytes);
  const pending = measureModelInBackground(bytes);
  const worker = workers[0];
  const measurement = await measureModel(new Uint8Array(worker.buffer!));
  worker.onmessage!({ data: { measurement } });
  assert.deepEqual((await pending).dimensions, [37, 12.5, 17]);
  assert.deepEqual(new Uint8Array(bytes), original);
  assert.equal(worker.terminated, 1);
});

test("Stop terminates computation and a queued late message cannot revive it", async () => {
  fake();
  const controller = new AbortController();
  const pending = measureModelInBackground(
    new Uint8Array([1, 2, 3]),
    controller.signal
  );
  const worker = workers[0];
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  worker.onmessage!({
    data: {
      measurement: { dimensions: [1, 1, 1], vertices: 1, basis: "glTF-metres" },
    },
  });
  assert.equal(worker.terminated, 1);
  await assert.rejects(
    measureModelInBackground(new Uint8Array(), controller.signal),
    { name: "AbortError" }
  );
  assert.equal(workers.length, 1);
});

test("worker failure and timeout release resources and reject instead of reporting dimensions", async () => {
  fake();
  mock.timers.enable({ apis: ["setTimeout"] });
  let pending = measureModelInBackground(new Uint8Array());
  workers[0].onerror!();
  await assert.rejects(pending, /Worker 失败/);
  pending = measureModelInBackground(new Uint8Array());
  mock.timers.tick(30001);
  await assert.rejects(pending, /30 秒/);
  assert.deepEqual(
    workers.map((worker) => worker.terminated),
    [1, 1]
  );
});
