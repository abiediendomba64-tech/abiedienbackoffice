# Diagnostics Decisions — index.html / src/index.css

> Status: DECIDED. Records why the remaining Microsoft Edge Tools
> (webhint) diagnostics are **intentionally kept**, and how the
> Cloudflare / Supabase / GitHub platforms relate.
> See config: `.hintrc.json` (strict JSON — no comments allowed inside it,
> which is why this rationale lives here instead).

---

## 1. Remaining diagnostics and verdicts

### index.html

| Diagnostic | Verdict | Reason |
|---|---|---|
| viewport must not contain `maximum-scale` (Error) | 🛑 KEEP — suppressed via `.hintrc.json` | The embedded Mini-App MUST run fullscreen inside Telegram WebView with pinch-zoom disabled (`index.html:6`). Removing it to satisfy the linter breaks the Telegram embed contract (`window.Telegram.WebApp` + `initData` auth in `src/App.tsx:418-428`). |
| viewport must not contain `user-scalable` (Error) | 🛑 KEEP — suppressed via `.hintrc.json` | Same as above. |
| `meta[name=theme-color]` unsupported in Firefox (Warning) | 🛑 KEEP — suppressed via `.hintrc.json` | `theme-color` targets the mobile Telegram WebView shell. Firefox-desktop non-support is irrelevant to the target client. |

Note: `meta-viewport` is turned **off entirely** (not option-tuned), because
the exact option schema cannot be validated in this environment and a wrong
option would break the whole webhint config. The viewport line is a fixed
one-liner in a hand-maintained Mini-App shell — negligible regression risk.
Revisit if the shell ever grows dynamic viewport handling.

### src/index.css

| Diagnostic | Verdict | Reason |
|---|---|---|
| `-webkit-overflow-scrolling` unsupported (lines 32, 129) | 🛑 KEEP — suppressed via `.hintrc.json` | iOS-only momentum scrolling for the primary client (Telegram iOS WebView). Harmless where ignored. Annotated inline in `src/index.css`. |
| `scrollbar-width` unsupported in Safari/Samsung iOS (line 78) | 🛑 KEEP — suppressed via `.hintrc.json` | Progressive enhancement: unsupported browsers fall back to the default scrollbar. Annotated inline in `src/index.css`. |

Already fixed (no longer firing): `-webkit-text-size-adjust` removed,
all 4 `backdrop-filter` orderings corrected, dead Tailwind v4 `selection:`
classes replaced with a real `::selection` rule, `bg-[#060d17]` → `bg-navy-900`,
`lang="en"` → `lang="id"`.

---

## 2. Platform context (Cloudflare / Supabase / GitHub)

### Cloudflare (Pages)
- `public/_headers` already ships a full security header set, including a CSP
  that explicitly allows the synchronous Telegram script
  (`script-src ... https://telegram.org https://*.telegram.org`), Google Fonts,
  Supabase endpoints, and `frame-ancestors ... https://web.telegram.org` —
  i.e. the deploy target **already endorses** the exact `<head>` the linter
  complains about. No `_headers` change needed.
- `public/_redirects` (`/* /index.html 200`) is the SPA fallback — unrelated
  to these diagnostics, verified present.
- No `wrangler.toml`/`wrangler.jsonc` in the repo: this deploys as a **Pages**
  static site (Vite build), not a Worker — so there is no Worker-side config
  that could absorb these client-shell concerns.

### Supabase
- `supabase/config.toml` (`project_id = "abiedienbackoffice"`, API schemas
  `public` + `graphql_public`, `edge_runtime` on, `functions.telegram-auth`
  with `verify_jwt = false` + explicit entrypoint) confirms the backend the
  Mini-App shell talks to — including the `verify-init-data` initData flow
  that depends on the synchronously-loaded Telegram script. Unrelated to CSS
  diagnostics; relevant as the reason the TG script must stay synchronous.

### GitHub
- No `.github/workflows/*.yml` was found in the repo, so these Edge Tools
  diagnostics are **local VS Code Problems-panel items only** — no CI gate
  is failing. The `.hintrc.json` in the repo root is picked up by the
  Microsoft Edge DevTools VS Code extension (webhint-backed Issues tool),
  which is the correct layer to silence them, with this file as the audit
  trail so a future reader never mistakes the suppressions for neglect.
