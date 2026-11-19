import type { IncomingMessage } from "node:http";

// JSON request-body boundary (lecture 07): bytes -> UTF-8 text -> parsed value.
// Pure with respect to the response: it returns a decision, the caller sends it.

export const MAX_BODY_BYTES = 16 * 1024;

export type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 | 415; error: string };

// Strict decoder: invalid UTF-8 throws instead of becoming U+FFFD. A leading BOM
// is kept (ignoreBOM) so JSON.parse rejects it: RFC 8259 forbids a BOM on the wire.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Policy: media type must be application/json; a charset parameter, if present,
// must be utf-8 (the only JSON encoding we accept).
export function isJsonContentType(header: string | undefined): boolean {
  const [type, ...params] = (header ?? "").split(";").map((p) => p.trim());
  if (type?.toLowerCase() !== "application/json") return false;
  for (const p of params) {
    const m = /^charset\s*=\s*"?([^"]*)"?$/i.exec(p);
    if (m && m[1]?.toLowerCase() !== "utf-8") return false;
  }
  return true;
}

// Only an uncompressed body is understood; gzip bytes would otherwise reach the parser.
export function isIdentityEncoding(header: string | undefined): boolean {
  const v = (header ?? "").trim().toLowerCase();
  return v === "" || v === "identity";
}

// Resolves with the raw bytes, or null if they exceed `limit`. Rejects when the
// client aborts before the body is complete (so the handler never hangs).
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks)); // decode only after all chunks: a character may span chunks
    });
    req.on("error", (err) => {
      settled = true;
      reject(err);
    });
    req.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("request aborted"));
      }
    });
  });
}

export async function readJsonBody(req: IncomingMessage): Promise<JsonResult> {
  if (!isJsonContentType(req.headers["content-type"])) {
    return { ok: false, status: 415, error: "Content-Type must be application/json (charset utf-8)" };
  }
  if (!isIdentityEncoding(req.headers["content-encoding"])) {
    return { ok: false, status: 415, error: "Content-Encoding is not supported" };
  }
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "Payload Too Large" };
  }
  const bytes = await readBody(req, MAX_BODY_BYTES);
  if (bytes === null) return { ok: false, status: 413, error: "Payload Too Large" };

  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { ok: false, status: 400, error: "Body is not valid UTF-8" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Malformed JSON" };
  }
}
