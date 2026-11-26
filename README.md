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

1. Apply the SQL migrations in `supabase/migrations` to a new Calendar Intelligence Supabase project.
2. In Supabase Auth, disable public signup, provision the initial user, and allowlist the exact deployment origin for sign-in links. For local development, also allowlist the Vite origin when appropriate.
3. Copy `.env.example` to `.env.local`. Set the project URL and public anon key. Restart Vite or rebuild after changing them. The email-link sign-in uses PKCE, so open the link in the same browser profile that requested it.
4. Build and serve the assets with the dedicated Worker. The signed-in agenda queries a rolling 14-day window on page load, on focus, and once per minute while visible. On a new database the agenda and connection list are empty.

Keep service-role keys and provider credentials out of client environment variables and Git. The browser can read a limited projection of its user's rows under Supabase RLS. Provider refresh tokens are encrypted by the Worker before database storage. Private event titles are rejected by the schema. The “Hide titles” toggle affects rendering during the current session.

See [Phase 1 development notes](docs/phase-1.md) for implementation status and decisions.


## Private deployment

Use a dedicated CalendarIntel Supabase project and the CalendarIntel Cloudflare zone. Open the [Supabase dashboard](https://supabase.com/dashboard/projects) and [Cloudflare dashboard](https://dash.cloudflare.com/). Disable signups, provision the owner, and allowlist `https://calendarintel.app` for Auth redirects. The owner can sign in with the password set during provisioning. When email delivery is configured for the owner, verify email links on desktop and iPhone. Each device requests and opens its own link in the same browser.

Build with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then configure the same project on the Worker. Install runtime values through the Worker secret store. They belong outside Git and the Vite environment.

| Worker setting | Value |
| --- | --- |
| `APP_ORIGIN` | Defaults to `https://calendarintel.app` in Wrangler |
| `OWNER_USER_ID` | UUID of the provisioned Supabase Auth user |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Same project and public key used for the build |
| `SUPABASE_SERVICE_ROLE_KEY` | Dedicated project's server key |
| `CALENDAR_TOKEN_KEY` | Base64 encoding of 32 cryptographically random bytes. Keep a secure backup with restricted access |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google web OAuth app with Calendar API enabled |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Entra web app registration with delegated Calendar and profile read permissions |
| `APPLE_CALDAV_ENABLED` | Defaults to disabled. Set to `true` for a dedicated iCloud test using an Apple app-specific password |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REGION` | Zoho server-based client in the owner's data center. Region defaults to `us` and supports `eu`, `in`, `au` and `cn` |

Register `https://calendarintel.app/api/calendar/oauth/<provider>/callback` for each configured provider. For Microsoft use a Web redirect and a registration that supports the account types you will connect. For Google keep the consent screen limited to the intended account(s) and account for refresh token expiry in Google's external Testing mode. Configure Zoho for a single region per deployment. The callback rejects grants from a different region.

Verify the bundle with `npx wrangler deploy --dry-run`. Apply the database migrations and complete the Worker configuration before deploying. The production configuration uses the custom domain and disables the public Workers preview hostnames. For iCloud, create a dedicated password in [Apple Account settings](https://account.apple.com/) and enter it in CalendarIntel only after the connector is enabled. The Worker encrypts it and uses CalDAV discovery and queries against Apple servers. Disconnecting removes the stored copy. Revoke the password in Apple Account settings to terminate access at Apple.

Start with test accounts and inspect the first import, a changed event, a cancellation and reauthorization before enabling everyday accounts.

For an independent Apple Watch connectivity test, see [the watch probe](watch/README.md).
