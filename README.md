# RCF MOUAU Digital Library — Backend

Node/Express + PostgreSQL API. Designed to run on Render (or any Node host)
and be called from the existing Vercel-deployed React frontend.

## Stack

- **Express** — API server
- **PostgreSQL** (Supabase or Neon free tier) — replaces the ephemeral
  SQLite-on-Render approach; free-tier Render disks are wiped on redeploy,
  so SQLite there means silent data loss. A real Postgres host fixes that.
- **Google OAuth (Identity Services + service account for Drive)** — real
  auth, replacing the `AuthContext.login()` stub and `SKIP_AUTH` flag in
  the frontend.
- **Google Drive** — file storage.
- **JWT (access token) + rotating refresh token** — stored as httpOnly,
  `sameSite: none`, `secure: true` cookies — same cross-domain cookie
  pattern you'll need for any Vercel (frontend) ↔ Render (backend) split, since they're on different domains.

## Getting started

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, GOOGLE_CLIENT_ID, etc.
npm run migrate        # applies schema.sql to your database
npm run dev
```

## Project layout

```
src/
  server.js              — app entrypoint, middleware, route mounting
  db/
    schema.sql            — full normalized schema (see comments inline)
    pool.js                — pg connection pool
    migrate.js             — one-time schema apply script
  middleware/
    auth.js                 — JWT cookie verification, role guards
  config/
    googleOAuth.js           — verifies Google ID tokens
    admins.js                 — ADMIN_EMAILS allowlist
  routes/
    auth.js                    — sign-in, refresh, logout, /me
    resources.js                — public search/browse/download/bookmark
    uploads.js                   — authenticated file upload + validation
    admin.js                      — approve/reject, user roles, announcements
    community.js                   — requests, suggestions, notifications, history
  services/
    storage.js                     — Google Drive upload/download wrapper
    previewQueue.js                 — preview generation pipeline (see file for
                                       per-file-type strategy and real limitations)
  utils/
    metadata.js                      — fast synchronous metadata (image dimensions)
```

## What's implemented vs. stubbed

**Implemented and functional:**
- Full schema with proper relationships, indexes, and full-text search
- Auth flow (Google verification → JWT + refresh token sessions → role-based guards)
- Resource search/filter/pagination
- Upload validation, storage upload, resource creation as `pending`
- Admin approve/reject workflow with notifications + audit log
- Requests, suggestions, bookmarks, reading history, notifications endpoints

**Stubbed with the real approach documented (needs host-specific finishing):**
- `services/previewQueue.js` — the four preview generators (PDF, Office docs,
  video, audio) are stubbed with exact library/binary calls documented. PDF
  and audio can be finished purely in Node. Office-doc and video previews
  need LibreOffice/ffmpeg installed on the host — this only works on Render's
  paid tiers (or a Docker-based host), **not** on Render free tier or Vercel
  serverless functions. Read the comment block at the top of that file before
  building this out further.
- `services/storage.js` — Drive upload via service account; needs your actual
  service account credentials wired into `.env`.

## Security notes

- All admin routes require `role IN ('admin', 'superadmin')`, checked
  server-side on every request — this replaces the frontend-only
  `SKIP_AUTH`/`isAdmin` toggle that currently offers no real protection.
- Rate limiting is applied globally and more strictly on `/auth/google` and
  `/uploads` to blunt brute-force and upload-spam attempts.
- File uploads are validated by MIME type and capped at 200MB (adjust
  `MAX_FILE_SIZE_BYTES` in `uploads.js` to match your storage plan).
- Refresh tokens are stored hashed (SHA-256), never in plaintext, so a
  database leak alone doesn't hand out valid sessions.
