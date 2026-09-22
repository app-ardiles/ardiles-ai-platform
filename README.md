# Ardiles AI Platform

Backend/API awal untuk Sekar (Stock Expertise) dan fondasi web control center Ardiles.

## Arsitektur

- PostgreSQL = source of truth
- n8n = ingestion, processor, scheduler, automation
- Vercel / Next.js = web + backend/tool API
- Hermes / Sekar = AI reasoning & tool selection

## Stock API yang tersedia

1. `GET /api/stock/search?q=DRIVE%20XTEND`
2. `GET /api/stock/variants?base_model=PRG-DRIVE%20XTEND`
3. `GET /api/stock/detail?barang=...`
4. `GET /api/stock/by-location?barang=...&lokasi=...`
5. `GET /api/stock/by-accsys?barang=...&accsys=...`
6. `GET /api/stock/location-summary?lokasi=...`
7. `GET /api/stock/status`

Health check:
- `GET /api/health`

## Environment variables

Copy `.env.example` to `.env.local` for local use.

Required:
- `DATABASE_URL`

Optional:
- `ARDILES_API_KEY`: if filled, Stock API requires header `x-ardiles-api-key`.
- `PG_SSL=require`: only if provider requires SSL.

## Deploy

1. Push this project to GitHub repo `ardiles-ai-platform`.
2. Import the repo into Vercel.
3. Add `DATABASE_URL` in Vercel Environment Variables.
4. Optionally add `ARDILES_API_KEY`.
5. Deploy.
6. Test `/api/health`, then `/api/stock/status`.

## Notes

The Stock APIs only read batches with status `PUBLISHED`. They do not INSERT, UPDATE, or DELETE stock data.
