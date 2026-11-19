import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { events } from "../src/server.ts";
import { useServer } from "./helpers.ts";

const api = useServer();
const v1 = (p: string) => `${api.base}/api/v1${p}`;

test("GET /api/v1/events lists with defaults and the legacy list is unchanged", async () => {
  const body = (await (await fetch(v1("/events"))).json()) as { data: unknown[]; meta: { page: number } };
  assert.equal(body.meta.page, 1);
  assert.ok(Array.isArray(body.data));
  const legacy = await (await fetch(`${api.base}/events`)).json();
  assert.ok(Array.isArray(legacy)); // lecture 05 shape preserved
});

test("query: sort, page and city are read separately and do not change routing", async () => {
  const res = await fetch(v1("/events?city=alexandria&sort=-name&page=1"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { name: string }[]; meta: { city: string; sort: string } };
  assert.equal(body.meta.city, "alexandria");
  assert.equal(body.meta.sort, "-name");
  const names = body.data.map((e) => e.name);
  assert.deepEqual(names, [...names].sort().reverse());
  const far = (await (await fetch(v1("/events?page=99"))).json()) as { data: unknown[] };
  assert.deepEqual(far.data, []);
});

for (const bad of ["page=0", "page=abc", "page=", "page=1&page=2", "sort=price", "sort=", "city=a&city=b"]) {
  test(`query policy: ?${bad} is 400`, async () => {
    const res = await fetch(v1(`/events?${bad}`));
    assert.equal(res.status, 400);
  });
}

test("GET and POST on the same v1 path dispatch differently; Location carries the prefix", async () => {
  const before = events.length;
  const res = await fetch(v1("/events"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Routing Test", seats: 5 }),
  });
  assert.equal(res.status, 201);
  const created = (await res.json()) as { id: number };
  assert.equal(res.headers.get("location"), `/api/v1/events/${created.id}`);
  assert.equal(events.length, before + 1);
  assert.equal((await fetch(v1(`/events/${created.id}`), { method: "DELETE" })).status, 204);
});

test("GET /api/v1/events/1 returns id 1; missing event is a handler-level 404", async () => {
  const ok = await fetch(v1("/events/1"));
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { id: number }).id, 1);
  assert.equal((await fetch(v1("/events/999"))).status, 404);
});

test("static /events/search reaches its handler; non-numeric ids are routing misses", async () => {
  const res = await fetch(v1("/events/search?q=jazz"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { name: string }[] };
  assert.deepEqual(body.data.map((e) => e.name), ["Synthetic Jazz Night"]);
  assert.equal((await fetch(v1("/events/abc"))).status, 404);
  assert.equal((await fetch(v1("/events/search?q=a&q=b"))).status, 400);
});

test("nested route extracts the parent id; missing parent is 404", async () => {
  const res = await fetch(v1("/events/2/tickets"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { eventId: number }[] };
  assert.ok(body.data.length > 0 && body.data.every((t) => t.eventId === 2));
  assert.equal((await fetch(v1("/events/999/tickets"))).status, 404);
  assert.equal((await fetch(v1("/events//tickets"))).status, 404);
  assert.equal((await fetch(v1("/events/2/tickets/9"))).status, 404);
});

test("POST /api/v1/bookings is a stub: 501 and nothing changes", async () => {
  const snapshot = JSON.stringify(events);
  const res = await fetch(v1("/bookings"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: 1, quantity: 1 }),
  });
  assert.equal(res.status, 501);
  assert.equal(JSON.stringify(events), snapshot);
  const wrong = await fetch(v1("/bookings"));
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "POST, OPTIONS");
});

test("PATCH /api/v1/events/:id changes only the given fields; invalid input mutates nothing", async () => {
  const create = await fetch(v1("/events"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Patch Me", seats: 10 }),
  });
  const { id } = (await create.json()) as { id: number };
  const patch = (body: unknown) =>
    fetch(v1(`/events/${id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ok = await patch({ seats: 11 });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { id, name: "Patch Me", seats: 11 });
  const snapshot = JSON.stringify(events);
  assert.equal((await patch({ seats: -1 })).status, 422);
  assert.equal((await patch({})).status, 422);
  assert.equal(JSON.stringify(events), snapshot);
  await fetch(v1(`/events/${id}`), { method: "DELETE" });
});

test("405 Allow and OPTIONS come from the registered routes (v1 item has PATCH)", async () => {
  const del = await fetch(v1("/events"), { method: "DELETE" });
  assert.equal(del.status, 405);
  assert.equal(del.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
  const opt = await fetch(v1("/events/1"), { method: "OPTIONS" });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("allow"), "GET, HEAD, PUT, PATCH, DELETE, OPTIONS");
  const search = await fetch(v1("/events/search"), { method: "POST" });
  assert.equal(search.status, 405);
  assert.equal(search.headers.get("allow"), "GET, HEAD, OPTIONS");
});

test("HEAD on v1 routes: same status and headers as GET, no body", async () => {
  const get = await fetch(v1("/events/1"));
  const head = await fetch(v1("/events/1"), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), get.headers.get("etag"));
  assert.equal(await head.text(), "");
});

test("unsupported version and unknown paths are 404; legacy routes still work", async () => {
  assert.equal((await fetch(`${api.base}/api/v2/events`)).status, 404);
  assert.equal((await fetch(`${api.base}/api/events`)).status, 404);
  assert.equal((await fetch(`${api.base}/api`)).status, 404);
  assert.equal((await fetch(`${api.base}/events/search`)).status, 404); // search is v1 only
  assert.equal((await fetch(`${api.base}/health`)).status, 200);
});

// fetch() normalises URLs, so send hostile targets with a raw client.
function raw(target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const { port } = new URL(api.base);
    const req = http.request({ host: "127.0.0.1", port: Number(port), path: target, method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("encoded segments and malformed escapes: documented, no crash", async () => {
  assert.equal(await raw("/api/v1/events/%31"), 200); // %31 decodes to "1"
  assert.equal(await raw("/api/v1/events/1%2Ftickets"), 404); // %2F is not a separator
  assert.equal(await raw("/api/v1/events/%"), 400);
  assert.equal(await raw("/api/v1/events/%zz"), 400);
  assert.equal(await raw("/api/v1/events/1/"), 404); // trailing slash
  assert.equal(await raw("/API/V1/events"), 404); // case-sensitive
  assert.equal(await raw("/api/v1//events"), 404); // empty segment
  assert.equal(await raw("//api/v1/events"), 404); // not a host
  assert.equal(await raw("/health"), 200); // still alive afterwards
});

test("PATCH merges into the event as it is after the body arrives (no lost update)", async () => {
  const create = await fetch(v1("/events"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Race Me", seats: 10 }),
  });
  const { id } = (await create.json()) as { id: number };
  const json = JSON.stringify({ name: "Renamed" });
  const { port } = new URL(api.base);

  // Slow PATCH: headers and half the body now, the rest after a PUT has landed.
  const patchDone = new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port: Number(port), method: "PATCH", path: `/api/v1/events/${id}`,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json), authorization: `Bearer ${api.adminToken}` },
      },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); },
    );
    req.on("error", reject);
    req.write(json.slice(0, 5));
    setTimeout(async () => {
      await fetch(v1(`/events/${id}`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Race Me", seats: 50 }),
      });
      req.end(json.slice(5));
    }, 50);
  });

  assert.equal(await patchDone, 200);
  const final = (await (await fetch(v1(`/events/${id}`))).json()) as { name: string; seats: number };
  assert.deepEqual(final, { id, name: "Renamed", seats: 50 }); // PUT's seats survived
  await fetch(v1(`/events/${id}`), { method: "DELETE" });
});
