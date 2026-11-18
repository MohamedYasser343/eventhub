import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, Router, scalar } from "../src/router.ts";

// The router is pure: strings in, a decision out. No server, no database.
const h = (name: string) => name;

function build() {
  const r = new Router<string>();
  r.add("GET", "/events", h("list"));
  r.add("POST", "/events", h("create"));
  r.add("GET", "/events/search", h("search"));
  r.add("GET", "/events/:id", h("show"), { id: /^[1-9][0-9]*$/ });
  r.add("GET", "/events/:id/tickets", h("tickets"), { id: /^[1-9][0-9]*$/ });
  return r;
}

test("same path, different methods dispatch to different handlers", () => {
  const r = build();
  assert.deepEqual(pick(r.match("GET", "/events")), "list");
  assert.deepEqual(pick(r.match("POST", "/events")), "create");
});

function pick(m: ReturnType<Router<string>["match"]>): string {
  return m.kind === "match" ? m.handler : m.kind;
}

test("path parameter is extracted; nested route extracts the parent id", () => {
  const r = build();
  const show = r.match("GET", "/events/42");
  assert.ok(show.kind === "match" && show.handler === "show");
  assert.equal(show.kind === "match" && show.params["id"], "42");
  const t = r.match("GET", "/events/42/tickets");
  assert.ok(t.kind === "match" && t.handler === "tickets");
  assert.equal(t.kind === "match" && t.params["id"], "42");
});

test("404 for unknown paths, 405 with Allow for a known path", () => {
  const r = build();
  assert.equal(r.match("GET", "/nope").kind, "not-found");
  const m = r.match("DELETE", "/events");
  assert.deepEqual(m, { kind: "method-not-allowed", allow: "GET, HEAD, POST" });
});

test("HEAD uses the GET route", () => {
  assert.equal(pick(build().match("HEAD", "/events")), "list");
});

// ---- Collision experiment (assignment step 3) ----

test("EXPERIMENT: unconstrained dynamic route registered first captures /events/search", () => {
  const r = new Router<string>();
  r.add("GET", "/events/:id", "show"); // no constraint, declared first
  r.add("GET", "/events/search", "search");
  const m = r.match("GET", "/events/search");
  assert.ok(m.kind === "match");
  assert.equal(m.handler, "show"); // the bug: "search" became an id
  assert.equal(m.params["id"], "search");
});

test("FIX A: registering the static route first wins", () => {
  const r = new Router<string>();
  r.add("GET", "/events/search", "search");
  r.add("GET", "/events/:id", "show");
  assert.equal(pick(r.match("GET", "/events/search")), "search");
  assert.equal(pick(r.match("GET", "/events/42")), "show");
});

test("FIX B: a numeric constraint works in either order", () => {
  for (const searchFirst of [true, false]) {
    const r = new Router<string>();
    const idRoute = () => r.add("GET", "/events/:id", "show", { id: /^[1-9][0-9]*$/ });
    const searchRoute = () => r.add("GET", "/events/search", "search");
    if (searchFirst) { searchRoute(); idRoute(); } else { idRoute(); searchRoute(); }
    assert.equal(pick(r.match("GET", "/events/search")), "search");
    assert.equal(pick(r.match("GET", "/events/42")), "show");
    assert.equal(pick(r.match("GET", "/events/abc")), "not-found");
  }
});

// ---- Edge cases (policy documented in router.ts / ADR-005) ----

test("trailing slash, empty id, extra segments and case do not match", () => {
  const r = build();
  for (const p of ["/events/", "/events//tickets", "/events/42/", "/events/42/tickets/7", "/Events", "/EVENTS/42"]) {
    assert.equal(r.match("GET", p).kind, "not-found", p);
  }
});

test("constraint rejects 0, leading zeros and non-numbers before any handler", () => {
  const r = build();
  for (const id of ["0", "01", "-1", "1.5", "abc"]) {
    assert.equal(r.match("GET", `/events/${id}`).kind, "not-found", id);
  }
});

test("percent-decoding happens once, per segment", () => {
  const r = build();
  // %34%32 is "42": decoded once, then constrained.
  const m = r.match("GET", "/events/%34%32");
  assert.ok(m.kind === "match" && m.params["id"] === "42");
  // An encoded slash stays inside one segment: it is not a path separator.
  assert.equal(r.match("GET", "/events/42%2Ftickets").kind, "not-found");
  // Double encoding is decoded once only: "%2534%2532" -> "%34%32", not "42".
  assert.equal(r.match("GET", "/events/%2534%2532").kind, "not-found");
});

test("malformed percent escapes are a bad-request, never a crash", () => {
  const r = build();
  for (const p of ["/events/%", "/events/%zz", "/events/%E0%A4%A", "/%/x"]) {
    assert.equal(r.match("GET", p).kind, "bad-request", p);
  }
});

// ---- Groups, versions, wildcard ----

test("groups share a prefix; an unregistered version is a plain 404", () => {
  const r = new Router<string>();
  const v1 = r.group("/api/v1");
  v1.add("GET", "/events", "v1-list");
  const m = r.match("GET", "/api/v1/events");
  assert.ok(m.kind === "match" && m.prefix === "/api/v1");
  assert.equal(r.match("GET", "/api/v2/events").kind, "not-found");
  assert.throws(() => r.group("/api/v1/"));
});

test("wildcard matches one or more segments; fallback is ordered last", () => {
  const r = new Router<string>();
  r.add("GET", "/files/readme", "readme");
  r.add("GET", "/files/*", "catch-all");
  const exact = r.match("GET", "/files/readme");
  assert.ok(exact.kind === "match" && exact.handler === "readme");
  const deep = r.match("GET", "/files/a/b/c");
  assert.ok(deep.kind === "match" && deep.handler === "catch-all" && deep.params["*"] === "a/b/c");
  assert.equal(r.match("GET", "/files").kind, "not-found"); // needs >= 1 segment
  assert.equal(r.match("GET", "/files/").kind === "match", true); // one empty segment
  assert.throws(() => new Router<string>().add("GET", "/a/*/b", "x"));
});

test("wildcard registered first masks later routes (why it goes last)", () => {
  const r = new Router<string>();
  r.add("GET", "/files/*", "catch-all");
  r.add("GET", "/files/readme", "readme");
  assert.equal(pick(r.match("GET", "/files/readme")), "catch-all");
});

// ---- Query is separate from routing ----

test("query parsing: repeated keys are kept, scalar() rejects repeats", () => {
  const q = parseQuery(new URLSearchParams("city=a&city=b&sort=name&page="));
  assert.deepEqual(q["city"], ["a", "b"]);
  assert.deepEqual(scalar(q, "city"), { ok: false });
  assert.deepEqual(scalar(q, "sort"), { ok: true, value: "name" });
  assert.deepEqual(scalar(q, "missing"), { ok: true, value: undefined });
  assert.deepEqual(scalar(q, "page"), { ok: true, value: "" });
  // The router only ever sees the pathname, so a query cannot change dispatch.
  assert.equal(pick(build().match("GET", "/events")), "list");
});

test("HEAD: an exact HEAD route wins over GET in either registration order", () => {
  for (const headFirst of [true, false]) {
    const r = new Router<string>();
    if (headFirst) { r.add("HEAD", "/x", "head"); r.add("GET", "/x", "get"); }
    else { r.add("GET", "/x", "get"); r.add("HEAD", "/x", "head"); }
    assert.equal(pick(r.match("HEAD", "/x")), "head");
    assert.equal(pick(r.match("GET", "/x")), "get");
  }
});

test("wildcard never yields '..' or an encoded slash", () => {
  const r = new Router<string>();
  r.add("GET", "/files/*", "catch-all");
  assert.equal(r.match("GET", "/files/..%2F..%2Fetc").kind, "not-found");
  assert.equal(r.match("GET", "/files/a/%2E%2E/b").kind, "not-found");
  assert.equal(r.match("GET", "/files/a%2Fb").kind, "not-found");
  assert.equal(r.match("GET", "/files/a/b").kind, "match");
});
