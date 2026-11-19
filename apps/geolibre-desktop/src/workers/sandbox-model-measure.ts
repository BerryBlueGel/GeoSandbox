import { measureModel } from "../lib/sandbox/measure-geometry";

self.onmessage = async ({ data }: MessageEvent<ArrayBuffer>) => {
  try {
    self.postMessage({ measurement: await measureModel(new Uint8Array(data)) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "模型测量失败。",
    });
  }
};
