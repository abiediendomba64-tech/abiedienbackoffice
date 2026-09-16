# P0.5 Identity Bridge & CORS — Staging Test Matrix

**Status:** DRAFT / STAGING ONLY
**Production deployment:** FROZEN

## Preconditions

- Staging Supabase project/ref is explicitly identified.
- Staging Edge Functions are deployed from the reviewed branch.
- No production endpoint is used by these tests.
- Test accounts/data are disposable and isolated from production.
- `SUPABASE_STAGING_REF` is configured in GitHub repository variables.
- CI Staging Drift Check has passed with no schema drift.
- Endpoint URLs for `telegram-auth` and `backoffice-api-v3` are known.

## 1. CORS — allowed origins

| ID | Request | Expected |
| --- | --- | --- |
| CORS-01 | `Origin: https://abiedienbackoffice.pages.dev` | Exact origin echoed |
| CORS-02 | `Origin: http://localhost:5173` | Allowed only if configured |
| CORS-03 | `Origin: http://localhost:3000` | Allowed only if configured |
| CORS-04 | Valid OPTIONS preflight | Accepted with correct preflight headers |
| CORS-05 | Credentialed request from allowed origin | Credentials allowed |

## 2. CORS — adversarial origins

| ID | Origin | Expected |
| --- | --- | --- |
| CORS-10 | `https://preview-abc.abiedienbackoffice.pages.dev` | Allowed preview |
| CORS-11 | `https://evilabiedienbackoffice.pages.dev` | Rejected |
| CORS-12 | `https://abiedienbackoffice.pages.dev.attacker.com` | Rejected |
| CORS-13 | `http://preview-abc.abiedienbackoffice.pages.dev` | Rejected |
| CORS-14 | `https://preview-abc.abiedienbackoffice.pages.dev:443` | Allowed (equivalent-origin: default HTTPS port) |
| CORS-15 | `Origin: null` | No Access-Control-Allow-Origin |
| CORS-16 | Unrelated HTTPS origin | No Access-Control-Allow-Origin |

### Default-port policy — CORS-14 (decision)

Policy selected: **Equivalent-Origin** (matching `_shared/cors.ts`).

The JS `URL` API normalizes the default HTTPS port to `''`, so `url.port === ''`
cannot distinguish a written `:443` from no port. Under this policy they are the
same origin and both **allowed**. Non-default explicit ports (e.g. `:8443`) are
rejected.

**Note:** the test must infer presence only via the shared helper, never from
`url.port` alone.

## 3. CORS — no Origin

| ID | Request | Expected |
| --- | --- | --- |
| CORS-20 | Server-to-server request with no Origin | No Access-Control-Allow-Origin |
| CORS-21 | Telegram webhook with no Origin | No production-origin fallback |
| CORS-22 | Dynamic origin response | `Vary: Origin` present |

## 4. CORS — invalid preflight

| ID | Test | Expected |
| --- | --- | --- |
| CORS-30 | OPTIONS from unknown origin | 403 or no allow-origin |
| CORS-31 | Disallowed method | Not allowed |
| CORS-32 | Disallowed requested header | Not allowed |
| CORS-33 | Arbitrary Origin reflection | Never reflected |

## 5. Identity — verified email

| ID | Scenario | Expected |
| --- | --- | --- |
| ID-01 | Verified auth email uniquely matches one public user | Eligible for explicit link |
| ID-02 | Verified email has no public user | allowed=false |
| ID-03 | Target public user already linked to another auth UID | Deny / conflict |
| ID-04 | Same UID already linked to same public user | Idempotent success or unchanged |
| ID-05 | Case/whitespace differences | Normalized comparison only |

## 6. Identity — unverified / collision

| ID | Scenario | Expected |
| --- | --- | --- |
| ID-10 | `email_confirmed_at` IS NULL | No automatic linking |
| ID-11 | Duplicate normalized email in `auth.users` | Skip / deny |
| ID-12 | Duplicate normalized email in `public.users` | Skip / deny |
| ID-13 | `auth_user_id` already belongs elsewhere | Deny |
| ID-14 | Auth email changes after link | Existing `auth_user_id` remains authority |
| ID-15 | Authenticated user has no mapping | allowed=false |

## 7. Resolver side-effect test

Run `verify_member_access()` twice with the same authenticated test identity.

**Expected:**

- Resolver returns authorization state.
- `public.users.auth_user_id` does not change.
- Resolver creates no identity-link mutation.
- Any identity write happens only through explicit link operation.

## 8. Identity race test

Run two concurrent `link_identity()` requests with the same auth UID.

**Expected:**

- At most one succeeds.
- The loser gets a deterministic conflict/serialization failure.
- No two public users are linked to one auth UID.
- No partial identity state remains.
- Database unique constraint remains the final guard.

## 9. Audit / RLS

| ID | Scenario | Expected |
| --- | --- | --- |
| AUD-01 | Successful identity mutation | Canonical audit row exists |
| AUD-02 | Failed identity mutation | No partial update |
| AUD-03 | Unauthorized audit read | Denied |
| AUD-04 | Required audit write fails | Mutation fails atomically |

## 10. RPC privilege checks

Verify `EXECUTE` grants using the exact RPC signature.

**Expected:**

- User-facing business RPCs: only required roles.
- Internal/worker RPCs: trusted role only.
- No accidental `anon` execution for protected functions.
- `SECURITY DEFINER` functions use empty search path.

## 11. Migration checks

Before staging:

```bash
supabase migration list --linked
supabase db diff --linked
```

**Expected:** linked history is intentional; no unexpected schema drift.

After staging migration:

```bash
supabase migration list --linked
supabase db diff --linked
```

**Expected:** expected migration state; no unexpected schema drift.

## 12. Type / contract checks

```bash
npm ci
npm run typecheck
npm run lint
npm run build
```

**Expected:** all checks pass; frontend DTO matches API dispatcher payload; RPC signatures match deployed definitions.

## 13. Staging smoke

### `telegram-auth`

- Allowed origin works.
- Disallowed origin is not reflected.
- Preflight behaves correctly.
- No-Origin webhook works without CORS allow-origin.

### `backoffice-api-v3`

- Allowed origin works.
- Disallowed origin is not reflected.
- Preflight behaves correctly.
- Authenticated actor resolution works.
- Request parameters cannot elevate role.

### Identity

- Explicit link succeeds for verified, unique identity.
- Unverified email is rejected.
- Collision is rejected.
- Resolver remains side-effect-free.

## Exit criteria

P0.5 staging is **PASS** only when:

1. CI drift check is clean.
2. CORS adversarial tests pass.
3. No-Origin requests receive no fallback allow-origin.
4. Identity collision tests pass.
5. Race test leaves exactly one mapping.
6. Resolver produces no identity mutation.
7. RPC privilege diff is approved.
8. Audit/RLS checks pass.
9. Typecheck/lint/build pass.
10. Staging smoke passes.
11. Production remains untouched.
