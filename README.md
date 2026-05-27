# choirfriend

A self-hosted, open-source web app for choirs. It does what Choirmate does — sheet music with annotations, learning tracks, piano for notebashing — without the per-seat licence fees. Bring your own auth provider.

## What it does

- PDF viewer for sheet music, with two annotation layers (per-user private + shared with the whole choir).
- Repeat / coda / D.S. markers you can drop on the score, and a "follow" mode that jumps between them.
- Learning tracks (audio) attached to each piece, with tempo slowdown that preserves pitch.
- A piano widget for notebashing.
- Pieces bundle PDFs + tracks + notes together; sgmc-identity handles users and roles.

## Stack

| Layer | Choice | Why |
|------:|--------|-----|
| Server | Fastify 5 on Node 24 LTS | Fastify's plugin model + zero build step (Node 24's native TS stripping is stable as of 24.12) |
| Client | Vite + React 19 + TypeScript | Vite handles client bundling; backend stays compile-free |
| Styling | Tailwind v4 + shadcn/ui | New `@theme` directive, OKLCH colours, `tw-animate-css` |
| DB | Postgres 17 | Annotations are relational; many writers concurrently |
| Storage | Backblaze B2 behind `media.mgd.scot` | Cheap, direct browser uploads via presigned URLs |
| Auth | Pluggable OIDC providers | Generic OIDC by default; bring Google, Microsoft, Keycloak, sgmc-identity, etc. |
| PDF rendering | PDF.js | Mature, free |
| Audio | Web Audio API + Tone.js | Tempo slowdown without pitch shift; Tone.js for the piano |

## Prerequisites

- **Node.js 24.12.0 or later.** This is non-negotiable: we rely on stable native TypeScript stripping, which became stable in 24.12.0. With it, the server runs `.ts` files directly (`node src/server.ts`) — no `tsc`, no `tsx`, no build step.
- Docker (for local Postgres) — or your own Postgres 14+.
- pnpm or npm. Examples below use npm because it ships with Node.

## Getting started

```bash
git clone <this repo>
cd choirfriend
cp .env.example .env
docker compose up -d            # starts Postgres on :5432

# Server (port 3001)
cd server
npm install
npm run dev

# Client (port 5173) — separate terminal
cd client
npm install
npm run dev
```

Open <http://localhost:5173>. The client should call the server's `/health` endpoint and show "ok".

## Repo layout

```
choirfriend/
├── docker-compose.yml      Postgres for local dev
├── .env.example
├── server/                 Fastify backend (Node 24 native TS — no build step)
│   ├── src/
│   │   ├── server.ts       Entry point
│   │   ├── routes/         Route plugins
│   │   ├── db/             Postgres client + migrations
│   │   ├── auth/           Provider-agnostic OIDC; pluggable providers/
│   │   └── storage/        B2 client + presigned URLs
│   └── package.json
└── client/                 Vite + React 19 + Tailwind v4 + shadcn/ui
    ├── src/
    │   ├── main.tsx
    │   ├── App.tsx
    │   ├── components/     App components
    │   │   └── ui/         shadcn primitives
    │   ├── lib/
    │   └── index.css       Tailwind v4 entry
    └── package.json
```

## Deployment

The server has no build step. On the VPS:

```bash
git pull
cd server && npm ci --omit=dev
cd ../client && npm ci && npm run build
# server serves client/dist/ as static assets
```

Run `node src/server.ts` under systemd or pm2. Done.

## Open design questions

- **Annotation sync model:** push-on-save, or CRDT for offline-friendly merging?
- **Offline support:** service worker + IndexedDB caching of opened pieces is on the roadmap, not built yet.
- **Mobile:** the UI must be tablet/phone-first since most choristers use those at rehearsals.

## Status

Skeleton scaffold only. None of the features described above are built yet — this is the starting point.
