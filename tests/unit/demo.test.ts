import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
async function endpoint(status = 201) {
  const deliveries: Record<string, unknown>[] = [];
  const ids = new Set();
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const event = JSON.parse(body) as Record<string, unknown>;
    deliveries.push(event);
    const replayed = ids.has(event.id);
    ids.add(event.id);
    response.writeHead(replayed ? 200 : status, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify({ replayed }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port");
  return { url: `http://127.0.0.1:${address.port}`, deliveries };
}
async function demo(args: string[], interrupt = false) {
  const child = spawn(process.execPath, ["scripts/demo.ts", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    if (interrupt && stdout.includes("1/100")) {
      interrupt = false;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timeout);
  return { code, signal, stdout, stderr };
}

it("posts bounded synthetic errors/late events and deliberate identical replays", async () => {
  const { url, deliveries } = await endpoint();
  const result = await demo([
    "--url",
    url,
    "--count",
    "3",
    "--interval-ms",
    "100",
    "--error-every",
    "3",
    "--late-every",
    "2",
    "--replay-every",
    "1",
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect(deliveries).toHaveLength(6);
  expect(deliveries[0]).toEqual(deliveries[1]);
  expect(deliveries[2]).toEqual(deliveries[3]);
  expect(deliveries[4]).toMatchObject({
    status: "error",
    error_code: "DEMO_TIMEOUT",
  });
  expect(
    Date.parse(String(deliveries[0]!.created_at)) -
      Date.parse(String(deliveries[2]!.created_at)),
  ).toBeGreaterThan(86_390_000);
  expect(result.stdout).toContain("Подтверждено сервером: 3/3; повторов ID: 3");
});
it("stops on an unsuccessful POST without retrying or claiming a saved event", async () => {
  const { url, deliveries } = await endpoint(503);
  const result = await demo([
    "--url",
    url,
    "--count",
    "3",
    "--interval-ms",
    "100",
  ]);
  expect(result.code).toBe(1);
  expect(deliveries).toHaveLength(1);
  expect(result.stderr).toContain("HTTP 503");
  expect(result.stdout).toContain("Подтверждено сервером: 0/3");
});
it("interrupts the interval on SIGTERM without waiting for its duration", async () => {
  const { url, deliveries } = await endpoint();
  const result = await demo(
    ["--url", url, "--count", "100", "--interval-ms", "60000"],
    true,
  );
  expect(result.code, result.stderr).toBe(0);
  expect(result.signal).toBe(null);
  expect(deliveries).toHaveLength(1);
  expect(result.stdout).toContain("Остановлено. Подтверждено сервером: 1/100");
});
