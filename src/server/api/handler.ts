import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppDatabase } from "../db/connection.ts";
import { DatabaseNotReadyError } from "../db/errors.ts";
import { signingSecret } from "./tokens.ts";
import { insertEvent, EventConflictError } from "../events/store.ts";
import { InvalidSearchError } from "../events/search.ts";
import { textField } from "../events/normalize.ts";
import { eventSlug } from "../../shared/events.ts";
import { HttpError } from "./errors.ts";
import { readJson } from "./body.ts";
import { Tokens, decodeBase64 } from "./tokens.ts";
import {
  listEvents,
  detailEvent,
  overview,
  facets,
  eventDto,
} from "./read-models.ts";
import { RateLimiter } from "./rate-limit.ts";
import { EventStreams, type StreamOptions } from "./stream.ts";
import { EventExports } from "./export.ts";

export function decodeEventId(slug: string) {
  try {
    if (!slug.startsWith("~") || slug.length > 540) throw new Error("slug");
    const id = new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64(slug.slice(1)),
    );
    const parsed = textField(100).safeParse(id);
    if (!parsed.success || parsed.data !== id || eventSlug(id) !== slug)
      throw new Error("id");
    return id;
  } catch {
    throw new HttpError(400, "INVALID_EVENT_ID");
  }
}
function safeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof EventConflictError)
    return new HttpError(409, "EVENT_ID_CONFLICT");
  if (error instanceof InvalidSearchError)
    return new HttpError(400, "INVALID_SEARCH");
  if (error instanceof z.ZodError)
    return new HttpError(
      400,
      "VALIDATION_ERROR",
      "Проверьте поля запроса",
      error.issues.map((issue) => ({
        path: issue.path.length
          ? "/" +
            issue.path
              .map((v) => String(v).replaceAll("~", "~0").replaceAll("/", "~1"))
              .join("/")
          : "",
        code:
          issue.code === "invalid_type" && issue.message.includes("undefined")
            ? "required"
            : issue.code,
        message: "Недопустимое или отсутствующее значение",
      })),
    );
  let underlying = error;
  for (let i = 0; i < 5 && underlying instanceof Error; i++) {
    const code = "code" in underlying ? String(underlying.code) : "";
    if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
      return new HttpError(503, "DB_BUSY", "Хранилище занято", undefined, {
        "Retry-After": "1",
      });
    if (
      [
        "SQLITE_FULL",
        "SQLITE_READONLY",
        "SQLITE_CANTOPEN",
        "SQLITE_IOERR",
        "SQLITE_CORRUPT",
        "SQLITE_NOTADB",
      ].some((prefix) => code.startsWith(prefix))
    )
      return new HttpError(
        503,
        "STORAGE_UNAVAILABLE",
        "Хранилище недоступно",
        undefined,
        { "Retry-After": "1" },
      );
    if (underlying.message.includes("events_seq_safe"))
      return new HttpError(503, "SEQUENCE_EXHAUSTED");
    underlying = underlying.cause;
  }
  if (error instanceof DatabaseNotReadyError)
    return new HttpError(503, "NOT_READY", "Хранилище не готово", undefined, {
      "Retry-After": "1",
    });
  return new HttpError(500, "INTERNAL_ERROR", "Не удалось выполнить запрос");
}
export function createApi(deps: {
  database: () => AppDatabase;
  log?: boolean;
  limiter?: RateLimiter;
  streamOptions?: () => StreamOptions;
}) {
  const limiter = deps.limiter ?? new RateLimiter();
  const streams = new EventStreams(deps.database, deps.streamOptions);
  const exports = new EventExports();
  let tokens: Tokens | undefined;
  function services() {
    const db = deps.database();
    if (!tokens) {
      const secret = signingSecret(db);
      tokens = new Tokens(secret);
    }
    return { db, tokens };
  }
  return async function handle(request: Request): Promise<Response> {
    const id = randomUUID(),
      started = performance.now();
    let response: Response,
      template = "/api/*",
      errorCode: string | undefined;
    try {
      const url = new URL(request.url),
        path = url.pathname;
      const read = ["/api/events", "/api/overview", "/api/facets"].includes(
        path,
      );
      const stream = path === "/api/events/stream";
      const exporting = path === "/api/events/export";
      const detail =
        /^\/api\/events\/[^/]+$/.test(path) &&
        !["/api/events/stream", "/api/events/export"].includes(path);
      if (!read && !detail && !stream && !exporting)
        throw new HttpError(404, "NOT_FOUND");
      template = detail ? "/api/events/{id}" : path;
      const allowed = path === "/api/events" ? ["GET", "POST"] : ["GET"];
      if (allowed.includes("GET")) allowed.push("HEAD");
      if (!allowed.includes(request.method))
        throw new HttpError(
          405,
          "METHOD_NOT_ALLOWED",
          "Метод не поддерживается",
          undefined,
          { Allow: allowed.join(", ") },
        );
      const { db, tokens } = services();
      if (stream) {
        response = streams.open(request, url);
      } else if (exporting) {
        limiter.consume("export", 20, 60000);
        response = exports.open(db, tokens, request, url);
      } else if (request.method === "POST") {
        limiter.consume("ingest", 1200, 60000);
        if (url.search) throw new HttpError(400, "INVALID_QUERY");
        const input = await readJson(request);
        let result;
        try {
          result = insertEvent(db, input);
        } catch (error) {
          if (error instanceof z.ZodError) {
            throw new HttpError(
              400,
              "VALIDATION_ERROR",
              "Проверьте поля события",
              error.issues.map((issue) => ({
                path: issue.path.length
                  ? "/" +
                    issue.path
                      .map((v) =>
                        String(v).replaceAll("~", "~0").replaceAll("/", "~1"),
                      )
                      .join("/")
                  : "",
                code:
                  issue.path.length === 1 &&
                  input !== null &&
                  typeof input === "object" &&
                  !Object.hasOwn(input, issue.path[0]!)
                    ? "required"
                    : issue.code,
                message: "Недопустимое или отсутствующее значение",
              })),
            );
          }
          throw error;
        }
        response = Response.json(
          { event: eventDto(result.event, true), replayed: !result.inserted },
          { status: result.inserted ? 201 : 200 },
        );
      } else {
        const data =
          path === "/api/events"
            ? listEvents(db, tokens, url)
            : path === "/api/overview"
              ? overview(db, tokens, url)
              : path === "/api/facets"
                ? facets(db, tokens, url)
                : (() => {
                    return detailEvent(
                      db,
                      decodeEventId(path.slice("/api/events/".length)),
                      { tokens, url },
                    );
                  })();
        response = Response.json(data);
      }
    } catch (error) {
      const problem = safeError(error);
      errorCode = problem.code;
      response = Response.json(
        {
          error: {
            code: problem.code,
            message: problem.message,
            ...(problem.fields ? { fields: problem.fields } : {}),
            request_id: id,
          },
        },
        { status: problem.status, headers: problem.headers },
      );
    }
    // Normalize response headers and omit the body for HEAD.
    response = new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      headers: response.headers,
    });
    if (!response.headers.has("Cache-Control"))
      response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Request-ID", id);
    if (errorCode) response.headers.set("X-Error-Code", errorCode);
    // The download frame must be able to display same-origin JSON failures.
    if (template === "/api/events/export")
      response.headers.set("X-Frame-Options", "SAMEORIGIN");
    response.headers.set("X-Content-Type-Options", "nosniff");
    if (deps.log)
      console.info(
        JSON.stringify({
          request_id: id,
          route: template,
          status: response.status,
          duration_ms: Math.round(performance.now() - started),
          ...(errorCode ? { code: errorCode } : {}),
        }),
      );
    return response;
  };
}
