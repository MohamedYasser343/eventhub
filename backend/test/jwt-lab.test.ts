import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJwt } from "jose";
import { AUDIENCE, ISSUER, claimsOnlyCanCreate, issue, trustedCanCreate, verify } from "../experiments/jwt-lab.ts";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("claims are readable without any secret (a JWT is signed, not encrypted)", async () => {
  const claims = decodeJwt(await issue("u1", "organizer"));
  assert.equal(claims["role"], "organizer");
  assert.equal(claims.sub, "u1");
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.aud, AUDIENCE);
});

test("changing the role claim without re-signing is rejected", async () => {
  const [h, , sig] = (await issue("u1", "attendee")).split(".");
  const forged = `${h}.${b64({ sub: "u1", role: "admin", iss: ISSUER, aud: AUDIENCE, exp: 4102444800 })}.${sig}`;
  await assert.rejects(verify(forged), /signature/i);
});

test("alg none and a different HMAC algorithm are rejected", async () => {
  const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "u1", role: "admin", iss: ISSUER, aud: AUDIENCE })}.`;
  await assert.rejects(verify(none));
  await assert.rejects(verify(await issue("u1", "admin", { alg: "HS512" })), /alg/i);
});

test("a token signed with another key, issuer or audience is rejected", async () => {
  await assert.rejects(verify(await issue("u1", "admin", { key: new Uint8Array(32).fill(1) })), /signature/i);
  await assert.rejects(verify(await issue("u1", "admin", { iss: "someone-else" })), /iss/);
  await assert.rejects(verify(await issue("u1", "admin", { aud: "other-api" })), /aud/);
});

test("expiry with a controlled clock: valid just before, rejected after", async () => {
  const t0 = new Date("2026-11-19T10:00:00Z");
  const token = await issue("u1", "organizer", { ttlSeconds: 300, now: t0 });
  assert.ok(await verify(token, new Date(t0.getTime() + 299_000)));
  await assert.rejects(verify(token, new Date(t0.getTime() + 301_000)), /exp/);
});

test("STALE ROLE: claims-only policy keeps allowing a demoted user; current-role lookup denies", async () => {
  const roles = new Map([["u1", "organizer"]]);
  const token = await issue("u1", "organizer");
  assert.equal(await claimsOnlyCanCreate(token), true);
  assert.equal(await trustedCanCreate(token, roles), true);
  roles.set("u1", "attendee"); // demoted; the token in the client's hands is unchanged
  assert.equal(await claimsOnlyCanCreate(token), true, "lab failure: stale claim still honored");
  assert.equal(await trustedCanCreate(token, roles), false, "trusted lookup denies");
});

test("client-only logout does not revoke an unexpired JWT; a shorter lifetime only narrows the window", async () => {
  const t0 = new Date("2026-11-19T10:00:00Z");
  let clientStorage: string | null = await issue("u1", "organizer", { ttlSeconds: 300, now: t0 });
  const stolen = clientStorage;
  clientStorage = null; // "logout": client discards its copy; the server was never told
  assert.equal(clientStorage, null);
  assert.ok(await verify(stolen, new Date(t0.getTime() + 120_000))); // still valid
  await assert.rejects(verify(stolen, new Date(t0.getTime() + 301_000))); // dies only at exp
  const short = await issue("u1", "organizer", { ttlSeconds: 30, now: t0 });
  await assert.rejects(verify(short, new Date(t0.getTime() + 31_000)));
});
