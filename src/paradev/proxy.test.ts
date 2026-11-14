import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkProxy, liveProxyGet, PROXY_TIMEOUT_MS, type ProxyGet } from "./proxy.ts";

const answering =
  (status: number): { get: ProxyGet; asked: Array<string> } => {
    const asked: Array<string> = [];
    return {
      asked,
      get: (url) => {
        asked.push(url);
        return Effect.succeed(status);
      },
    };
  };

describe("checkProxy", () => {
  it.effect("401 with no key is guarded: the key check is on", () =>
    Effect.gen(function* () {
      const { get } = answering(401);
      assert.deepStrictEqual(yield* checkProxy(get, "https://proxy.example"), { kind: "guarded" });
    }),
  );

  it.effect("200 with no key is open: the key check is off", () =>
    Effect.gen(function* () {
      const { get } = answering(200);
      assert.deepStrictEqual(yield* checkProxy(get, "https://proxy.example"), { kind: "open" });
    }),
  );

  it.effect("any other answer is down, with the status", () =>
    Effect.gen(function* () {
      const { get } = answering(503);
      assert.deepStrictEqual(yield* checkProxy(get, "https://proxy.example"), {
        kind: "down",
        reason: "answered HTTP 503",
      });
    }),
  );

  // The real clock: it.effect runs on a TestClock that the timeout would wait on forever.
  it.live("no answer within the timeout is down", () =>
    Effect.gen(function* () {
      const never: ProxyGet = () => Effect.never;
      assert.deepStrictEqual(yield* checkProxy(never, "https://proxy.example", 20), {
        kind: "down",
        reason: "did not answer within 0.02 s",
      });
    }),
  );

  it.effect("a connect failure is down, with its reason", () =>
    Effect.gen(function* () {
      const refused: ProxyGet = () => Effect.fail("connection refused");
      assert.deepStrictEqual(yield* checkProxy(refused, "https://proxy.example"), {
        kind: "down",
        reason: "connection refused",
      });
    }),
  );

  it.effect("asks /v1/models, with no double slash after a trailing one", () =>
    Effect.gen(function* () {
      const plain = answering(401);
      yield* checkProxy(plain.get, "https://proxy.example");
      const slashed = answering(401);
      yield* checkProxy(slashed.get, "https://proxy.example:8443//");
      assert.deepStrictEqual(plain.asked, ["https://proxy.example/v1/models"]);
      assert.deepStrictEqual(slashed.asked, ["https://proxy.example:8443/v1/models"]);
    }),
  );
});

describe("liveProxyGet", () => {
  /** A real server on 127.0.0.1 for the scope; `seen` is each request it took. */
  const serving = (handler: (request: Http.IncomingMessage, response: Http.ServerResponse) => void) =>
    Effect.gen(function* () {
      const seen: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> = [];
      const sockets = new Set<import("node:net").Socket>();
      const server = Http.createServer((request, response) => {
        seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
        handler(request, response);
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      yield* Effect.acquireRelease(
        Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => resolve());
              }),
          ),
      );
      return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    });

  it.live("sends GET /v1/models with no authorization header, and a 401 comes back as guarded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serving((_request, response) => response.writeHead(401).end());
        assert.deepStrictEqual(yield* checkProxy(liveProxyGet, server.url), { kind: "guarded" });
        assert.deepStrictEqual(server.seen, [{ method: "GET", url: "/v1/models", authorization: undefined }]);
      }),
    ),
  );

  it.live("a redirect is the answer, not followed: a 302 to a path that answers 401 is down", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serving((request, response) =>
          request.url === "/v1/models" ? response.writeHead(302, { location: "/login" }).end() : response.writeHead(401).end(),
        );
        assert.deepStrictEqual(yield* checkProxy(liveProxyGet, server.url), { kind: "down", reason: "answered HTTP 302" });
        assert.deepStrictEqual(server.seen.map((request) => request.url), ["/v1/models"]);
      }),
    ),
  );

  it.live("a server that never answers is down at checkProxy's timeout, and the request is aborted then", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closed = false;
        const server = yield* serving((request) => void request.socket.on("close", () => (closed = true)));
        assert.deepStrictEqual(yield* checkProxy(liveProxyGet, server.url, 50), {
          kind: "down",
          reason: "did not answer within 0.05 s",
        });
        // The one timeout aborts the fetch too: the server sees the connection close, not ten seconds later.
        const until = Date.now() + 2_000;
        while (!closed && Date.now() < until) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
        assert.isTrue(closed);
      }),
    ),
  );

  it("waits ten seconds for the proxy", () => {
    assert.strictEqual(PROXY_TIMEOUT_MS, 10_000);
  });
});
