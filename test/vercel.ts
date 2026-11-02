// Vercel's request context, where @vercel/functions looks for it, so what
// API routes leave running after they've answered (with `waitUntil`) can be
// waited for, as Vercel would before freezing the function.

const pending: Promise<void>[] = [];

const context = {
  waitUntil<T>(promise: Promise<T>) {
    pending.push(promise.then(() => undefined));
  },
};

export function installRequestContext() {
  Object.defineProperty(globalThis, Symbol.for("@vercel/request-context"), {
    value: { get: () => context },
    configurable: true,
  });
}

/** Waits for everything passed to `waitUntil`, including what that starts. */
export async function afterResponse() {
  while (pending.length) await Promise.all(pending.splice(0));
}
