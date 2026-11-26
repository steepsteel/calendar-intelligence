# Calendar Intelligence

Calendar Intelligence is a read-only unified calendar prototype for Google Calendar, Microsoft 365, Apple iCloud, and Zoho Calendar.

## Run locally

Use Node.js 22.18 or later.

```sh
npm ci
npm test
npm run dev
```

Open the URL printed by Vite. With no Supabase settings, the dashboard uses synthetic events. It shows provider attribution, groups duplicate copies of an occurrence, flags busy overlaps, and lets you hide titles. Try a Gmail, Outlook, iCloud, or Zoho address in the provider picker. Custom domains can use the manual picker.

Run `npm run build` for type checking and a production bundle. Run `npm run preview` after building to exercise Cloudflare Workers locally, including `GET /api/health`.

## Configure a dedicated Supabase project

1. Apply the SQL migration in `supabase/migrations` to a new Calendar Intelligence Supabase project.
2. In Supabase Auth, disable public signup, provision the initial user, and allowlist the exact deployment origin for sign-in links. For local development, also allowlist the Vite origin when appropriate.
3. Copy `.env.example` to `.env.local`. Set the project URL and public anon key. Restart Vite or rebuild after changing them. The email-link sign-in uses PKCE, so open the link in the same browser profile that requested it.
4. Build and serve the assets with the dedicated Worker. The signed-in agenda queries a rolling 14-day window on page load. On a new database the agenda and connection list are empty.

Keep service-role keys and provider credentials out of client environment variables and Git. The browser can read a limited projection of its user's rows under Supabase RLS. Provider credentials are outside this migration. Private event titles are rejected by the schema. The “Hide titles” toggle affects rendering during the current session.

See [Phase 1 development notes](docs/phase-1.md) for implementation status and decisions.
