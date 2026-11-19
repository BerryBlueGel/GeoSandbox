import type { BundleInput } from "./bundle";

export function savedBundleInput(
  name: string,
  downloadUrl: string
): BundleInput {
  return {
    name,
    arrayBuffer: async (signal) => {
      const timeout = AbortSignal.timeout(30000);
      const response = await fetch(downloadUrl, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok)
        throw new Error("项目包已移动、删除或无法读取，请刷新列表。");
      return response.arrayBuffer();
    },
  };
}
