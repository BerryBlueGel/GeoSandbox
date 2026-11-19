import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  useAppStore,
  mockFetch,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { unzipSync, strFromU8 } from "fflate";
import { Blob as DomBlob } from "happy-dom";
const { SandboxPanel } = await import(
  "../apps/geolibre-desktop/src/components/sandbox/SandboxPanel"
);

test("actual project-save UI preserves edits during writing and leaves an unchanged saved project clean", async (t) => {
  // FormData belongs to happy-dom in this harness; its Blob must use the same realm.
  const originalBlob = globalThis.Blob;
  globalThis.Blob = DomBlob as unknown as typeof Blob;
  t.after(() => {
    globalThis.Blob = originalBlob;
  });
  useAppStore.getState().setProjectName("Captured snapshot");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const savedNames: string[] = [];
  let decodingError = "";
  let uploads = 0;
  mockFetch(async (url, init) => {
    if (String(url).endsWith("/exports") && init?.method === "POST") {
      uploads++;
      try {
        const file = (init.body as FormData).get("file") as Blob;
        const bytes = new Uint8Array(await file.arrayBuffer());
        assert.equal(
          bytes[0],
          80,
          `uploaded size ${bytes.length}; prefix ${Array.from(
            bytes.slice(0, 20)
          ).join(",")}`
        );
        const project = JSON.parse(strFromU8(unzipSync(bytes)["project.json"]));
        savedNames.push(project.name);
        const sha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (v) => v.toString(16).padStart(2, "0")
        ).join("");
        const requestId = new Headers(init.headers).get(
          "X-GeoSandbox-Export-Id"
        )!;
        if (uploads === 1) await pending;
        return Response.json({
          requestId,
          bytes: bytes.length,
          sha256,
          path: "D:/constructed/saved.geosandbox",
          downloadUrl: `/sandbox-api/exports/${requestId}_saved.geosandbox`,
        });
      } catch (error) {
        decodingError = String(error);
        throw error;
      }
    }
    if (String(url).endsWith("/status"))
      return Response.json({ configured: false, model: "constructed" });
    if (String(url).endsWith("/projects"))
      return Response.json({ projects: [], directory: "D:/constructed" });
    if (String(url).endsWith("/checkpoints"))
      return Response.json({
        checkpoints: [],
        directory: "D:/constructed",
        bytes: 0,
      });
    return Response.json({}, { status: 404 });
  });
  render(
    createElement(SandboxPanel, {
      open: true,
      onOpen: () => {},
      onClose: () => {},
      onOpenHistory: () => {},
      mapControllerRef: { current: null },
    })
  );
  fireEvent.click(screen.getByRole("tab", { name: "交付" }));
  fireEvent.click(screen.getByRole("button", { name: "保存项目包" }));
  await waitFor(() =>
    assert.equal(
      uploads,
      1,
      screen.queryByRole("alert")?.textContent ??
        screen.getByLabelText("空间装配面板").textContent?.slice(0, 300)
    )
  );
  assert.equal(screen.queryByRole("button", { name: "取消当前任务" }), null);
  await act(async () => {
    useAppStore.getState().setProjectName("Edits during write");
    release();
  });
  await waitFor(() =>
    assert.equal(
      screen
        .getByRole("button", { name: "保存项目包" })
        .hasAttribute("disabled"),
      false
    )
  );
  assert.equal(useAppStore.getState().isDirty, true);
  assert.equal(useAppStore.getState().processingHistory.length, 0);
  assert.equal(savedNames[0], "Captured snapshot", decodingError);
  fireEvent.click(screen.getByRole("button", { name: "保存项目包" }));
  await waitFor(() => assert.equal(uploads, 2));
  await waitFor(() => assert.equal(useAppStore.getState().isDirty, false));
  assert.equal(savedNames[1], "Edits during write");
  assert.equal(useAppStore.getState().processingHistory.length, 0);
});
