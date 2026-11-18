// A small handwritten router. It maps (method, pathname) to a handler and
// extracts path parameters. It knows nothing about HTTP objects or data: it
// takes strings and returns a decision, so it needs no database and is unit
// testable on its own. A handler that cannot find "event 42" is a handler
// failure (404 from the handler), not a routing miss.
//
// Matching policy (see ADR-005):
// - Routes are tried in registration order; the first route whose path AND
//   method match wins. A static route registered later does not beat a dynamic
//   one registered earlier unless the dynamic one has a constraint.
// - Segments are split on "/" first and percent-decoded once afterwards, so
//   "%2F" stays inside one segment and cannot change segmentation.
// - A malformed percent escape is reported as "bad-request", not as a crash.
// - Matching is case-sensitive; there is no trailing-slash or empty-segment
//   normalisation ("/events/" and "/events//1" simply do not match).
// - HEAD is served by a GET route unless a HEAD route is registered.

export type Constraints = Record<string, RegExp>;

type Segment =
  | { kind: "static"; value: string }
  | { kind: "param"; name: string }
  | { kind: "wildcard" };

interface Route<H> {
  method: string;
  segments: Segment[];
  constraints: Constraints;
  handler: H;
  prefix: string;
}

export type MatchResult<H> =
  | {
      kind: "match";
      handler: H;
      params: Record<string, string>;
      // Allowed methods for this path, canonical order ("GET, HEAD, ...").
      allow: string;
      prefix: string;
    }
  | { kind: "method-not-allowed"; allow: string }
  | { kind: "not-found" }
  | { kind: "bad-request" };

const METHOD_ORDER = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function compile(path: string): Segment[] {
  if (!path.startsWith("/")) throw new Error(`route must start with "/": ${path}`);
  const parts = path.slice(1).split("/");
  return parts.map((part, i) => {
    if (part === "*") {
      if (i !== parts.length - 1) throw new Error(`"*" must be the last segment: ${path}`);
      return { kind: "wildcard" } as const;
    }
    if (part.startsWith(":")) return { kind: "param", name: part.slice(1) } as const;
    return { kind: "static", value: part } as const;
  });
}

function matchSegments<H>(
  route: Route<H>,
  segs: string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i++) {
    const seg = route.segments[i]!;
    if (seg.kind === "wildcard") {
      // One or more remaining segments; the value is the decoded segments
      // joined with "/". Handlers must not treat it as a file path unchecked.
      if (segs.length <= i) return null;
      params["*"] = segs.slice(i).join("/");
      return params;
    }
    const actual = segs[i];
    if (actual === undefined) return null;
    if (seg.kind === "static") {
      if (actual !== seg.value) return null;
    } else {
      if (actual === "") return null; // empty id never matches
      const constraint = route.constraints[seg.name];
      if (constraint && !constraint.test(actual)) return null;
      params[seg.name] = actual;
    }
  }
  return segs.length === route.segments.length ? params : null;
}

export interface Registrar<H> {
  add(method: string, path: string, handler: H, constraints?: Constraints): void;
}

export class Router<H> implements Registrar<H> {
  private routes: Route<H>[] = [];

  add(method: string, path: string, handler: H, constraints: Constraints = {}): void {
    this.addWithPrefix("", method, path, handler, constraints);
  }

  // Routes added through a group share a path prefix such as "/api/v1".
  group(prefix: string): Registrar<H> {
    if (prefix !== "" && (!prefix.startsWith("/") || prefix.endsWith("/"))) {
      throw new Error(`invalid group prefix: ${prefix}`);
    }
    return {
      add: (method, path, handler, constraints = {}) =>
        this.addWithPrefix(prefix, method, path, handler, constraints),
    };
  }

  private addWithPrefix(
    prefix: string,
    method: string,
    path: string,
    handler: H,
    constraints: Constraints,
  ): void {
    this.routes.push({
      method,
      segments: compile(prefix + path),
      constraints,
      handler,
      prefix,
    });
  }

  match(method: string, pathname: string): MatchResult<H> {
    let segs: string[];
    try {
      segs = pathname.slice(1).split("/").map((s) => decodeURIComponent(s));
    } catch {
      return { kind: "bad-request" };
    }

    const methods = new Set<string>();
    let found: { route: Route<H>; params: Record<string, string> } | undefined;
    for (const route of this.routes) {
      const params = matchSegments(route, segs);
      if (!params) continue;
      methods.add(route.method);
      if (route.method === "GET") methods.add("HEAD");
      const fits =
        route.method === method || (method === "HEAD" && route.method === "GET");
      if (fits && !found) found = { route, params };
    }

    const allow = [
      ...METHOD_ORDER.filter((m) => methods.has(m)),
      ...[...methods].filter((m) => !METHOD_ORDER.includes(m)),
    ].join(", ");

    if (found) {
      return {
        kind: "match",
        handler: found.route.handler,
        params: found.params,
        allow,
        prefix: found.route.prefix,
      };
    }
    return methods.size > 0 ? { kind: "method-not-allowed", allow } : { kind: "not-found" };
  }
}

// Query policy (see ADR-005): the query string never takes part in route
// matching. Every key maps to the list of its values, in order.
export type Query = Record<string, string[]>;

export function parseQuery(params: URLSearchParams): Query {
  const query: Query = Object.create(null) as Query;
  for (const [key, value] of params) {
    (query[key] ??= []).push(value);
  }
  return query;
}

// Scalar parameter: absent is fine, exactly one value is fine, a repeated key
// is rejected (ambiguous) rather than guessing "first" or "last".
export function scalar(
  query: Query,
  key: string,
): { ok: true; value: string | undefined } | { ok: false } {
  const values = query[key];
  if (values === undefined) return { ok: true, value: undefined };
  if (values.length !== 1) return { ok: false };
  return { ok: true, value: values[0] };
}
