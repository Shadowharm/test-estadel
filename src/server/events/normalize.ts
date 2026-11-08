import { createHash } from "node:crypto";
import { z } from "zod";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
export const textField = (max: number, multiline = false) =>
  z
    .string()
    .transform((s) => s.trim().normalize("NFC"))
    .refine(
      (s) =>
        s.isWellFormed() &&
        [...s].length >= 1 &&
        [...s].length <= max &&
        ![...s].some((c) => {
          const n = c.codePointAt(0)!;
          return (
            (n < 32 || (n >= 127 && n <= 159)) &&
            !(multiline && [9, 10, 13].includes(n))
          );
        }),
      "Неверная длина или недопустимые символы",
    );

export function validDate(value: string) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return false;
  const [, y, m, d, h, min, sec, offset] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const ms = Date.parse(value);
  return (
    Number(y) >= 1 &&
    Number(m) >= 1 &&
    Number(m) <= 12 &&
    Number(d) >= 1 &&
    date.getUTCDate() === Number(d) &&
    Number(h) <= 23 &&
    Number(min) <= 59 &&
    Number(sec) <= 59 &&
    (offset === "Z" ||
      (Number(offset!.slice(1, 3)) <= 23 && Number(offset!.slice(4)) <= 59)) &&
    Number.isFinite(ms) &&
    ms >= -62135596800000 &&
    ms <= 253402300799999
  );
}
type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
function validPayload(value: unknown, depth = 1): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value !== "object" || depth > 16) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  return Object.values(value).every((child) => validPayload(child, depth + 1));
}
const eventSchema = z
  .strictObject({
    id: textField(100),
    source: textField(100),
    type: textField(150),
    status: z.enum(["success", "error"]),
    created_at: z
      .string()
      .refine(
        validDate,
        "Нужна реальная RFC3339 дата с timezone и точностью до ms",
      )
      .transform((value) => new Date(value).toISOString()),
    message: textField(2000, true),
    error_code: textField(100).optional(),
    // z.record/z.json clone objects and drop __proto__ keys. JSON payload must
    // retain every own key so canonical hashes cannot hide changed content.
    payload: z
      .custom<JsonObject>(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          validPayload(value),
        "Нужен JSON-объект глубиной не более 16 уровней",
      )
      .refine(
        (value) => Buffer.byteLength(canonicalJson(value)) <= 16384,
        "Payload превышает 16 KiB",
      )
      .optional(),
  })
  .refine(
    (value) => value.error_code === undefined || value.status === "error",
    { path: ["error_code"], message: "Код причины допустим только для ошибки" },
  );

export function normalizeEvent(input: unknown) {
  const event = eventSchema.parse(input);
  if (event.error_code === undefined) delete event.error_code;
  if (event.payload === undefined) delete event.payload;
  return {
    event,
    row: {
      id: event.id,
      source: event.source,
      type: event.type,
      status: event.status,
      createdAtMs: Date.parse(event.created_at),
      message: event.message,
      errorCode: event.error_code ?? null,
      payloadJson:
        event.payload === undefined ? null : canonicalJson(event.payload),
      canonicalHash: createHash("sha256")
        .update(canonicalJson(event))
        .digest("hex"),
      sourceSort: event.source.normalize("NFKC").toLowerCase(),
      typeSort: event.type.normalize("NFKC").toLowerCase(),
    },
  };
}
export type EventInput = z.input<typeof eventSchema>;
