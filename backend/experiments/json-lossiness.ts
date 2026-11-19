// Lecture 07 experiment: what a JSON round trip loses. Run: npx tsx experiments/json-lossiness.ts
const sample = {
  when: new Date("2026-11-19T10:00:00Z"),
  skipped: undefined,
  fn: () => 1,
  nan: NaN,
  inf: Infinity,
  map: new Map([["a", 1]]),
  nested: [undefined, () => 1],
  neg0: -0,
  big: 2 ** 53 + 1,
};
const back = JSON.parse(JSON.stringify(sample));
console.log("before:", sample);
console.log("after: ", back);
console.log("Date became", typeof back.when, "| undefined key dropped:", !("skipped" in back));
console.log("array undefined/function became:", back.nested);
console.log("precision:", sample.big, "->", back.big, "| 12345678901234567890 parses as", JSON.parse("12345678901234567890"));

try {
  JSON.stringify({ n: 10n });
} catch (e) {
  console.log("BigInt:", (e as Error).message);
}
const circular: Record<string, unknown> = {};
circular["self"] = circular;
try {
  JSON.stringify(circular);
} catch (e) {
  console.log("circular:", (e as Error).message.split("\n")[0]);
}
console.log("UTF-16 length vs UTF-8 bytes of 'Café ☕':", "Café ☕".length, Buffer.byteLength("Café ☕"));
