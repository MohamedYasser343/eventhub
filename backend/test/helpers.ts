import { after, before } from "node:test";
import type { AddressInfo } from "node:net";
import { server, auth } from "../src/server.ts";
import { pool } from "../src/db/pool.ts";
import { resetAll, resetEvents } from "./db.ts";
import type { Role } from "../src/auth.ts";

// Trusted test-only helper: create a synthetic user with any role and log in over HTTP.
let counter = 0;
export async function userToken(base: string, role: Role): Promise<{ id: number; username: string; token: string; password: string }> {
  const username = `t_${role}_${process.pid}_${counter++}`;
  const password = `pw-${username}-0123456789`;
  const created = await auth.createUser(username, password, role);
  if (!created.ok) throw new Error("duplicate test user");
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Anon": "1" },
    body: JSON.stringify({ username, password }),
  });
  const { token } = (await res.json()) as { token: string };
  return { id: created.user.id, username, token, password };
}

// Starts the server on a random port for one test file and stops it afterwards.
// `node --test` runs each file in its own process, so every file needs its own
// server. Call once at the top level of a test file; read `.base` inside tests.
//
// Event/routing tests (lectures 05-07) are about HTTP behavior, not identity, so
// by default `fetch` to this server carries an admin Bearer token. A request
// that sets Authorization itself, or the header X-Test-Anon, is left untouched
// (auth tests use `{ asAdmin: false }` or set their own header).
export function useServer(opts: { asAdmin?: boolean } = {}): { readonly base: string; readonly adminToken: string } {
  const state = { base: "", adminToken: "" };
  const realFetch = globalThis.fetch;
  before(async () => {
    await resetAll();
    await resetEvents(); // the two synthetic events every HTTP test file starts from
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    state.adminToken = (await userToken(state.base, "admin")).token;
    if (opts.asAdmin !== false) {
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (!headers.has("authorization") && !headers.has("x-test-anon")) {
          headers.set("authorization", `Bearer ${state.adminToken}`);
        }
        headers.delete("x-test-anon");
        return realFetch(input, { ...init, headers });
      }) as typeof fetch;
    }
  });
  after(async () => {
    globalThis.fetch = realFetch;
    server.close();
    await pool.end();
  });
  return state;
}
