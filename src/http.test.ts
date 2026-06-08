// Tests for the fetchWithTimeout helper. Exercises real network behaviour against
// 127.0.0.1 with a controlled hang — verifies the timeout actually fires and the
// error message has the expected stable shape so toToolError can classify it as
// RPC_FAILED.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fetchWithTimeout } from "./http.js";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((_req, _res) => {
    // Intentionally never respond — caller must give up via timeout.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections?.();
  server.close();
});

describe("fetchWithTimeout", () => {
  it("throws a 'timeout after Nms' error when the server never responds", async () => {
    const url = `http://127.0.0.1:${port}/`;
    await expect(fetchWithTimeout(url, undefined, 80)).rejects.toThrow(/timeout after 80ms/);
  });

  it("rethrows non-timeout errors unchanged (e.g. connection refused)", async () => {
    // Picking a port that's almost certainly closed; node throws ECONNREFUSED, not a timeout.
    const url = `http://127.0.0.1:1/`;
    await expect(fetchWithTimeout(url, undefined, 1000)).rejects.toThrow(/ECONNREFUSED|fetch failed/i);
  });

  it("resolves normally for a responsive endpoint", async () => {
    // Spin up a second short-lived server that responds 200 OK.
    const fastServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hi");
    });
    await new Promise<void>((resolve) => fastServer.listen(0, "127.0.0.1", resolve));
    const fastPort = (fastServer.address() as AddressInfo).port;
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${fastPort}/`, undefined, 2000);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hi");
    } finally {
      fastServer.closeAllConnections?.();
      fastServer.close();
    }
  });
});

describe("fetchWithTimeout retry (iter133)", () => {
  /** Server that returns the FIRST status from the list, then 200 OK for subsequent requests. */
  async function flakyServer(statuses: number[]): Promise<{ url: string; calls: () => number; stop: () => void }> {
    let i = 0;
    const srv = http.createServer((_req, res) => {
      const status = statuses[i] ?? 200;
      i++;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200 }));
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const p = (srv.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${p}/`,
      calls: () => i,
      stop: () => {
        srv.closeAllConnections?.();
        srv.close();
      },
    };
  }

  it("default (no retries): 503 passes through with calls=1", async () => {
    const s = await flakyServer([503]);
    try {
      const res = await fetchWithTimeout(s.url);
      expect(res.status).toBe(503);
      expect(s.calls()).toBe(1);
    } finally {
      s.stop();
    }
  });

  it("retries: 2 on 503 — eventually returns 200", async () => {
    const s = await flakyServer([503, 503, 200]);
    try {
      const res = await fetchWithTimeout(s.url, undefined, { retries: 2, retryBaseMs: 1 });
      expect(res.status).toBe(200);
      expect(s.calls()).toBe(3);
    } finally {
      s.stop();
    }
  });

  it("retries 429 (rate limit) — covers the CoinGecko free-tier case", async () => {
    const s = await flakyServer([429, 200]);
    try {
      const res = await fetchWithTimeout(s.url, undefined, { retries: 2, retryBaseMs: 1 });
      expect(res.status).toBe(200);
      expect(s.calls()).toBe(2);
    } finally {
      s.stop();
    }
  });

  it("does NOT retry 404 — non-retryable 4xx shouldn't waste rate budget", async () => {
    const s = await flakyServer([404, 200]);
    try {
      const res = await fetchWithTimeout(s.url, undefined, { retries: 5, retryBaseMs: 1 });
      expect(res.status).toBe(404);
      expect(s.calls()).toBe(1);
    } finally {
      s.stop();
    }
  });

  it("surfaces final retryable status after retries exhausted (returns, doesn't throw)", async () => {
    const s = await flakyServer([503, 503, 503]);
    try {
      const res = await fetchWithTimeout(s.url, undefined, { retries: 2, retryBaseMs: 1 });
      expect(res.status).toBe(503);
      expect(s.calls()).toBe(3); // 1 initial + 2 retries
    } finally {
      s.stop();
    }
  });

  it("back-compat: third positional arg as number still works", async () => {
    const s = await flakyServer([200]);
    try {
      const res = await fetchWithTimeout(s.url, undefined, 5000);
      expect(res.status).toBe(200);
    } finally {
      s.stop();
    }
  });
});

describe("fetchWithTimeout User-Agent (iter417)", () => {
  /** Echoes the request's user-agent header in the response body. */
  async function uaServer(): Promise<{ url: string; stop: () => void }> {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(req.headers["user-agent"] ?? "<missing>");
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const p = (srv.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${p}/`,
      stop: () => {
        srv.closeAllConnections?.();
        srv.close();
      },
    };
  }

  it("injects a tradekit User-Agent when caller didn't set one", async () => {
    const s = await uaServer();
    try {
      const res = await fetchWithTimeout(s.url);
      const ua = await res.text();
      // Pin the shape so a refactor doesn't silently fall back to undici defaults.
      // Don't pin the version literal — that drifts; pin the prefix + URL suffix.
      expect(ua).toMatch(/^tradekit\/.+ \(\+https:\/\/github\.com\/anthropics\/tradekit\)$/);
    } finally {
      s.stop();
    }
  });

  it("caller-supplied User-Agent wins (object header form)", async () => {
    const s = await uaServer();
    try {
      const res = await fetchWithTimeout(s.url, { headers: { "User-Agent": "custom-ua/1.0" } });
      expect(await res.text()).toBe("custom-ua/1.0");
    } finally {
      s.stop();
    }
  });

  it("caller-supplied User-Agent wins (lowercase header key — case-insensitive check)", async () => {
    const s = await uaServer();
    try {
      const res = await fetchWithTimeout(s.url, { headers: { "user-agent": "lc-ua/2.0" } });
      expect(await res.text()).toBe("lc-ua/2.0");
    } finally {
      s.stop();
    }
  });
});
