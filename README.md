# Abiedien Backoffice

Enterprise administrative backoffice dashboard for managing Abiedien platform users, domains, operational tickets, payouts, and system logs.

## Integrations & Services

### 1. Supabase (Database & Auth)
- **Database & Auth**: Connects to Supabase PostgreSQL database and Supabase Auth (`/auth/v1/token` or Edge Function `/login`).
- **Edge API**: Communicates with Supabase Edge Functions (`backoffice-api-v3`) for secure role-based access control (`dashboard_access`).
- **Environment Variables**:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
  - `VITE_BACKOFFICE_API_URL`

### 2. Telegram Bot Integration
- **Bot Monitoring**: Displays operational status and chat stats from Telegram Bot API (`@AbiedOpsBot`).
- **Notifications**: Tracks and audits notification dispatch logs.
- **Environment Variable**: `TELEGRAM_BOT_TOKEN`

### 3. GitHub Workflow & Repository
- **Version Control**: Managed via GitHub repository (`abiedienbackoffice`).
- **CI/CD**: Standard Vite build checks and automated deployment pipelines.

### 4. Cloudflare Pages Deployment
- **Hosting**: Optimized for static deployment on Cloudflare Pages.
- **Build Output**: `dist/` directory generated via `npm run build`.
- **SPA Routing**: Single-page application routing configured for Cloudflare static hosting.

## Local Development & Build

```bash
# Install dependencies
npm install

# Run dev server
npm run dev

# Production build

```
