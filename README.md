---
title: "Dusk Shingle"
type: project
status: active
project: "dusk-shingle"
tags: [project, web-app, react, postgres, e2ee, vercel]
created: "2026-09-19"
---

# Dusk Shingle

A quiet, reader-facing publication surface for *Dusk Shingle*.

## Local development

```bash
npm install
npm run dev        # API (server/dev.ts, on-disk PGlite in .data/) + Vite on :5173, /api proxied
```

## Architecture

Vite + React SPA with one Vercel Function (`api/router.ts`) backed by Postgres. Anonymous accounts (a single
browser-generated reader key, no identity data), end-to-end encrypted reading-state sync, a community forum
(discussions with titles, categories and tags, with or without a chapter) with a spoiler model, moderation and
full account deletion. See `docs/ARCHITECTURE.md` (security, crypto, privacy data inventory) and `docs/DESIGN.md`
(design system).

## The community forum

`/community` is a primary destination, not a chapter accessory. A discussion is a titled thread with a category
and tags; it does **not** have to belong to a chapter. Each published chapter also has one designated discussion,
which keeps the address it always had (`/chapter/:slug/discussion`) and is reachable from the community like any
other thread.

- Categories and tags are **data**, not code: `categories` is a table (seeded in `server/migrate.ts`) and tags
  are free-form. Adding a category is an `INSERT`, not a deploy.
- A discussion is a `comments` row with `parent_id IS NULL` carrying `title`/`category`/`tags`; a reply is a row
  with `parent_id` set. Existing chapter discussions were converted in place — no rows were copied, so replies,
  authorship and timestamps were preserved by construction (`server/migrate.ts`, covered by the `forum migration`
  tests in `server/api.test.ts`).
- Nothing individual is indexed: filtered views and single discussions carry no canonical URL. The community
  index and each chapter's discussion room remain indexable, as before.

## Content

Chapter metadata lives in `src/content/catalog.ts`; prose sources are registered in `src/content/chapters.ts`.
Only `published` entries reach the library, reader and API.

## Search & crawling

`public/robots.txt` and `public/sitemap.xml` are served at `/robots.txt` and `/sitemap.xml`. The sitemap is
regenerated from the published content source on every build (`npm run sitemap`) — never edit it by hand.
Canonical URLs (`src/lib/seo.ts`) use the production origin `https://dusk-shingle.vercel.app` and are kept
consistent with the sitemap. Account, moderation, API and not-found pages are excluded from both files and
marked `noindex`; robots directives are crawl hints only — access control stays in the application and API.
Community pages that are filtered, searched, or a single discussion are `noindex` for the same reason.

Deployment routing (`vercel.json`): every SPA route falls back to `/` so deep links resolve, `robots.txt`
and `sitemap.xml` are excluded from the fallback and served as real files, and the duplicate variants
`/library` and `/index.html` permanently redirect to `/`. The retired discussions index permanently redirects
`/discussions` → `/community`. Do not re-enable `cleanUrls` — it turns
`/index.html` into a redirect source and a fallback destination of `/index.html` then 404s every deep link.

## Deploy (Vercel)

The database is the Neon integration (`dusk-shingle-db`), which supplies `DATABASE_URL` to the
Production, Preview and Development environments. `RATE_LIMIT_SECRET` (32+ random bytes) must be
set on each environment too — the API refuses to serve IP rate limits without it rather than
silently resetting them on every cold start. The schema is created automatically on first request.
Moderators are designated with `UPDATE accounts SET role = 'moderator' WHERE handle = '…';`.

If the API answers `503 db_unavailable`, the deployment cannot reach its database. The reason is
logged (`vercel logs <url>`) with connection strings, passwords and user names redacted — without
that log line a dead database is indistinguishable from a healthy one. Note that a deleted or
expired database is the usual cause: the endpoint still accepts connections and then answers
`XX000 … tenant/user … not found` at the provider's gateway.

Only `pg` is exercised against a real network in production. Local dev and the test suite use PGlite
(`server/pglite.ts`), so `server/db.ts`'s connection options have no test coverage — a green
`npm test` does not prove the production database is reachable. Use `verify:production` for that.

## Secrets

The application reads exactly two environment variables: `DATABASE_URL` and `RATE_LIMIT_SECRET`.
Both must be Vercel **Secrets**, not Config — a Config value is stored in plaintext and is readable
by anyone with project access through the dashboard, CLI and API. Verify with:

```bash
vercel env ls        # every credential must read "Hidden" / "Secret"
```

Do not add `VITE_`/`PUBLIC_`/`NEXT_PUBLIC_` variables. Vite inlines those into the client bundle at
build time; nothing here uses `import.meta.env`, and that stays true. The Neon integration also
supplies `PGHOST`, `PGUSER`, `PGDATABASE` and friends, which this app never reads — they are
identifiers rather than credentials, but the connection strings and passwords it ships alongside them
(`POSTGRES_URL`, `PGPASSWORD`, `DATABASE_URL_UNPOOLED`, …) have been removed rather than left
readable. Expect the integration to offer to recreate them on a resync; delete them again.

`.env.example` is the only environment file in the repository and holds no real values. For local
work pull the values you need (`vercel env pull` writes `.env.local`, which is git-ignored and
contains live credentials — do not commit it or copy it anywhere shared).

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm run verify:production   # drives the live site: accounts, discussions, routing, security
```

`verify:production` runs the release checklist against a deployed URL (default
`https://dusk-shingle.vercel.app`, or pass one as the first argument). It creates one throwaway
account, opens a chapter-less discussion, replies to it, and deletes everything again.

## Routes

`/` library · `/chapter/:slug` reader · `/community` forum index · `/community/new` start a discussion ·
`/community/:id` a discussion · `/community/c/:category` · `/community/t/:tag` · `/community?q=…` search ·
`/chapter/:slug/discussion` that chapter's discussion · `/account` · `/moderation`

`/discussions` permanently redirects to `/community`.
