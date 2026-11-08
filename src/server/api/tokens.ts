import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { canonicalJson } from "../events/normalize.ts";
import type { AppDatabase } from "../db/connection.ts";
import { HttpError } from "./errors.ts";

export function decodeBase64(value: string): Buffer {
  if (!/^[\w-]+$/.test(value)) throw new Error("base64url");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("base64url");
  return bytes;
}
export class Tokens {
  constructor(private secret: string) {}
  sign(domain: string, payload: unknown): string {
    const encoded = Buffer.from(canonicalJson(payload)).toString("base64url");
    return `${encoded}.${this.mac(domain, encoded).toString("base64url")}`;
  }
  read(domain: "snapshot" | "cursor" | "facets", token: string): unknown {
    try {
      if (Buffer.byteLength(token) > 8192) throw new Error("size");
      const parts = token.split(".");
      if (parts.length !== 2) throw new Error("format");
      const [encoded, signature] = parts as [string, string];
      const actual = decodeBase64(signature);
      const expected = this.mac(domain, encoded);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error("signature");
      const json = new TextDecoder("utf-8", { fatal: true }).decode(
        decodeBase64(encoded),
      );
      const parsed: unknown = JSON.parse(json);
      if (canonicalJson(parsed) !== json) throw new Error("canonical JSON");
      return parsed;
    } catch {
      throw new HttpError(
        400,
        domain === "snapshot" ? "INVALID_SNAPSHOT" : "INVALID_CURSOR",
        "Недействительный token",
      );
    }
  }
  private mac(domain: string, value: string) {
    return createHmac("sha256", this.secret)
      .update(`${domain}:${value}`)
      .digest();
  }
}

// Pagination signatures are independent of user access and persist across restarts.
export function signingSecret(db: AppDatabase): string {
  return db.sqlite
    .transaction(() => {
      db.sqlite
        .prepare(
          "INSERT INTO app_meta(key,value) VALUES('pagination_secret',?) ON CONFLICT(key) DO NOTHING",
        )
        .run(randomBytes(32).toString("base64url"));
      return (
        db.sqlite
          .prepare("SELECT value FROM app_meta WHERE key='pagination_secret'")
          .get() as { value: string }
      ).value;
    })
    .immediate();
}
