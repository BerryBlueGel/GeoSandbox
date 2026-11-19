import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptyProject,
  detachProjectCopy,
  parseProject,
  projectFromStore,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
import {
  createRecoveryController,
  saveRecoveryPoint,
  type RecoveryPoint,
  type RecoveryStatus,
} from "../apps/geolibre-desktop/src/lib/sandbox/recovery";

const point = (name: string): RecoveryPoint => ({
  id: name,
  name,
  createdAt: new Date().toISOString(),
  assetCount: 1,
  layerCount: 1,
  downloadUrl: "/point",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("project identity is distinct for same names and survives rename, snapshots and open", () => {
  const store = useAppStore.getState();
  store.newProject({ name: "Same name" });
  const first = projectFromStore(useAppStore.getState());
  store.newProject({ name: "Same name" });
  const second = projectFromStore(useAppStore.getState());
  assert.notEqual(first.id, second.id);
  store.setProjectName("Renamed");
  assert.equal(projectFromStore(useAppStore.getState()).id, second.id);
  store.loadProject(parseProject(serializeProject(first)));
  assert.equal(useAppStore.getState().projectId, first.id);
  const copy = detachProjectCopy(first);
  store.loadProject(copy);
  assert.equal(useAppStore.getState().projectId, copy.id);
  assert.notEqual(copy.id, first.id);
  const legacy = createEmptyProject("Old format");
  assert.equal(parseProject(serializeProject(legacy)).id, undefined);
  store.loadProject(legacy);
  const upgraded = projectFromStore(useAppStore.getState());
  assert.ok(upgraded.id);
  store.loadProject(parseProject(serializeProject(upgraded)));
  assert.equal(useAppStore.getState().projectId, upgraded.id);
  store.newProject();
});

test("checkpoint requests serialize and coalesce to the latest snapshot without modifying the project", async () => {
  const first = deferred<RecoveryPoint>();
  let project = createEmptyProject("before"),
    count = 0;
  const seen: string[] = [],
    states: RecoveryStatus[] = [];
  const writer = createRecoveryController({
    snapshot: () => project,
    status: (s) => states.push(s),
    save: async (p) => {
      seen.push(p.name);
      count++;
      return count === 1 ? first.promise : point(p.name);
    },
  });
  const one = writer.flush();
  project = createEmptyProject("latest");
  const two = writer.flush();
  first.resolve(point("before"));
  await Promise.all([one, two]);
  assert.deepEqual(seen, ["before", "latest"]);
  assert.equal(states.at(-1)?.point?.name, "latest");
  assert.equal(project.name, "latest");
  writer.dispose();
});

test("project switch aborts old work and does not expose old success in the new project", async () => {
  const first = deferred<RecoveryPoint>();
  let project = createEmptyProject("old"),
    signal: AbortSignal | undefined;
  const states: RecoveryStatus[] = [];
  const writer = createRecoveryController({
    snapshot: () => project,
    status: (s) => states.push(s),
    save: async (p, s) => {
      if (p.name === "old") {
        signal = s;
        return first.promise;
      }
      return point(p.name);
    },
  });
  const old = writer.flush();
  writer.reset();
  project = createEmptyProject("new");
  const latest = writer.flush();
  first.resolve(point("old"));
  await Promise.all([old, latest]);
  assert.equal(signal?.aborted, true);
  assert.ok(!states.some((s) => s.point?.name === "old"));
  assert.equal(states.at(-1)?.point?.name, "new");
  writer.dispose();
});

test("failure remains visible, can be retried, and disposal cannot publish late status", async () => {
  let fail = true;
  const states: RecoveryStatus[] = [];
  const late = deferred<RecoveryPoint>();
  const writer = createRecoveryController({
    snapshot: () => createEmptyProject("test"),
    status: (s) => states.push(s),
    save: async () => {
      if (fail) throw new Error("storage full");
      return late.promise;
    },
  });
  await assert.rejects(writer.flush(), /storage full/);
  assert.equal(states.at(-1)?.phase, "error");
  fail = false;
  const pending = writer.flush();
  writer.dispose();
  const length = states.length;
  late.resolve(point("late"));
  await pending;
  assert.equal(states.length, length);
});

test("incremental recovery uses the portable manifest, deduplicates upload and redacts project credentials", async (t) => {
  const project = createEmptyProject("saved");
  useAppStore.setState({ isDirty: true });
  project.metadata = { resource: "data:application/octet-stream;base64,AQID" };
  project.preferences = {
    ...project.preferences,
    environmentVariables: [
      {
        key: "PRIVATE_TOKEN",
        value: "never-persist-this",
        enabled: true,
        secret: true,
      },
    ],
  } as typeof project.preferences;
  const originalFetch = globalThis.fetch;
  const uploaded = new Set<string>();
  let transfers = 0;
  const commits: unknown[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("data:")) return originalFetch(input, init);
      if (url.endsWith("missing-assets")) {
        const hashes = JSON.parse(String(init?.body)).hashes as string[];
        return Response.json({
          missing: hashes.filter((h) => !uploaded.has(h)),
        });
      }
      if (url.includes("/assets/")) {
        transfers++;
        uploaded.add(url.split("/").at(-1)!);
        return Response.json({ stored: true });
      }
      const body = JSON.parse(String(init?.body));
      commits.push(body);
      return Response.json(point("saved"));
    }
  );
  const cache = new Map();
  await saveRecoveryPoint(project, new AbortController().signal, cache);
  await saveRecoveryPoint(project, new AbortController().signal, cache);
  assert.equal(transfers, 1);
  assert.equal(commits.length, 2);
  assert.match(JSON.stringify(commits[0]), /geosandbox-asset:assets/);
  assert.ok(!JSON.stringify(commits[0]).includes("never-persist-this"));
  assert.equal(
    project.metadata.resource,
    "data:application/octet-stream;base64,AQID"
  );
  assert.equal(useAppStore.getState().isDirty, true);
});

test("continuous editing still checkpoints at maximum wait instead of deferring forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const writer = createRecoveryController({
    snapshot: () => createEmptyProject("continuous"),
    status: () => {},
    delay: 10,
    maxWait: 30,
    save: async () => {
      calls++;
      return point("continuous");
    },
  });
  writer.schedule();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(9);
    writer.schedule();
  }
  assert.equal(calls, 0);
  t.mock.timers.tick(3);
  await Promise.resolve();
  assert.equal(calls, 1);
  writer.dispose();
});
