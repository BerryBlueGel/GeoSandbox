export interface SavedArtifact {
  requestId: string;
  path: string;
  downloadUrl: string;
  bytes: number;
  sha256: string;
}

export async function saveLocalArtifact(
  bytes: Uint8Array,
  name: string,
  mime: string
): Promise<SavedArtifact> {
  const requestId = crypto.randomUUID().replaceAll("-", "");
  const sha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
    ),
    (value) => value.toString(16).padStart(2, "0")
  ).join("");
  const valid = (result: SavedArtifact) =>
    result?.requestId === requestId &&
    result.bytes === bytes.length &&
    result.sha256 === sha256 &&
    typeof result.path === "string" &&
    result.downloadUrl?.startsWith(`/sandbox-api/exports/${requestId}_`);
  const data = new FormData();
  data.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
  let definiteError: string | undefined;
  try {
    const response = await fetch("/sandbox-api/exports", {
      method: "POST",
      body: data,
      headers: { "X-GeoSandbox-Export-Id": requestId },
      signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (response.ok && valid(result)) return result;
    if (
      (response.status >= 400 && response.status < 500) ||
      response.status === 507
    )
      definiteError =
        typeof result.detail === "string"
          ? result.detail
          : `保存请求被拒绝（${response.status}）。`;
  } catch {
    /* The commit may already exist; recover its receipt before reporting a failure. */
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt)
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    try {
      const response = await fetch(
        `/sandbox-api/export-receipts/${requestId}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (response.ok) {
        const receipt = await response.json();
        if (valid(receipt)) return receipt;
      }
    } catch {
      /* Keep this bounded; do not upload a second copy on an uncertain acknowledgement. */
    }
  }
  throw new Error(
    definiteError ??
      `保存状态未确认，文件可能已经写入；请刷新 D 盘成果列表核对。保存编号：${requestId}`
  );
}
