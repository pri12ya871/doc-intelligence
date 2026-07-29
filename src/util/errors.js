/**
 * Produces a human-readable message for an error.
 *
 * A refused TCP connection arrives as an AggregateError with an empty top-level
 * message and one sub-error per resolved address, so plain `err.message` logs
 * as an empty string and tells an operator nothing about what broke.
 */
export function describeError(err) {
  if (err?.errors?.length) {
    const inner = err.errors.find((e) => e?.message || e?.code) ?? err.errors[0];
    return inner?.message || inner?.code || String(inner);
  }
  return err?.message || err?.code || String(err);
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EAI_AGAIN',
]);

/**
 * True when the failure is "the dependency isn't reachable" rather than a bug
 * in the request. These deserve a 503 with a plain explanation — returning a
 * generic 500 for an unstarted database sends people hunting through their own
 * code for a problem that is really just missing infrastructure.
 */
export function isConnectionError(err) {
  if (!err) return false;
  if (CONNECTION_CODES.has(err.code)) return true;
  if (err.errors?.length) return err.errors.some((inner) => CONNECTION_CODES.has(inner?.code));
  return CONNECTION_CODES.has(describeError(err).match(/E[A-Z]+/)?.[0]);
}
