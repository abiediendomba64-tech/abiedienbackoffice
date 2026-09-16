// @ts-nocheck
/**
 * Shared CORS helper for all Supabase Edge Functions.
 *
 * Rules:
 *  - Exact-match list of allowed origins (localhost dev + production).
 *  - Cloudflare Pages preview deployments validated by subdomain boundary
 *    (must be *.abiedienbackoffice.pages.dev, https only).
 *  - Port policy: EQUIVALENT-ORIGIN. The JS URL API normalizes the default
 *    HTTPS port (:443) to '' — so an explicitly written :443 is treated as the
 *    same origin and allowed. Non-default explicit ports are rejected.
 *  - Request without Origin header (server-to-server / Telegram webhook):
 *    no Access-Control-Allow-Origin header is sent.
 *  - Unknown / disallowed origin: no Access-Control-Allow-Origin header.
 *  - Vary: Origin always added for dynamic responses.
 */

const ALLOWED_ORIGINS: string[] = [
  'https://abiedienbackoffice.pages.dev',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];

const PAGES_APEX = 'abiedienbackoffice.pages.dev';

/**
 * Returns the validated origin to reflect, or null if the origin
 * is absent, unknown, or disallowed.
 */
export function resolveAllowedOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;

  if (ALLOWED_ORIGINS.includes(origin)) return origin;

  try {
    const url = new URL(origin);
    if (
      url.protocol === 'https:' &&
      // Equivalent-origin policy: the URL API normalizes :443 to '', so an
      // explicit default port is allowed while non-default ports are rejected.
      url.port === '' &&
      (url.hostname === PAGES_APEX || url.hostname.endsWith('.' + PAGES_APEX))
    ) {
      return origin;
    }
  } catch {
    // Malformed origin — deny
  }

  return null;
}

/** Static CORS headers common to every response. */
const CORS_STATIC_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token, x-health-secret, x-session-key',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Vary': 'Origin',
};

/**
 * Build CORS headers for a given request.
 * If the origin is not allowed, Access-Control-Allow-Origin is omitted.
 */
export function buildCorsHeaders(req: Request | null | undefined): Record<string, string> {
  const origin = req?.headers?.get('origin') ?? null;
  const allowed = resolveAllowedOrigin(origin);
  return allowed
    ? { 'Access-Control-Allow-Origin': allowed, ...CORS_STATIC_HEADERS }
    : { ...CORS_STATIC_HEADERS };
}

/**
 * Handle an OPTIONS preflight request.
 * Returns 200 with CORS headers if origin is allowed, 403 otherwise.
 */
export function handlePreflight(req: Request): Response {
  const origin = req.headers.get('origin');
  const allowed = resolveAllowedOrigin(origin);
  if (!allowed) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 200,
    headers: { 'Access-Control-Allow-Origin': allowed, ...CORS_STATIC_HEADERS },
  });
}
