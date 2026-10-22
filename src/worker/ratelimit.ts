// Rate limit for open dynamic client registration (RFC 7591). Anyone may POST /oauth/register,
// and each registration is a row in D1, so without a limit a script could fill the table.
// The limiter is the Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc): no
// resource to create and no charge beyond the request itself. Its counters are per Cloudflare
// location and eventually consistent, which is plenty to stop a flood.
//
// The key is the client's IP. Cloudflare advises against IP keys because people share them,
// but registration happens before there is any user or client to key on, and a real MCP
// client registers once per machine, so a shared office or carrier NAT stays far below it.

export const REGISTER_PATH = '/oauth/register';
/** Matches `simple.period` of REGISTER_LIMITER in wrangler.jsonc. */
export const REGISTER_PERIOD_S = 60;

/**
 * Returns a 429 when this caller has registered too many clients in the current period, or
 * null to let the request through. Fails open: a missing binding or a limiter error never
 * blocks sign-in.
 */
export async function limitRegistration(req: Request, limiter: RateLimit | undefined): Promise<Response | null> {
  if (!limiter || req.method !== 'POST') return null;
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  let success = true;
  try {
    ({ success } = await limiter.limit({ key: `oauth-register|${ip}` }));
  } catch (e) {
    console.error('register rate limiter failed; allowing the request', e);
    return null;
  }
  if (success) return null;
  return new Response(
    JSON.stringify({
      error: 'too_many_requests',
      error_description: `Too many client registrations from this address. Try again in ${REGISTER_PERIOD_S} seconds.`,
    }),
    {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(REGISTER_PERIOD_S), 'cache-control': 'no-store' },
    },
  );
}
