import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/health") {
    if (req.method === "GET") {
      sendJson(res, 200, { status: "ok" });
    } else {
      sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "GET" });
    }
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
}

export const server = createServer(handle);

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, "127.0.0.1", () => {
    console.log(`EventHub listening on http://127.0.0.1:${port}`);
  });
}
