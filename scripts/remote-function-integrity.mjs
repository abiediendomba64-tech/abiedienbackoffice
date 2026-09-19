#!/usr/bin/env node
/**
 * Remote Edge Function integrity smoke test.
 *
 * This test intentionally uses no service-role secret. It verifies the public
 * production edge boundary, CORS behaviour, and that telegram-auth reaches its
 * own request handler instead of failing at the network/gateway layer.
 */

const projectRef = (process.env.SUPABASE_PROJECT_REF || 'pnvnpencatzspkwxspac').trim();
const origin = (process.env.INTEGRITY_ORIGIN || 'https://abiedienbackoffice.pages.dev').trim();
const baseUrl = `https://${projectRef}.supabase.co/functions/v1/telegram-auth`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, options = {}) {
  const attempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // Keep raw response for diagnostics.
      }

      if (response.status >= 500 && attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        continue;
      }

      return { response, text, json };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        continue;
      }
    }
  }

  throw new Error(
    `Remote request failed after ${attempts} attempts: ${lastError?.message || String(lastError)}`
  );
}

function requireCors(response, expectedOrigin) {
  assert(
    response.headers.get('access-control-allow-origin') === expectedOrigin,
    `Access-Control-Allow-Origin mismatch: got ${response.headers.get('access-control-allow-origin') || '<missing>'}`
  );
  const allowHeaders = (response.headers.get('access-control-allow-headers') || '').toLowerCase();
  assert(allowHeaders.includes('authorization'), 'CORS allow-headers missing authorization');
  assert(allowHeaders.includes('apikey'), 'CORS allow-headers missing apikey');
}

console.log(`[remote-integrity] project=${projectRef} origin=${origin}`);

const preflight = await request(`${baseUrl}/binding-status`, {
  method: 'OPTIONS',
  headers: {
    Origin: origin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type,apikey',
  },
});
assert(preflight.response.status === 200, `Preflight expected 200, got ${preflight.response.status}: ${preflight.text.slice(0, 300)}`);
requireCors(preflight.response, origin);

const invalid = await request(`${baseUrl}/binding-status`, {
  method: 'POST',
  headers: {
    Origin: origin,
    'Content-Type': 'application/json',
    apikey: 'invalid',
    Authorization: 'Bearer invalid',
  },
  body: '{}',
});
assert(
  invalid.response.status === 401,
  `Invalid auth expected 401, got ${invalid.response.status}: ${invalid.text.slice(0, 300)}`
);
requireCors(invalid.response, origin);
assert(invalid.json && typeof invalid.json === 'object', 'Invalid-auth response is not JSON');

const deniedPreflight = await request(`${baseUrl}/binding-status`, {
  method: 'OPTIONS',
  headers: {
    Origin: 'https://not-allowed.example',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type,apikey',
  },
});
assert(
  deniedPreflight.response.status === 200,
  `Disallowed-origin preflight expected handler response 200, got ${deniedPreflight.response.status}`
);
assert(
  !deniedPreflight.response.headers.get('access-control-allow-origin'),
  'Disallowed origin unexpectedly received Access-Control-Allow-Origin'
);

console.log('[remote-integrity] PASS: CORS preflight, runtime reachability, auth rejection, and origin deny checks all passed.');
