# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` / `npm start` — both use `PORT` (default 3000).
- `npm run build` — Next.js production build (also the only type check; there is no lint script and no test suite). For a type check alone: `npx tsc --noEmit`.
- `npm install` runs `postinstall`, which downloads yt-dlp and ffmpeg binaries into `./bin/` (gitignored) via `scripts/install-*.mjs`. These are skipped if `YTDLP_PATH`/`FFMPEG_PATH` is set or the tool is already on PATH. The Dockerfile uses `--ignore-scripts` and installs both system-wide instead.
- Lockfile is `package-lock.json` (npm). README/CONTRIBUTING mention pnpm and a `artifacts/clypt-next` monorepo path — those are stale; this repo is a standalone npm project.

## Architecture

Next.js 15 App Router + React 19 + Tailwind v4. No database: the server shells out to **yt-dlp** (and **ffmpeg** for GIF/merges) and stores results as files in `os.tmpdir()`; all user state (queue, history, recent searches) lives in browser `localStorage`.

**Binary resolution (`lib/ytdlp.ts`)**: `ytDlpPath()` / `ffmpegPath()` check env override → `./bin/` → PATH. If the bundled binary isn't executable (Lambda/Amplify read-only archives) it is copied to `/tmp` and chmod'd. Next must trace `./bin/**` into the routes that spawn it — see `outputFileTracingIncludes` in `next.config.ts`; add new spawning routes there.

**Download flow (`app/api/videos/`): single streaming endpoint** — `download/route.ts` POST spawns yt-dlp and streams progress back in the same response; the file is then fetched from `download/[jobId]/file`, which locates it via a `clypt-meta-<jobId>.json` file in tmp (not in-memory), so it works across serverless instances. Files are deleted after being served; `cleanOldTempFiles()` sweeps `clypt-*` tmp files older than 30 min on each POST.

Other routes: `fetch` (metadata, format list via `parseFormats`, plus a `recommended` option from `pickRecommended`: best quality up to 1080p, 720p in WhatsApp mode, judged by the short side, selector prefers H.264+AAC), `playlist` (expand playlists), `thumbnail` (image proxy with SSRF guard — private-IP/DNS checks; keep it intact when editing).

**Client**: `components/home.tsx` is the app shell. `hooks/use-download-queue.ts` is the download state machine (statuses `scheduled → queued → pending → downloading → complete|error`), persists the queue to localStorage, and fires scheduled items when due. All fetches prefix `API_BASE` (`lib/api.ts`, from `BASE_PATH`/`NEXT_PUBLIC_BASE_PATH`) so the app can run under a sub-path.

## Deployment notes

- `vercel.json` sets `maxDuration` per route (300s for download needs Pro) and permissive CORS on `/api/*`. Function paths there reference the active `download`/`fetch` routes only.
- `amplify.yml` and `Dockerfile` are alternate targets; the Dockerfile is what runs on Node hosts (Railway etc.). Tmp storage is ephemeral (~512 MB on Vercel).
- `.env.example`: `YTDLP_PATH`, `BASE_PATH` (plus undocumented `FFMPEG_PATH`).
- CONTRIBUTING says to use a `req.log`/`logger` instead of `console.log`, but no such logger exists in this repo; existing code uses `console.error`.

## Behavior worth knowing

- The UI's main button queues each video with `recommended.formatId`; the hook auto-saves the file on the `complete` event (hidden `<a download>`). Per-video quality/trim/schedule live under "Advanced".
- mp4 downloads pass through `ensureQuickTimeCompatible` (`lib/ytdlp.ts`): non-H.264/HEVC video (Instagram serves VP9) is re-encoded so QuickTime/iOS can play it. The `whatsapp` flag also caps the short side at 720 and the size at ~15 MB.
- `/download` emits `ping` SSE events every 15 s so proxies (Railway) don't drop long requests. On Railway keep a single replica: output files and `clypt-meta-*.json` live in the container's tmp disk.
- `CLYPT_COOKIES` (cookies.txt raw or base64) is written to `tmp/ytdlp-cookies.txt` and passed as `--cookies` on every yt-dlp call (`ytDlpCommonArgs`); needed for Instagram/YouTube on datacenter IPs. `YTDLP_EXTRA_ARGS` (space-separated) is appended to every call too.
- `POST /api/videos/quick` (`lib/quick-download.ts`, `lib/api-auth.ts`) is the single-request endpoint for iOS Shortcuts: bearer token `CLYPT_API_TOKEN` (503 if unset), accepts JSON/form/plain text, returns the mp4 directly and deletes it after. It re-implements the yt-dlp args of `download/route.ts` for mp4 only; keep them in sync.
