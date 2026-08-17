# Obaid Manager

Obaid Manager is a React and Supabase application for generating, managing, and exporting MikroTik User Manager cards.

## What the application synchronizes

The application intentionally synchronizes **only** the current list of **User Manager customers** and **profiles** from each configured MikroTik router. It does not request, store, display, or expose individual User Manager users, online sessions, traffic counters, or session-history records.

The current deployment path uses the following components:

| Component | Purpose |
|---|---|
| `frontend/` | React, TypeScript, and Vite client application deployed to Cloudflare Pages. |
| `supabase/migrations/` | A single clean Supabase schema baseline. |
| `supabase/functions/api/` | The only deployed backend. It authenticates users, communicates with MikroTik routers, and stores profile/customer snapshots. |

## Development

Install the frontend dependencies and run the development server:

```bash
pnpm install
pnpm dev
```

Create `frontend/.env` from `frontend/.env.example` and set the Supabase URL, Edge Function URL, and anonymous key before starting the client.

## Database model

Each router has one current record in `router_sync_snapshots`. The record contains JSON arrays of customers and profiles and is replaced whenever the user runs a manual synchronization. This keeps the database small and avoids retaining sensitive user and session data.

## Deployment

Read [DEPLOY_SUPABASE.md](DEPLOY_SUPABASE.md) for the clean-project deployment procedure. The migration in this repository is a baseline schema and must be applied to an empty Supabase project or a deliberately reset development database.

> The Edge Function needs network access to the MikroTik router. A router available only on a private LAN must be reached through a public address with appropriate firewall controls or a private network tunnel such as Tailscale.
