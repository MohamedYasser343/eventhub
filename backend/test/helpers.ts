import { after, before } from "node:test";
import type { AddressInfo } from "node:net";
import { server } from "../src/server.ts";

// Starts the server on a random port for one test file and stops it afterwards.
// `node --test` runs each file in its own process, so every file needs its own
// server. Call once at the top level of a test file; read `.base` inside tests.
export function useServer(): { readonly base: string } {
  const state = { base: "" };
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
  });
  return state;
}
