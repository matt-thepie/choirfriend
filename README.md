# choirfriend

A self-hosted, open-source web app for choirs. It does what Choirmate does — sheet music with annotations, learning tracks, piano for notebashing — without the per-seat licence fees. Bring your own auth provider.

## What it does

- PDF viewer for sheet music with two annotation layers: per-user private notes and a shared layer the whole choir can edit.
- Repeat / coda / D.S. markers you can drop on the score, and a "follow" mode that jumps between them.
- Learning tracks (audio) attached to each piece, with tempo slowdown that preserves pitch.
- A piano widget for notebashing.
- Pieces bundle PDFs + tracks + notes together; auth + roles come from a pluggable identity provider.

## Stack

| Layer | Choice | Why |
|------:|--------|-----|
| Server | Fastify 5 on Node 24 LTS | Plugin model + zero build step (Node 24's native TS stripping is stable as of 24.12) |
| Client | Vite 8 + React 19 + TypeScript | Vite handles client bundling; the backend stays compile-free |
| Styling | Tailwind v4 + shadcn/ui | New `@theme` directive, OKLCH colours, `tw-animate-css` |
| DB | SQLite via `node:sqlite` (WAL mode) | No daemon, file-based, rsync to back up. Same choice as sgmc-identity. |
| Storage | Backblaze B2 behind a custom domain | Cheap, direct browser uploads via presigned URLs |
| Auth | Pluggable providers | sgmc-identity ships built in; generic OIDC is stubbed for other deployments |
| PDF rendering | PDF.js | Mature, free |
| Audio | Web Audio API | Tempo slowdown without pitch shift; the piano plays [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) samples (Alexander Holm, CC BY 3.0, mp3 set from [tonejs/audio](https://github.com/Tonejs/audio)), self-hosted in `client/public/piano/` |

The original app was scaffolded against the SGMC choir's existing identity service. The auth layer is designed so other choirs can plug in Google, Microsoft, Keycloak, magic links, etc. without touching choirfriend itself.

## Prerequisites

- **Node.js 24.12.0 or later.** We rely on stable native TypeScript stripping, which became stable in 24.12.0. With it, the server runs `.ts` files directly (`node src/server.ts`) — no `tsc`, no `tsx`, no build step. The SQLite module is also stable here.
- That's it. No Docker, no Postgres, no extra services.

## Getting started

```bash
git clone https://github.com/matt-thepie/choirfriend.git
cd choirfriend
cp .env.example .env            # adjust any values you need

# Server (port 3001)
cd server
npm install
npm run dev

# Client (port 5173) — separate terminal
cd ../client
npm install
npm run dev
```

Open <http://localhost:5173>. The client calls `/api/health` on the server and shows the result. SQLite creates `server/data/choirfriend.db` on first run (gitignored).

## Repo layout

```
choirfriend/
├── .env.example
├── server/                 Fastify backend (Node 24 native TS — no build step)
│   ├── src/
│   │   ├── server.ts       Entry point
│   │   ├── config.ts       Env-driven config
│   │   ├── routes/
│   │   │   └── health.ts
│   │   ├── db/
│   │   │   └── index.ts    node:sqlite + schema + user upsert
│   │   └── auth/
│   │       ├── types.ts        AuthProvider interface
│   │       ├── index.ts        Provider registry (env-driven)
│   │       ├── routes.ts       /auth/login, /auth/me, /:name/start, /:name/callback
│   │       ├── middleware.ts   requireAuth — attaches req.user
│   │       └── providers/
│   │           ├── sgmc-identity.ts  Cookie + /verify
│   │           └── oidc.ts           Generic OIDC stub
│   ├── data/               (gitignored — runtime SQLite file)
│   └── package.json
└── client/                 Vite + React 19 + Tailwind v4 + shadcn/ui
    ├── src/
    │   ├── main.tsx, App.tsx
    │   ├── components/ui/  shadcn primitives (run `npx shadcn add` to extend)
    │   ├── lib/utils.ts    shadcn cn() helper
    │   └── index.css       Tailwind v4 entry with @theme tokens
    └── package.json
```

## Auth providers

Each provider is a file under `server/src/auth/providers/` implementing the `AuthProvider` interface in `types.ts`. Two shapes are supported:

1. **Cookie-trusting** — an external identity service has already set a cross-domain cookie. The provider verifies that cookie and returns a user. sgmc-identity works this way.
2. **OIDC-style** — redirect to issuer, get a code at `/auth/<name>/callback`, exchange for tokens, set our own session cookie. The generic OIDC provider is the stub for this.

To add a provider:

1. Drop a file in `server/src/auth/providers/`.
2. Implement `buildLoginUrl`, `identifyUser`, and (for OIDC-style) `handleCallback`.
3. Register it in `server/src/auth/index.ts` behind an `AUTH_<NAME>_ENABLED` env var.

### sgmc-identity setup

For SGMC's deployment specifically:

- Choirfriend will live at `music.sgmc.org.uk`. sgmc-identity's allowed-redirect regex already matches `*.sgmc.org.uk` — nothing to change on the identity side.
- The `sgmc_token` cookie is set with `domain: .sgmc.org.uk`, so it travels to `music.sgmc.org.uk` automatically.
- In production, set `AUTH_SGMC_IDENTITY_VERIFY_URL=http://localhost:3050/verify` so /verify calls stay on localhost.
- In dev, the cookie won't cross `localhost:3050 → localhost:3001`. Either run both behind `/etc/hosts` aliases like `identity.localtest.me` + `music.localtest.me` with the cookie scoped to `.localtest.me`, or test authenticated flows against the live identity service.

## Backblaze B2 setup

choirfriend uploads files directly from the browser to B2 via presigned URLs (the API never sees the bytes). For this to work, the bucket needs CORS rules that allow PUTs from your app's origin and GETs from anywhere.

```bash
# Once
b2 account authorize <YOUR_KEY_ID> <YOUR_APPLICATION_KEY>

# Per bucket
./scripts/apply-b2-cors.sh <BUCKET_NAME>
```

The rules applied are in `scripts/b2-cors-rules.json` — edit the `allowedOrigins` of the uploads rule if you're deploying to a different host. Both files are checked into the repo so the configuration is version-controlled, not buried in a Backblaze admin tab.

⚠️ The script replaces the bucket's entire CORS array. If you share the bucket with other services and they also have CORS rules, merge by hand.

## Deployment

The server has no build step. On the VPS, GitHub Actions runs:

```bash
git pull
cd server && npm ci --omit=dev
cd ../client && npm ci && npm run build
pm2 restart choirfriend
```

The Fastify server serves `client/dist/` as static assets in production. nginx fronts everything and handles TLS.

## Open design questions

- **Annotation sync model:** push-on-save, or CRDT for offline-friendly merging?
- **Offline learning tracks:** scores sync for offline use; audio still needs a connection. Annotations made offline are not queued for upload.
- **Mobile:** the UI must be tablet/phone-first since most choristers use those at rehearsals.

## ChoirMate migration

`server/src/import/choirmate.ts` loads a ChoirMate scrape (a `manifest.json`
plus the files it references) into the database and B2:

    cd server && node --env-file=../.env src/import/choirmate.ts ~/sgmc-export [--dry-run] [--limit N]

It is resumable (progress in `<export>/.choirfriend-import.json`). Songs with
the same title (ignoring case/punctuation) are merged; ChoirMate's free-text
artist goes into `composer`; songs on the "Rehearsal" set list become current
repertoire and the rest are archived; Word documents and lyric-named PDFs are
filed as lyrics. A second pass fills in what the first import had no home for:

    node --env-file=../.env src/tools/backfill-from-manifest.ts ~/sgmc-export [--dry-run]

(audio durations, per-section remarks, links). `tools/merge-pieces.ts <survivor> <loser>`
folds one duplicate piece into another and `tools/dedupe-files.ts` collapses
exact duplicate files within a piece.

## Status

Working and deployed at `music.sgmc.org.uk` (SGMC members only, via sgmc-identity).
The SGMC repertoire (101 songs, ~640 files) is imported from ChoirMate.

Built:

- Information architecture, labels and flows match ChoirMate so members need no retraining: **Set lists | Repertoire** toggle (Set lists is the landing page), admins get **Switch to edit mode / view mode**, and members never see admin controls.
- Repertoire: one flat table (Title, Artist/Arranger, Sheet music tick + count), search, sort, letter groups with an A–Z strip, "Add new song".
- Song page, audio-first: breadcrumb, **Remarks / Lyrics / Links**, section dropdown defaulting to the member's own part, **Sheet music** list (open in the annotating viewer, print, download), **Audio files for <section>** rows with round play button, duration, "Shared by", date, kebab; **How confident are you performing this song?** faces; **Private notes**.
- Edit mode on a song: Repertoire settings (Title, Artist/Arranger), one audio block per section with its own **Add audio** that pre-assigns the part, Edit / Replace file / Delete per file, remark text areas per section, add/remove links, Add sheet music / lyrics / score.
- File kinds: sheet music (PDF), audio, **lyrics** (pdf/docx/rtf/txt/odt/md) and **scores** (MuseScore / MusicXML, only shown to admins and `SCORE_ROLES`).
- PDF viewer with pen annotations and navigation markers on private and shared layers; read/perform mode; fit-to-width on phones.
- Set lists: picture tiles, create / rename / drag reorder / archive / copy / delete / Order, one list pinned as "this week"; **Practice list** panel ("Viewing content for" + section) queues one track per song; the virtual **All songs** list.
- Persistent mini player (72px card, seek bar, 48px play) with speed 0.5–1.5x, A-B loop, repeat and Media Session for lock-screen controls.
- Design system: deep teal field (the logo's palette), white cards, Inter, Material Symbols, 16px base, 44px tap targets, dark mode via `prefers-color-scheme`; installable PWA (manifest with screenshots, in-app Install button and iOS instructions).
- Piano widget (sampled grand piano, 2–5 octaves depending on screen width); bulk importer (Claude reads title/composer off PDFs); ChoirMate migration importer and backfill tools.
- Admin gate on all write routes (members of any `ADMIN_ROLES` group).
- URLs for every screen (`/`, `/repertoire`, `/setlists/:id`, `/songs/:id`, `/songs/:id/view/:fileId`) so the back button, reloads and shared links work.
- Optional features: the confidence rating can be hidden with `FEATURE_CONFIDENCE=false` (SGMC runs with it off).

Not built (from the ChoirMate brief):

- Personal practice lists ("Your practice lists", "Toggle in practice list", "Add to practice list when uploading audio files").
- Member-side uploads with a private/shared toggle.
- Set list cover image upload (tiles use a placeholder), set list / repertoire exports (CSV, PDF), "Export repertoire list".
- Lyrics as inline text (lyrics are files: view/download), "Override song sections", "Order audio files by", Track Mixer.

Not built (other):

- Offline: the service worker (`client/sw/sw.js`, emitted with a per-build precache list by a Vite plugin) keeps the app shell, fonts and piano offline; API reads are network-first with the last response as fallback; sheet music PDFs are cache-first. The menu's Offline scores setting syncs scores for songs on active set lists (default), all repertoire, or none, and also caches those songs' pages. Background sync skips mobile data and Save-Data; Sync now works anywhere. Learning tracks are online-only.
- Generic OIDC auth provider (stub only; sgmc-identity is the one real provider).
- Any of ChoirMate's non-music features (members, messages, polls, events, documents). Out of scope unless a choir asks for them.
