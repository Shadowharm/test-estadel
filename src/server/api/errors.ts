export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
    public fields?: { path: string; code: string; message: string }[],
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}
export function invalidQuery(): never {
  throw new HttpError(400, "INVALID_QUERY", "Проверьте параметры запроса");
}
