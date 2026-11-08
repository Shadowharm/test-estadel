import { createHash } from "node:crypto";
import { HttpError } from "./errors.ts";

// One process, bounded state. No unverified X-Forwarded-For or client supplied IP.
// Until a trusted ingress is configured the IP bucket is conservatively shared.
export class RateLimiter {
  private buckets = new Map<string, { count: number; until: number }>();
  constructor(
    private capacity = 1024,
    private now = Date.now,
  ) {}
  consume(key: string, limit: number, windowMs: number) {
    const now = this.now();
    for (const [k, b] of this.buckets)
      if (b.until <= now) this.buckets.delete(k);
    const hashed = createHash("sha256").update(key).digest("hex");
    let bucket = this.buckets.get(hashed);
    if (!bucket) {
      if (this.buckets.size >= this.capacity)
        throw new HttpError(429, "RATE_LIMITED", "Повторите позже", undefined, {
          "Retry-After": "60",
        });
      bucket = { count: 0, until: now + windowMs };
      this.buckets.set(hashed, bucket);
    }
    if (bucket.count >= limit)
      throw new HttpError(
        429,
        "RATE_LIMITED",
        "Слишком много запросов",
        undefined,
        {
          "Retry-After": String(
            Math.max(1, Math.ceil((bucket.until - now) / 1000)),
          ),
        },
      );
    bucket.count++;
  }
}
