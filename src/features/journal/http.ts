import type { ApiError } from "@/shared/events";

export class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public retryAfter?: string | null,
  ) {
    super(message);
  }
}
export async function requestJson<T>(
  url: string,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new RequestError(
      response.status,
      body?.error?.code ?? "HTTP_ERROR",
      body?.error?.message ?? "Не удалось выполнить запрос",
      body?.error?.request_id,
      response.headers.get("retry-after"),
    );
  }
  return response.json() as Promise<T>;
}
export function errorMessage(error: unknown) {
  if (error instanceof RequestError) {
    if (error.code === "INVALID_SEARCH")
      return "Нужны 1–10 слов или начал слов, не более 200 символов.";
    if (error.status === 429)
      return `Слишком много попыток. Повторите через ${error.retryAfter ?? "60"} с.`;
    return `${error.message}${error.requestId ? ` · Запрос ${error.requestId}` : ""}`;
  }
  return "Нет связи с сервером. Проверьте подключение и повторите.";
}
export const isStale = (error: unknown) =>
  error instanceof RequestError &&
  ["SNAPSHOT_STALE", "SNAPSHOT_AHEAD"].includes(error.code);
