import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthService } from "../src/auth.ts";
import { AccountService } from "../src/modules/auth/service.ts";
import { TicketService } from "../src/modules/tickets/service.ts";
import type { Ticket, TicketRepository } from "../src/modules/tickets/repository.ts";

// Services tested directly: no HTTP server, no request/response objects.

const PW = "correct-horse-battery";
const fresh = () => {
  const auth = new AuthService();
  return { auth, accounts: new AccountService(auth) };
};

test("accounts: register ignores a client-supplied role (always attendee)", async () => {
  const { accounts } = fresh();
  const r = await accounts.register({ username: "alice_1", password: PW, role: "admin" });
  assert.equal(r.ok && r.user.role, "attendee");
  assert.equal(r.ok && "passwordHash" in r.user, false);
});

test("accounts: register rejects bad input and duplicates", async () => {
  const { accounts } = fresh();
  const bad = await accounts.register({ username: "a", password: "short" });
  assert.equal(!bad.ok && bad.kind === "invalid" && bad.details.length, 2);
  assert.equal((await accounts.register("not an object")).ok, false);
  assert.equal((await accounts.register({ username: "bob_1", password: PW })).ok, true);
  const dup = await accounts.register({ username: "BOB_1", password: PW });
  assert.deepEqual(dup, { ok: false, kind: "duplicate" });
});

test("accounts: login success, same outcome for unknown user and wrong password", async () => {
  const { accounts } = fresh();
  await accounts.register({ username: "carol_1", password: PW });
  const ok = await accounts.login({ username: "carol_1", password: PW }, "1.2.3.4");
  assert.equal(ok.ok && ok.user.username, "carol_1");
  const wrong = await accounts.login({ username: "carol_1", password: "x".repeat(14) }, "1.2.3.4");
  const unknown = await accounts.login({ username: "nobody_1", password: PW }, "1.2.3.4");
  assert.deepEqual(wrong, unknown);
  assert.deepEqual(await accounts.login({ username: 5 }, "1.2.3.4"), { ok: false, kind: "invalid-credentials" });
});

test("accounts: repeated failures are rate limited, then logout kills the session", async () => {
  const { auth, accounts } = fresh();
  await accounts.register({ username: "dave_1", password: PW });
  for (let i = 0; i < 5; i++) await accounts.login({ username: "dave_1", password: "wrong-wrong-wrong" }, "9.9.9.9");
  const limited = await accounts.login({ username: "dave_1", password: PW }, "9.9.9.9");
  assert.equal(!limited.ok && limited.kind, "rate-limited");
  // another client address is unaffected
  const other = await accounts.login({ username: "dave_1", password: PW }, "8.8.8.8");
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.ok(auth.authenticate(other.token));
  accounts.logout(other.token);
  assert.equal(auth.authenticate(other.token), null);
});

class FakeTickets implements TicketRepository {
  data = new Map<number, Ticket[]>([[1, [{ ticketId: "T-1-1", eventId: 1 }]], [2, [{ ticketId: "T-9-1", eventId: 9 }]]]);
  findByUser(id: number) { return this.data.get(id) ?? []; }
}
const events = { get: (id: number) => (id === 1 ? { id: 1, name: "E", seats: 2 } : id === 2 ? { id: 2, name: "F", seats: 50 } : undefined) };

test("tickets: only own tickets; others' look missing", () => {
  const svc = new TicketService(new FakeTickets(), events);
  assert.equal(svc.mine(1).length, 1);
  assert.deepEqual(svc.mine(3), []);
  assert.ok(svc.ownedById(1, "T-1-1"));
  assert.equal(svc.ownedById(1, "T-9-1"), undefined);
});

test("tickets: synthetic event tickets capped at 3; unknown event is undefined", () => {
  const svc = new TicketService(new FakeTickets(), events);
  assert.equal(svc.forEvent(1)?.length, 2);
  assert.equal(svc.forEvent(2)?.length, 3);
  assert.equal(svc.forEvent(77), undefined);
});
