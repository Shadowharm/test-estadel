import { HttpError } from "./errors.ts";
export async function readJson(request: Request): Promise<unknown> {
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity")
    throw new HttpError(415, "UNSUPPORTED_ENCODING");
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 65536))
    throw new HttpError(413, "BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_JSON");
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          total += value.byteLength;
          if (total > 65536) throw new HttpError(413, "BODY_TOO_LARGE");
          chunks.push(value);
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HttpError(400, "INVALID_JSON", "Истекло время чтения тела"),
            ),
          5000,
        );
      }),
    ]);
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new HttpError(400, "INVALID_JSON");
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
