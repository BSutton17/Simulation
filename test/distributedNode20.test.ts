import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { QueueClient } from "../simulation/src/distributed/client.js";

/**
 * The client must construct on Node 20, which has no global WebSocket.
 *
 * `createClient` builds a RealtimeClient eagerly in its constructor, and that
 * constructor resolves a WebSocket:
 *
 *     result.transport = options?.transport ?? WebSocketFactory.getWebSocketConstructor()
 *
 * With no global WebSocket the factory throws "Node.js detected but native
 * WebSocket not found" before a single query can run. Node 22 added the global,
 * so this passed on a developer machine and failed on Kaggle — the whole
 * coordinator died at startup having cloned, installed, built and loaded the
 * 181-dimension schema successfully.
 *
 * These tests delete the global to reproduce Node 20 regardless of what the
 * machine running them actually has. Asserting on `process.version` instead
 * would make them silently vacuous on every developer machine, which is
 * precisely how the bug reached production.
 */

function withoutGlobalWebSocket<T>(body: () => T): T {
  const saved = Reflect.get(globalThis, "WebSocket");
  Reflect.deleteProperty(globalThis, "WebSocket");
  try {
    return body();
  } finally {
    if (saved !== undefined) Reflect.set(globalThis, "WebSocket", saved);
  }
}

const CREDENTIALS = { url: "https://example.supabase.co", key: "test-key-not-a-real-credential" };

test("the client constructs with no global WebSocket", () => {
  withoutGlobalWebSocket(() => {
    assert.equal(
      Reflect.get(globalThis, "WebSocket"),
      undefined,
      "the test must actually remove the global, or it proves nothing",
    );

    for (const role of ["coordinator", "worker"] as const) {
      const client = new QueueClient({ ...CREDENTIALS, role });
      assert.equal(client.role, role);
    }
  });
});

test("the environment this guards against really does break the default client", () => {
  // Without this, a future change that quietly dropped the transport option
  // would still pass the test above if some dependency happened to polyfill
  // WebSocket. Proving the unpatched path fails keeps the guard honest.
  // Synchronous on purpose: an async body would let the helper restore the
  // global before the body ran, and the assertion would then be testing a
  // machine that still has WebSocket.
  withoutGlobalWebSocket(() => {
    assert.throws(
      () => createClient(CREDENTIALS.url, CREDENTIALS.key),
      /WebSocket/i,
      "a default client should fail without a global WebSocket — if this stops " +
        "being true, the transport workaround may no longer be needed",
    );
  });
});

test("database and RPC access is unaffected", () => {
  // The fix must not have cost us the only two things this client does:
  // .from() for tables and .rpc() for claim_job and submit_result.
  withoutGlobalWebSocket(() => {
    const client = new QueueClient({ ...CREDENTIALS, role: "worker" });
    const db = Reflect.get(client, "db") as { from: unknown; rpc: unknown };
    assert.equal(typeof db.from, "function", "table access is gone");
    assert.equal(typeof db.rpc, "function", "RPC access is gone");
  });
});

test("the unused transport refuses to be instantiated", () => {
  // It exists to stop the factory being consulted, never to open a socket. If
  // something did try to use Realtime, failing loudly beats connecting to
  // nothing and appearing to work.
  withoutGlobalWebSocket(() => {
    const client = new QueueClient({ ...CREDENTIALS, role: "worker" });
    const realtime = Reflect.get(
      Reflect.get(client, "db") as object, "realtime",
    ) as { transport?: new () => unknown } | undefined;

    assert.ok(realtime, "supabase-js still builds a realtime client eagerly");
    assert.ok(realtime.transport, "a transport must be supplied, or the factory runs");
    assert.throws(() => new realtime.transport!(), /Realtime is not available/);
  });
});

test("no WebSocket package was added to satisfy this", () => {
  // The supported option was available, so pulling in `ws` purely to feed a
  // code path we never exercise would have been the wrong trade.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ["ws", "isomorphic-ws", "websocket", "undici"]) {
    assert.ok(!(name in all), `${name} was added; the transport option makes it unnecessary`);
  }
});

test("the engine requirement still admits Node 20", () => {
  // supabase-js declares engines.node >= 22. npm warns and installs anyway, and
  // the only Node 22 feature it needed on our code path was the WebSocket
  // global. If this project's own floor ever rises above 20, Kaggle stops
  // working.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { engines?: { node?: string } };
  const floor = /(\d+)/.exec(pkg.engines?.node ?? "")?.[1];
  assert.ok(floor && Number(floor) <= 20, `engines.node requires ${floor}, but Kaggle runs Node 20`);
});
