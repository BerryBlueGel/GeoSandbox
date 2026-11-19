import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  useAppStore,
  DEFAULT_LAYER_STYLE,
  projectFromStore,
  parseProject,
  serializeProject,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  createSandboxTasks,
  type SandboxTaskContext,
  type SandboxTaskState,
} from "../apps/geolibre-desktop/src/lib/sandbox/tasks";

beforeEach(() => useAppStore.getState().newProject());
const options = { id: "constructed-task", label: "构造验收任务" };

test("native cancellation remains busy until the process-stop receipt arrives", async () => {
  const phases: SandboxTaskState[] = [];
  const tasks = createSandboxTasks((state) => phases.push(state));
  const entered = gate(),
    stopped = gate();
  const pending = tasks.run(options, async (task) => {
    task.onCancel(() => stopped.promise);
    entered.resolve();
    await new Promise(() => {});
  });
  await entered.promise;
  tasks.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(phases.at(-1)?.phase, "cancelling");
  assert.equal(tasks.running, true);
  assert.equal(
    await tasks.run(options, () => assert.fail("must stay busy")),
    false
  );
  stopped.resolve();
  assert.equal(await pending, false);
  assert.equal(phases.at(-1)?.phase, "cancelled");
  assert.equal(tasks.running, false);
});

test("a missing process-stop receipt is an error, never a confirmed cancellation", async () => {
  const phases: SandboxTaskState[] = [];
  const tasks = createSandboxTasks((state) => phases.push(state));
  const entered = gate();
  const pending = tasks.run(options, async (task) => {
    task.onCancel(async () => {
      throw new Error("constructed offline");
    });
    entered.resolve();
    await new Promise(() => {});
  });
  await entered.promise;
  tasks.cancel();
  await pending;
  assert.equal(phases.at(-1)?.phase, "error");
  assert.match(phases.at(-1)?.stage ?? "", /停止未确认/);
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function input(): GeoLibreLayer {
  const layer = {
    id: "input",
    name: "Constructed",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson" },
    style: DEFAULT_LAYER_STYLE,
    metadata: {},
  } as GeoLibreLayer;
  useAppStore.setState({ layers: [layer] });
  return layer;
}

test("task phases and one guarded commit use the existing persistent processing history", async () => {
  const layer = input();
  const phases: SandboxTaskState[] = [];
  const tasks = createSandboxTasks((state) => phases.push(state));
  let savedContext: SandboxTaskContext | undefined;
  assert.equal(
    await tasks.run(
      { ...options, inputs: [layer], parameters: { layer: layer.id } },
      async (task) => {
        savedContext = task;
        await task.stage("构造计算阶段");
        task.commit(() =>
          useAppStore.getState().updateLayer(layer.id, { name: "Result" })
        );
      }
    ),
    true
  );
  assert.equal(phases[0].phase, "queued");
  assert.ok(phases.some((state) => state.stage === "构造计算阶段"));
  assert.equal(phases.at(-1)?.phase, "success");
  assert.equal(useAppStore.getState().layers[0].name, "Result");
  const history = useAppStore.getState().processingHistory;
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, "sandbox");
  assert.equal(history[0].status, "success");
  assert.equal(history[0].inputLayerNames?.input, "Constructed");
  const restored = parseProject(
    serializeProject(projectFromStore(useAppStore.getState()))
  );
  assert.equal(restored.processingHistory?.[0].kind, "sandbox");
  assert.throws(
    () =>
      savedContext!.commit(() =>
        assert.fail("completed context must be stale")
      ),
    /Abort|项目已切换/
  );
  tasks.dispose();
});

test("cancel frees the UI immediately and late results cannot overwrite the next task", async () => {
  const layer = input(),
    entered = gate(),
    pending = gate();
  const states: SandboxTaskState[] = [];
  const tasks = createSandboxTasks((state) => states.push(state));
  const running = tasks.run({ ...options, inputs: [layer] }, async (task) => {
    entered.resolve();
    await pending.promise;
    task.commit(() =>
      useAppStore.getState().updateLayer(layer.id, { name: "LATE" })
    );
  });
  await entered.promise;
  assert.equal(
    await tasks.run(options, () =>
      assert.fail("parallel task must be refused")
    ),
    false
  );
  tasks.cancel();
  assert.equal(await running, false);
  assert.equal(tasks.running, false);
  assert.equal(states.at(-1)?.phase, "cancelled");
  assert.equal(useAppStore.getState().layers[0], layer);
  assert.equal(
    await tasks.run({ ...options, label: "Next" }, (task) =>
      task.commit(() => {})
    ),
    true
  );
  pending.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1)?.label, "Next");
  assert.equal(useAppStore.getState().layers[0], layer);
  assert.deepEqual(
    useAppStore.getState().processingHistory.map((run) => run.status),
    ["cancelled", "success"]
  );
  const restored = parseProject(
    serializeProject(projectFromStore(useAppStore.getState()))
  );
  assert.equal(restored.processingHistory?.[0].status, "cancelled");
  tasks.dispose();
});

for (const change of ["project", "input", "dispose"] as const) {
  test(`${change} invalidation cancels unfinished work and never pollutes a replacement project`, async () => {
    const layer = input(),
      entered = gate(),
      pending = gate();
    let events = 0;
    const tasks = createSandboxTasks(() => events++);
    const running = tasks.run({ ...options, inputs: [layer] }, async (task) => {
      entered.resolve();
      await pending.promise;
      task.commit(() => assert.fail("stale result cannot commit"));
    });
    await entered.promise;
    if (change === "project") useAppStore.getState().newProject();
    if (change === "input")
      useAppStore.getState().updateLayer(layer.id, { name: "User edit" });
    if (change === "dispose") tasks.dispose();
    assert.equal(await running, false);
    const eventsBefore = events;
    pending.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events, eventsBefore);
    if (change === "project") {
      assert.equal(useAppStore.getState().processingHistory.length, 0);
      assert.equal(useAppStore.getState().layers.length, 0);
    } else
      assert.equal(
        useAppStore.getState().processingHistory[0].status,
        "cancelled"
      );
    if (change === "input")
      assert.equal(useAppStore.getState().layers[0].name, "User edit");
    tasks.dispose();
  });
}

test("task error and timeout are failures rather than successful empty results", async () => {
  const tasks = createSandboxTasks(() => {});
  assert.equal(
    await tasks.run(options, () => {
      throw new Error("Constructed calculation error");
    }),
    false
  );
  assert.equal(
    await tasks.run({ ...options, timeoutMs: 20 }, () => new Promise(() => {})),
    false
  );
  const history = useAppStore.getState().processingHistory;
  assert.deepEqual(
    history.map((run) => run.status),
    ["error", "error"]
  );
  assert.match(history[1].error!, /超时/);
  tasks.dispose();
});

test("file writing closes cancellation and file tasks do not dirty the saved project through history", async () => {
  const entered = gate(),
    pending = gate();
  const states: SandboxTaskState[] = [];
  const tasks = createSandboxTasks((state) => states.push(state));
  let context: SandboxTaskContext | undefined;
  const running = tasks.run({ ...options, record: false }, async (task) => {
    context = task;
    const receipt = await task.persist("写盘与核对回执", async () => {
      entered.resolve();
      await pending.promise;
      return "verified receipt";
    });
    assert.equal(receipt, "verified receipt");
    task.commit(() => useAppStore.getState().markSaved());
  });
  await entered.promise;
  assert.equal(states.at(-1)?.phase, "writing");
  tasks.cancel();
  assert.equal(context!.signal.aborted, false);
  assert.equal(tasks.running, true);
  pending.resolve();
  assert.equal(await running, true);
  assert.equal(useAppStore.getState().processingHistory.length, 0);
  assert.equal(useAppStore.getState().isDirty, false);
  tasks.dispose();
});

test("a project switch during irreversible writing is never misreported as cancellation or marked saved", async () => {
  const entered = gate(),
    pending = gate();
  const states: SandboxTaskState[] = [];
  const tasks = createSandboxTasks((state) => states.push(state));
  const running = tasks.run({ ...options, record: false }, async (task) => {
    await task.persist("写入", async () => {
      entered.resolve();
      await pending.promise;
    });
    task.commit(() => assert.fail("must not write to replacement project"));
  });
  await entered.promise;
  useAppStore.getState().newProject();
  useAppStore.getState().setProjectName("New user edits");
  pending.resolve();
  assert.equal(await running, false);
  assert.equal(states.at(-1)?.phase, "error");
  assert.match(states.at(-1)?.error ?? "", /磁盘操作已开始/);
  assert.equal(useAppStore.getState().projectName, "New user edits");
  assert.equal(useAppStore.getState().isDirty, true);
  assert.equal(useAppStore.getState().processingHistory.length, 0);
  tasks.dispose();
});

test("opening a project cannot overwrite edits made while it was being read", async () => {
  const entered = gate(),
    pending = gate();
  const tasks = createSandboxTasks(() => {});
  const running = tasks.run(
    { ...options, record: false, replaceProject: true },
    async (task) => {
      entered.resolve();
      await pending.promise;
      task.commit(() => assert.fail("must preserve concurrent edit"));
    }
  );
  await entered.promise;
  useAppStore.getState().setProjectName("Edit during open");
  assert.equal(await running, false);
  pending.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useAppStore.getState().projectName, "Edit during open");
  assert.equal(useAppStore.getState().processingHistory.length, 0);
  tasks.dispose();
});

test("an intentional guarded project replacement finishes successfully and remains clean", async () => {
  const project = projectFromStore(useAppStore.getState());
  const tasks = createSandboxTasks(() => {});
  assert.equal(
    await tasks.run(
      { ...options, record: false, replaceProject: true },
      (task) => {
        task.commit(() => useAppStore.getState().loadProject(project, null));
      }
    ),
    true
  );
  assert.equal(useAppStore.getState().isDirty, false);
  assert.equal(useAppStore.getState().processingHistory.length, 0);
  tasks.dispose();
});

test("post-commit restore notifications cannot misreport an applied project as cancelled", async () => {
  const project = projectFromStore(useAppStore.getState());
  const states: SandboxTaskState[] = [];
  const tasks = createSandboxTasks((state) => states.push(state));
  assert.equal(
    await tasks.run(
      { ...options, record: false, replaceProject: true },
      async (task) => {
        task.commit(() => useAppStore.getState().loadProject(project, null));
        // A renderer restore effect can update the loaded store before the task settles.
        await Promise.resolve();
        useAppStore.getState().markSaved();
      }
    ),
    true
  );
  assert.equal(states.at(-1)?.phase, "success");
  assert.equal(useAppStore.getState().isDirty, false);
  tasks.dispose();
});
