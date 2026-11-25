import type { Server } from "node:http";
import { sleep } from "./shutdown.ts";
import type { ShutdownStep } from "./shutdown.ts";

// Lecture 19: the HTTP part of the shutdown sequence on the native node:http Server.
//
// 1. wait `drainDelayMs` with the listener STILL OPEN but readiness answering "draining",
//    so a load balancer can stop routing here before the socket disappears (default 0 = off);
// 2. server.close(): stop accepting new connections; the callback fires when every
//    connection has ended;
// 3. keep-alive connections that became idle are closed (Node only closes the ones that were
//    idle at the moment of close()); in-flight requests are left alone to finish.
export function httpShutdownSteps(server: Server, drainDelayMs: number): ShutdownStep[] {
  return [
    ...(drainDelayMs > 0 ? [{ name: "drain-delay", run: () => sleep(drainDelayMs) }] : []),
    {
      name: "http-close",
      run: () =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve(); // signal before listen(): nothing to stop
          const poll = setInterval(() => server.closeIdleConnections(), 25);
          poll.unref();
          server.close((err) => {
            clearInterval(poll);
            if (err) reject(err);
            else resolve();
          });
          server.closeIdleConnections();
        }),
    },
  ];
}

// What the deadline does to work that did not finish: destroy the sockets. The client sees a
// connection reset, the same as if the process had been killed, but the log says so first.
export const forceCloseConnections = (server: Server): void => server.closeAllConnections();
