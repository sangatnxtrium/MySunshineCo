# MySunshineCo — live deployment (Supabase + Vercel)

This is the production version of the app: data lives in Supabase Postgres, uploaded
files live in Supabase Storage, and the API runs as a Vercel serverless function. The
frontend (`public/`) is unchanged from the local prototype — same screens, same
features, same API shape.

## What changed from the local prototype

| | Local prototype | This version |
|---|---|---|
| Data storage | `data.json` file on disk | Supabase Postgres |
| File uploads | local `uploads/` folder | Supabase Storage (private bucket) |
| Login sessions | in-memory `express-session` | signed JWT in an httpOnly cookie (works on stateless serverless functions) |
| Hosting | your own computer, `npm start` | Vercel |

Login system is still the app's own — usernames/passwords hashed with bcrypt, admin
creates every caregiver account. Not Supabase Auth.

## One-time setup

### 1. Create the database tables

In your Supabase project: **SQL Editor → New query**, paste the contents of
`supabase/schema.sql`, and run it. This creates all the tables and seeds one
Office Admin account (`admin` / `admin123` — change this password immediately
after your first login).

### 2. Create a Storage bucket

In Supabase: **Storage → New bucket**. Name it `documents` and make it **private**
(not public) — the app generates short-lived signed URLs for viewing/downloading, so
files stay protected by the same permission checks as everything else. If you name it
something other than `documents`, set `SUPABASE_STORAGE_BUCKET` to match in step 4.

### 3. Push this project to GitHub

```
cd mysunshineco
git remote add origin <your-empty-github-repo-url>
git push -u origin main
```
(This folder is already a git repo with an initial commit — see "Git" below.)

### 4. Connect the repo to Vercel and set environment variables

In Vercel: **Add New Project → import the GitHub repo you just pushed.** Before the
first deploy, add these under **Settings → Environment Variables**:

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` secret key |
| `SUPABASE_STORAGE_BUCKET` | `documents` (or whatever you named it in step 2) |
| `JWT_SECRET` | any long random string — generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Deploy. Vercel will build and give you a live URL (`https://your-project.vercel.app`).

### 5. Log in and lock it down

- Log in as `admin` / `admin123` and immediately change the password (there's no
  self-service "My Account" for admin yet in the UI — ask me to add one, or reset it
  directly in Supabase's SQL editor: `update users set password_hash = crypt('newpassword', gen_salt('bf')) where username = 'admin';`)
- Create real caregiver accounts from **Caregiver Roster & Accounts**
- Add your real clients from **Clients**
- Delete or ignore the demo data — there isn't any this time; the schema only seeds the admin account and default task checklist.

## Local development

```
cd mysunshineco
npm install
cp .env.example .env   # then fill in your Supabase URL/key and a JWT secret
npm run dev
```
Opens at http://localhost:3000, talking to your real (or a separate dev) Supabase project.

## Git

This folder is already initialized as a git repo with everything committed except
`node_modules/`, `.env`, and other files listed in `.gitignore`. To push to a new
GitHub repo:
```
git remote add origin https://github.com/yourname/mysunshineco.git
git branch -M main
git push -u origin main
```
Every future `git push` will auto-deploy on Vercel once the project is connected.

## What's covered

- **Sandata EVV call tracking** — caregivers log call-in/call-out per visit; flags on-time / late / overdue against a 15-minute grace window; admin dashboard shows an overall on-time call rate.
- **Skipped/missed visits** — required reason + admin follow-up/resolve workflow.
- **Daily activity checklist** — editable default task templates, plus per-visit ad hoc tasks.
- **Roster & client management** — admin creates/edits caregiver accounts and certifications, adds/edits clients.
- **Scheduling** — create, reassign, reschedule, and cancel visits.
- **Documents** — real upload/view/download via Supabase Storage, permission-checked server-side.
- **Recertification workflow** — caregiver submits a renewal; admin reviews the document and approves/rejects before the expiration date changes.
- **Hourly wage + missed-call pay impact** — rolling 14-day compliance estimate (skipped visits / missed Sandata calls × hourly wage), shown to the caregiver and rolled up for admin. Informational only — no payroll integration.
- **Messaging** — broadcast or 1:1 between office and caregivers.

## Known limitations

- **No real Sandata/EVV vendor integration.** This tracks calls in-app; it doesn't submit data to Sandata's actual systems. If your state requires certified EVV submission, this doesn't replace that.
- **The pay-deduction estimate is informational only** — no payroll system is connected; no money moves automatically.
- **No self-service password reset / forgot-password email flow.** Admin resets caregiver passwords from the roster; admin's own password reset currently requires the Supabase SQL editor (see step 5) until a "My Account" screen is added for admin.
- **JWT logout is client-side only.** Clearing the cookie logs the browser out; the token itself remains cryptographically valid until it expires (8 hours) if somehow replayed elsewhere. Fine for this use case, worth knowing.
- **Signed URLs expire in 60 seconds.** If a document view/download link is somehow reused after that, request it again from within the app — this is intentional (short-lived access rather than permanent public links).
