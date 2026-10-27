# choirfriend

A self-hosted, open-source web app for choirs. It does what Choirmate does — sheet music with annotations, learning tracks, piano for notebashing — without the per-seat licence fees. Bring your own auth provider.

## What it does

- PDF viewer for sheet music that opens in a distraction-free read mode, with private marks and shared marks that can be limited to chosen voice parts.
- Repeat / coda / D.S. markers you can drop on the score and tap to follow.
- "Shade my part": a pale band behind the member's own stave, guessed from the stave labels.
- Set lists that flow from one song's last page to the next song, with the music player following along.
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
├── .github/workflows/deploy.yml   Push to main → deploy to the VPS
├── scripts/                B2 CORS rules + apply script
├── server/                 Fastify backend (Node 24 native TS — no build step)
│   ├── src/
│   │   ├── server.ts       Entry point
│   │   ├── config.ts       Env-driven config
│   │   ├── seed.ts
│   │   ├── routes/         health, pieces, files, annotations, setlists,
│   │   │                   sections, me, offline, import
│   │   ├── db/             node:sqlite schema + migrations (index.ts), and one
│   │   │                   module per area: pieces, pieceExtras, annotations,
│   │   │                   sections, setlists
│   │   ├── storage/b2.ts   Presigned B2 uploads/downloads
│   │   ├── import/         ChoirMate importer, PDF analysis for bulk import
│   │   ├── tools/          One-off maintenance scripts (backfills, merge, dedupe)
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
    ├── sw/sw.js            Service worker (precache list injected at build)
    ├── src/
    │   ├── main.tsx, App.tsx, router.ts
    │   ├── components/
    │   │   ├── *Screen.tsx     Set lists, set list, repertoire, song, import, sign-in
    │   │   ├── PdfViewer/      Viewer, page canvas + ink, marker badges, uploads
    │   │   ├── Player/         Persistent mini player bar
    │   │   ├── AudioPlayer/, Piano/
    │   │   └── ui/             button, popover (renders into body so toolbars can't clip it)
    │   ├── player/PlayerContext.tsx   Queue + playback shared across screens
    │   ├── hooks/          Data hooks (pieces, set lists, annotations, sections,
    │   │                   set list flow, offline scores, install prompt…)
    │   ├── lib/            pdfjs setup, offline cache, pageLayout (stave/system
    │   │                   detection), partLine (which stave is "my part")
    │   ├── types/annotations.ts
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

# Per bucket: allow uploads from your live site and the Vite dev server
./scripts/apply-b2-cors.sh <BUCKET_NAME> https://music.example.org http://localhost:5173
```

The origins you pass are the only sites allowed to upload; reads are allowed from anywhere. With no origins, the script uses `CLIENT_ORIGIN` from `.env` plus `http://localhost:5173`, which is right when you run it on the server but drops your live site if your local `.env` points at localhost. The rest of the rules are in `scripts/b2-cors-rules.json`. Both files are checked into the repo so the configuration is version-controlled, not buried in a Backblaze admin tab.

⚠️ The script replaces the bucket's entire CORS array. If you share the bucket with other services and they also have CORS rules, merge by hand.

## Deployment

Pushing to `main` deploys: `.github/workflows/deploy.yml` SSHes to the VPS and runs

```bash
git pull origin main
cd server && npm ci
cd ../client && npm ci && npm run build
pm2 restart choirfriend --update-env
```

The server has no build step and runs under Node 24 via pm2. nginx serves `client/dist/` statically, proxies `/api` and `/auth` to Fastify, and handles TLS. Schema changes are applied by `server/src/db/index.ts` on start-up, so there is no separate migration step. The client and server deploy together, so a change that adds a field on both sides is safe to push in one go.

Home-screen (PWA) installs pick up a new build only after the app is fully closed and reopened; a service-worker change needs that twice.

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

- Information architecture, labels and flows match ChoirMate so members need no retraining: **Set lists | Repertoire** toggle (Set lists is the landing page), admins get an **Edit mode** toggle (solid when on), and members never see admin controls.
- Repertoire: one flat table (Title, Artist/Arranger, Sheet music tick + count), search, sort, letter groups with an A–Z strip, "Add new song".
- Song page, audio-first: breadcrumb, **Remarks / Lyrics / Links**, section dropdown defaulting to the member's own part, **Sheet music** list (open in the annotating viewer, print, download), **Audio files for <section>** rows with round play button, duration, "Shared by", date, kebab; **How confident are you performing this song?** faces; **Private notes**.
- Edit mode on a song: Repertoire settings (Title, Artist/Arranger), one audio block per section with its own **Add audio** that pre-assigns the part, Edit / Replace file / Delete per file, remark text areas per section, add/remove links, Add sheet music / lyrics / score.
- File kinds: sheet music (PDF), audio, **lyrics** (pdf/docx/rtf/txt/odt/md) and **scores** (MuseScore / MusicXML, only shown to admins and `SCORE_ROLES`).
- PDF viewer:
  - Opens in **read mode** by default (a link without `?read=1` opens the normal view). The read-mode toolbar floats over the score, appears on a tap in the middle of the page and hides after 4 seconds untouched (not while marking up or with a menu open). Edge taps and swipes turn pages. The screen is kept awake (Wake Lock API) while a score is open in read mode.
  - **Scroll / Pages** layout, remembered per device; fit-to-width on phones; loading spinner with download progress.
  - Toolbar is one **Mark up** toggle: reading controls (Jump to, Scroll/Pages, zoom, Shade my part, Listen) on the main row, and while marking up a second row with a large **Undo**, **Pen | Highlighter | Marker**, colour, **Private | Shared** with **For:** parts, and **Clear my private…**. Two-finger tap undoes. On phones rows wrap and less-used controls sit behind **More**; there is no horizontally scrolling toolbar.
  - Highlighter strokes multiply under pen strokes; six pen and five highlighter colours, chosen per device. New marks default to **Private** (the last choice is remembered per device).
  - Shared marks can be limited to one or more voice parts; they are visible only to members of those parts and the author. Older shared marks (no parts set) are visible to everyone.
  - Markers: tapping an end-repeat goes back to the nearest start-repeat (or the top), a 1st-time bar goes back the same way, and D.S. / D.C. / To Coda go to their targets. Start-repeat, 2nd-time bar, segno, coda and fine are landing points only. Tappable markers show a →.
  - **Shade my part**: `lib/pageLayout.ts` finds five-line staves and joins them into systems; `lib/partLine.ts` picks the member's stave from the printed labels and carries it forward by stave position. **Adjust** lets a member tap the right stave per system (saved per member per file); the on/off switch is per member.
  - Safe-area padding for iPad / iPhone home-screen installs.
- Set lists: picture tiles, create / rename / drag reorder / archive / copy / delete / Order, one list pinned as "this week"; in-list search (title, composer, arranger); **Practice list** panel ("Viewing content for" + section) queues one track per song; the virtual **All songs** list.
  - Opening a score from a set list makes it flow: turning past the last page opens the next song's default sheet (prefetched in the background if under 8 MB), with **Next: title** / previous-song buttons and an end-of-list card in Scroll view.
  - When the player is playing that same set list, the two stay linked: the player moving on opens the next score, and turning the score into the next song cues its track paused.
- Persistent mini player (72px card, seek bar, 48px play) with back-to-start, ±10s, speed 0.5–1.5x, A-B loop, repeat and Media Session for lock-screen controls. In read mode it stays visible if a track is loaded; otherwise **Listen** lists the song's recordings.
- Design system: deep teal field (the logo's palette), white cards, Inter, Material Symbols, 16px base, 44px tap targets, dark mode via `prefers-color-scheme`; toggle buttons show "on" by fill, not by changing their label; installable PWA (manifest with screenshots, in-app Install button and iOS instructions).
- Piano widget (sampled grand piano, 2–5 octaves depending on screen width); bulk importer (Claude reads title/composer off PDFs); ChoirMate migration importer and backfill tools.
- Admin gate on all write routes (members of any `ADMIN_ROLES` group).
- URLs for every screen (`/`, `/repertoire`, `/setlists/:id`, `/songs/:id`, `/songs/:id/view/:fileId`) so the back button, reloads and shared links work.
- Optional features: the confidence rating can be hidden with `FEATURE_CONFIDENCE=false` (SGMC runs with it off).

Known limitations:

- Uploads classify lyrics by filename only (`lyric|crib|words`), so a lyric sheet uploaded under another name is filed as sheet music. On 27 Oct 2026, 30 sheet-music files with no staves were moved to Lyrics on the live database (backup: `server/data/choirfriend-before-lyrics-move-20261027.db`).
- Shade my part needs a text layer for labels: on scanned PDFs the first tap in Adjust sets the line. Photo scans of curved pages (e.g. the second Carol of the Bells) defeat the stave finder.
- While marking up, one finger draws, so Scroll view needs **Done** to scroll. MD / section leaders cannot see other parts' part-only marks unless they drew them.

Not built (from the ChoirMate brief):

- Personal practice lists ("Your practice lists", "Toggle in practice list", "Add to practice list when uploading audio files").
- Member-side uploads with a private/shared toggle.
- Set list cover image upload (tiles use a placeholder), set list / repertoire exports (CSV, PDF), "Export repertoire list".
- Lyrics as inline text (lyrics are files: view/download), "Override song sections", "Order audio files by", Track Mixer.

Not built (other):

- Offline: the service worker (`client/sw/sw.js`, emitted with a per-build precache list by a Vite plugin) keeps the app shell, fonts and piano offline; API reads are network-first with the last response as fallback; sheet music PDFs are cache-first. The menu's Offline scores setting syncs scores for songs on active set lists (default), all repertoire, or none, and also caches those songs' pages. Background sync skips mobile data and Save-Data; Sync now works anywhere. Learning tracks are online-only.
- Generic OIDC auth provider (stub only; sgmc-identity is the one real provider).
- Any of ChoirMate's non-music features (members, messages, polls, events, documents). Out of scope unless a choir asks for them.
