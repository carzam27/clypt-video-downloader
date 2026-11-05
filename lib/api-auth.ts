import { timingSafeEqual } from 'crypto';

/**
 * Bearer-token guard for endpoints meant to be called by scripts (e.g. iOS Shortcuts).
 * The endpoint stays disabled (503) until CLYPT_API_TOKEN is set, so a deploy never exposes it by accident.
 * Returns a Response to send back when the request must be rejected, or null when it is allowed.
 */
export function rejectUnlessAuthorized(req: Request): Response | null {
  const expected = process.env.CLYPT_API_TOKEN;
  if (!expected) return Response.json({ error: 'Quick endpoint is disabled: set CLYPT_API_TOKEN on the server.' }, { status: 503 });

  const given = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
