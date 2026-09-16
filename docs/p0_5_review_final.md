# P0.5 Review Final

**Status:** PATCH REQUIRED → STAGING REVIEW

Production remains **FROZEN**. P0.5 is not approved for production deployment.

## 1. Webhint / `.hintrc.json`

**Status:** PASS / NO CHANGE

The inspected project `.hintrc.json` contains no `$schema` property.

**Decision:** DO NOT MODIFY `.hintrc.json`. The `$schema` configuration error is therefore treated as an IDE/extension tooling issue, not a project configuration defect based on the inspected file.

## 2. CORS

**Status:** PATCH REQUIRED

Required design:

- central helper at `supabase/functions/_shared/cors.ts`
- reused by `telegram-auth` and `backoffice-api-v3`
- explicit exact origins
- controlled preview subdomains
- hostname boundary validation
- HTTPS-only preview
- empty URL port for preview
- no arbitrary Origin reflection
- `Vary: Origin`
- no `Access-Control-Allow-Origin` when Origin is absent
- no production-origin fallback
- explicit OPTIONS handling

Recommended preview rule:

```ts
const apex = 'abiedienbackoffice.pages.dev';

const isPreview =
  url.protocol === 'https:' &&
  url.port === '' &&
  (url.hostname === apex ||
   url.hostname.endsWith(`.${apex}`));
```

Must reject:

- `https://evilabiedienbackoffice.pages.dev`
- `https://abiedienbackoffice.pages.dev.attacker.com`
- `http://preview-abc.abiedienbackoffice.pages.dev`

### CORS-14 — default port policy (decision)

Policy selected: **Equivalent-Origin** (matching `_shared/cors.ts`).

`new URL('https://preview.example.com:443').port` normalizes to `''`, so
`url.port === ''` cannot prove a written `:443`. Therefore an explicit default
HTTPS port is treated as the same origin and allowed; non-default explicit ports
are rejected. The test must not infer port presence from `url.port` alone.

## 3. Identity Bridge

**Status:** REJECT AS-IS / PATCH REQUIRED

Required schema:

- `public.users.auth_user_id` UUID
- UNIQUE
- FK → `auth.users(id)`
- `ON DELETE SET NULL`

Prefer an explicit named unique constraint. Do not add a redundant index solely because the column is unique.

Migration should set:

```sql
SET lock_timeout = '5s';
SET statement_timeout = '60s';
```

## 4. Safe email backfill

Backfill is allowed only for a one-to-one normalized email match.

Required guards:

- non-null / non-empty emails
- `lower(trim(email))`
- `auth.users.email_confirmed_at` IS NOT NULL
- one unique auth identity per normalized email
- one eligible public user per normalized email
- existing `auth_user_id` never overwritten
- ambiguous matches skipped / denied
- database uniqueness is final race protection

Current review reported no observed production collisions, but guards remain mandatory.

## 5. Resolver / Identity linking

`verify_member_access()` must remain resolver/read-oriented.

- It must not update `public.users.auth_user_id`.
- Unmapped authenticated users fail closed.

`link_identity()` — identity mutation belongs in a separate explicit operation:

- authenticated identity
- verified email
- unique normalized match
- target unlinked
- auth UID unused elsewhere
- atomic update
- audit

## 7. CI / staging drift

The manual drift workflow is accepted as a staging gate because it is separate from deployment and does not run `db push`.

Required logic:

- resolve staging ref
- verify staging ref
- `supabase link`
- migration list
- `db diff`
- fail on drift
- publish diff artifact

`SUPABASE_STAGING_REF` should be authoritative for preventing accidental environment targeting.

## 8. Non-blocking findings

GitHub Actions secrets syntax — use dot notation to remove the linter warning:

```yaml
SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
SUPABASE_PROJECT_ID: ${{ secrets.SUPABASE_PROJECT_ID || vars.SUPABASE_PROJECT_ID }}
```

Classification: **WARNING / cleanup**

`meta[name="theme-color"]` — keep it. Classification: **INFO / non-blocking**

## 9. Required staging test categories

The companion file `docs/p0_5_test_matrix.md` covers:

- CORS adversarial
- CORS preflight
- no-Origin
- email verification
- email collision
- `auth_user_id` collision
- identity race
- resolver no-side-effect
- audit
- RLS
- RPC privileges
- migration drift
- typecheck / lint / build
- Edge Function smoke

## 10. Approval gate

P0.5 is not production-approved until all of the following pass:

- CI drift check — PASS
- CORS patch — REVIEWED
- Identity migration — REVIEWED
- Backfill guards — REVIEWED
- `link_identity()` — REVIEWED
- Resolver read-only test — PASS
- Privilege diff — PASS
- Negative auth tests — PASS
- Race test — PASS
- Audit/RLS tests — PASS
- Typecheck / lint / build — PASS
- Staging smoke — PASS

Production: **FROZEN**.

## Final decision

- P0.5 = PATCH REQUIRED
- STAGING = PENDING
- PRODUCTION = FROZEN

No production migration, Edge Function deployment, or irreversible identity backfill is authorized by this document.
