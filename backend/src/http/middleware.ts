import type { IncomingMessage, ServerResponse } from "node:http";

// Minimal async "onion" middleware runner (lecture 10).
//
//   mw1 before -> mw2 before -> handler -> mw2 after -> mw1 after
//
// A middleware either calls `await next()` once to continue, or responds itself
// and returns (short-circuit: nothing downstream runs). Because each stage
// awaits the next, a throw/rejection anywhere downstream surfaces in the nearest
// upstream try/catch, which is how the error boundary works here (no separate
// "error middleware registered last" as in Express).
export type Next = () => Promise<void>;
export type Middleware<C> = (req: IncomingMessage, res: ServerResponse, ctx: C, next: Next) => Promise<void> | void;
export type Handler<C> = (req: IncomingMessage, res: ServerResponse, ctx: C) => Promise<void> | void;

export function compose<C>(
  middleware: Middleware<C>[],
  terminal: Handler<C>,
): (req: IncomingMessage, res: ServerResponse, ctx: C) => Promise<void> {
  return (req, res, ctx) => {
    let last = -1;
    const dispatch = async (i: number): Promise<void> => {
      // Calling next() twice would run the rest of the chain twice (double response).
      if (i <= last) throw new Error("next() called multiple times");
      last = i;
      const mw = middleware[i];
      if (mw === undefined) return void (await terminal(req, res, ctx));
      await mw(req, res, ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}
