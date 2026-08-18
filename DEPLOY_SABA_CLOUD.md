# SABA Manager — Cloudflare Pages + Supabase Deployment

## Architecture

SABA Manager runs fully online with no Windows computer or Docker container required in production.

| Layer | Service | Responsibility |
|---|---|---|
| Frontend | Cloudflare Pages | Arabic SABA Manager interface, browser PDF/CSV export, Supabase login |
| Backend | Supabase Edge Function `api` | RouterOS API client, encrypted credential handling, import/report APIs |
| Database | Supabase PostgreSQL | Routers, templates, catalogs, batches, checkpoints, report jobs and report rows |
| File storage | Supabase Storage | Private scripts and generated batch artifacts |
| Source and updates | GitHub | Every push can trigger a fresh Cloudflare Pages deployment |

> Cloudflare Pages only builds and serves the frontend. The backend is the Supabase Edge Function; no Docker production runtime is required.

## 1. Create the Supabase project

Create a new Supabase project. Under **Project Settings → API**, copy:

- Project URL
- `anon` public key

Under **Authentication → Providers → Email**, enable email/password. For a personal deployment you may turn off email confirmation during testing, then enable it before sharing the application.

## 2. Create the encryption secret

Generate a 32-byte hexadecimal key:

```bash
openssl rand -hex 32
```

Store it only in Supabase Edge Function secrets:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set ENCRYPTION_KEY=YOUR_64_CHARACTER_HEX_KEY
```

Do not place `ENCRYPTION_KEY`, router passwords, or the Supabase service-role key in Cloudflare Pages or the GitHub repository.

## 3. Apply the database migrations

Apply both migrations in order to an empty Supabase project:

```bash
supabase db push
```

The second migration adds SABA catalogs, encrypted batches, import checkpoints, private `saba-artifacts` storage, and report-job tables. All tables are protected by Row Level Security and are scoped to the signed-in Supabase user.

## 4. Deploy the Supabase backend

```bash
supabase functions deploy api
```

Test the health endpoint:

```bash
curl https://YOUR_PROJECT_REF.supabase.co/functions/v1/api/health \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

## 5. Configure MikroTik for cloud access

Each router must have a stable public IP or DDNS hostname reachable from the internet. Use a dedicated restricted API user and **API-SSL only**:

```routeros
/certificate add name=saba-api-cert common-name=router.example.net key-usage=tls-server
/certificate sign saba-api-cert
/ip service set api disabled=yes
/ip service set api-ssl disabled=no port=8729 certificate=saba-api-cert
```

Create a dedicated account with only the permissions required by SABA Manager. Do not use the main administrator account. Configure firewall rules appropriate for your network and monitor RouterOS logs. In SABA Manager, add the router using its DDNS/IP, port `8729`, and **Use API-SSL** enabled.

## 6. Configure and deploy Cloudflare Pages

In the GitHub repository, Cloudflare Pages build configuration is:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | `frontend` |
| Build command | `npm run build` |
| Build output directory | `dist` |

Add these **build-time** environment variables in Cloudflare Pages:

```text
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_FUNCTION_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/api
VITE_SUPABASE_ANON_KEY=YOUR_ANON_PUBLIC_KEY
```

These values are public frontend configuration. Do not add the service-role key or `ENCRYPTION_KEY` to Cloudflare Pages.

## 7. First use

1. Open the Cloudflare Pages URL and create the first SABA Manager account.
2. Add one MikroTik device with API-SSL and use **Test connection**.
3. Synchronize customers and profiles once; they are stored in Supabase and reused locally in the frontend.
4. Use the generator and library normally.
5. In **Report**, select a date range and press **Load report from MikroTik**.

The report page does not connect on open. When started manually, it creates a Supabase report job and processes one calendar day at a time. Every completed day is checkpointed in `report_jobs` and rows are persisted in `report_rows`; a browser refresh or short worker request cannot discard already completed days.

## GitHub update flow

Make and test changes locally, then push to the connected GitHub production branch:

```bash
git add .
git commit -m "SABA Manager cloud update"
git push origin main
```

Cloudflare Pages rebuilds the frontend after the push. Deploy the Supabase function and database migration separately whenever files under `supabase/` change.

## Important operational limits

Supabase Free projects may pause after low activity. Keep encrypted database/file backups and check Supabase email warnings. Large reports are deliberately split into daily worker requests to avoid the old Edge Function timeout pattern. If a single day still exceeds a platform limit, use a narrower date range or reduce router-side session data before re-running that day.
