# Abiedien Backoffice

Dashboard backoffice frontend, separate from LAND and Telegram Bot. This package is frontend-only; backend endpoints are external.

## Scope
- Overview
- Members
- Domains
- Tickets
- Payments / Gaji
- Notifications placeholder
- Audit placeholder
- Bot Status placeholder

## Backend contract currently used
- GET /api/stats
- GET /api/users
- GET /api/tickets
- GET /api/payments

The dashboard does not contain Supabase SQL/config/sync controls and does not invent traffic data.

## Run
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
```

## Build note
The dashboard package does not bundle or own a backend server. API calls use the configured `VITE_BACKOFFICE_API_URL` or same-origin `/api/*`.
