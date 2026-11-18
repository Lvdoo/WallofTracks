# What your music looks like

A single page that turns your 20 most recent distinct Last.fm sounds into GIANT, glossy
"Now Playing" poster cards that look like physical objects inside a photo of
you. The card rises out of the flat phone. Your most-played track is the biggest
and the brightest; quieter ones stay smaller and dimmer, but always readable.
Scroll, swipe or press the arrow keys and it becomes a 3D wheel of your recent
listens; click any visible card to select it — the Instagram/Pinterest
"floating music player card" look, made with CSS 3D transforms.

Everything is deliberately simple: Node.js + Express on the server, plain
HTML/CSS/JavaScript in the browser, no build step and no front-end libraries.

---

## 1. How it works (the idea)

- You scrobble from Apple Music on iPhone with a scrobbler app. Those listens
  land in your Last.fm account.
- This app asks **its own server** for the last 20 distinct sounds (`user.getRecentTracks`).
  `/api/top` still serves the all-time top 20 if you want it.
- The server — and only the server — calls Last.fm, cleans up the data, adds
  each track's total `playCount` from `track.getInfo` (cached 1 h, concurrency 4,
  4 s timeout, filled in the background so the response never waits), resolves
  artwork through a verified iTunes → Deezer → `track.getInfo` fallback, and
  caches the lists for 60 seconds.
- The browser receives plain JSON and draws the cards with CSS 3D transforms.
  The API key never reaches the browser.

```
Browser  ──GET /api/recent─▶  Express server  ──user.getRecentTracks─▶  Last.fm
   │                              │    │
   │                              │    ├── 60 s in-memory cache (+ stale fallback)
   │                              │    ├── missing art ──▶ iTunes → Deezer → track.getInfo
   │                              │    └── play counts ──▶ track.getInfo (background, 1 h cache)
   │        ──GET /api/cover?u=…─▶│
   │           (same-origin)      └──────── cover bytes ──▶ Last.fm / Apple / Deezer CDNs
   └── static HTML/CSS/JS ──────── server
```

### Why the image proxy exists

The page reads each cover's pixels in a `<canvas>` to find its dominant colour.
A cross-origin image would taint the canvas, so the browser asks **our** server
for the image via `/api/cover?u=<url>`. That route allows only https URLs from
`*.mzstatic.com`, `*.dzcdn.net`, `lastfm.freetls.fastly.net`,
`lastfm-img.freetls.fastly.net` and `*.last.fm`, refuses redirects, caps the
response at 5 MB, times out after 5 s and caches the bytes for 6 h. This keeps
the canvas readable and prevents
SSRF: a visitor cannot make the server fetch arbitrary internal addresses.

### Why a cover is never guessed

Artwork is resolved in this order: the Last.fm image (if valid), iTunes
(country FR then US: clean track + main artist, then second artist, then the
album with a lookup for the track inside it), Deezer's plain `/search/track`
query (advanced syntax only as a fallback), then Last.fm `track.getInfo`.
A candidate is accepted only when the artist SETS intersect exactly and the
normalized titles match; compilations, "hits", karaoke and backing tracks are
rejected. `track.getInfo` additionally requires the scrobble album or an exact
artist+title. If nothing matches, `image` is `null` and the card draws its
gradient.

Every track carries `coverSource` (`lastfm`, `itunes`, `deezer`,
`lastfm-trackinfo` or `none`) in `/api/recent` and `/api/top`; `?debug=1`
returns the same safe payload, with the original Last.fm fields next to the
chosen cover. Covers are cached 24 h per artist set + track + album, misses
10 min. `GET /api/debug/cover?artist=…&track=…&album=…` reports every source's
redacted query, status, raw count and the top 10 candidates with normalized
values, score and rejection reason; it is disabled in production unless
`DEBUG_COVERS=1`.
`/api/recent` also adds `playCount`; `?debug=1` adds `playCountSource`
(`lastfm` once the cached lookup arrives, `recent` while the recent-list
fallback is in use). No key or user value is ever echoed.
Run `npm test` for the `normalize()` / scoring checks.

The extracted colour is darkened until white text stays readable, then used as
a vertical gradient on the front card. Side cards switch to a frosted-glass
material with a bright rim light, and a 70/30 mix of photo white and the cover
colour tints the soft spill on the beam already present in the photo.

### Why the cache matters

A party of 20 visitors should not cause 20 Last.fm requests. The server keeps
one cached response for 60 seconds and shares one in-flight request between
simultaneous visitors. If Last.fm times out (5 s), is rate-limited or goes
down, the server serves the last good result with `"stale": true` and a
friendly message. The page then shows *"Last.fm is unreachable, showing the
last known listens from 14:32"* instead of breaking. If there is no cached
data at all, you get a clear error and a Retry button.

### Why the cards change size and glow

The browser computes a log-scale weight across the tracks currently loaded:

```
w = (log(1 + count) - log(1 + min)) / (log(1 + max) - log(1 + min))
```

If every count is the same, `w = 0.5`. The weight drives three CSS variables:

| Variable | Least played | Most played | Purpose |
| --- | --- | --- | --- |
| `--play-scale` | 0.82 | 1.12 | Overall card size |
| `--glow` | 0.25 | 1 | Rim, halo, gloss and cast shadow |
| `--play-lift` | 0 | 1 | Slight float for favourites |

The wheel's own dimming is multiplied in but clamped: glow never drops below
0.25, brightness never below 0.8 and scale never below 0.82, so the quietest
card is still readable. The front card stays fully opaque and sharp. Clicking a
side card selects it; "Back to phone" / Escape / Enter collapses to that
selection, and a new swipe reopens the wheel at the same track.

---

## 2. Get a Last.fm API key

1. Create a Last.fm account (or use the one you scrobble to) at
   <https://www.last.fm/>.
2. Go to <https://www.last.fm/api/account/create> and fill in the form. You can
   use `http://localhost:3000` as the application homepage.
3. Last.fm will show you an **API key** and an **API secret**. This project only
   needs the **API key** — never put the secret anywhere in this project.
4. Your username is the name in your Last.fm profile URL, e.g.
   `https://www.last.fm/user/yourname` → username is `yourname`.

---

## 3. Create your `.env`

The file `.env.example` is a safe template with empty values. Copy it and fill
in the two lines:

```bash
cp .env.example .env
# then edit .env in your editor:
# LASTFM_API_KEY=your_key_here
# LASTFM_USER=your_username_here
```

On Windows (PowerShell):

```powershell
Copy-Item .env.example .env
notepad .env
```

Rules we follow in this project:

- `.env` is listed in `.gitignore`, `.dockerignore` and is never committed.
- The values are read only from `process.env` at runtime.
- Nothing logs or returns the key. `/api/health`, `/api/top` and `/api/recent`
  contain no secrets; the username is returned so the header can show it.

If either variable is missing, the server prints a clear error and exits
without printing any values.

---

## 4. Run it

### With Docker (recommended)

```bash
docker compose up --build
```

Open <http://localhost:3000>. Port 3000 is the only port you need.
`docker compose` injects `.env` at runtime with `env_file`, so the image itself
contains no credentials. Stop with `Ctrl+C`, or `docker compose down`.

### Without Docker

Requires Node.js 18 or newer.

```bash
npm install
npm run start:env  # Node 20+: loads .env directly, no secrets printed
```

On Node 18, `--env-file` does not exist: export the two variables in your shell
instead, then run `npm start` (or `npm run dev` for auto-restart):

```bash
# macOS / Linux
set -a; source .env; set +a; npm start
```

```powershell
# Windows PowerShell — load .env into this process, then start
Get-Content .env | ForEach-Object { if ($_ -match '^([^=#]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2]) } }
npm start
```

Docker users can ignore all of this: Compose injects the variables from `.env`.

Open <http://localhost:3000>. To check the server quickly:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/top
curl http://localhost:3000/api/recent
```

---

## 5. The photo and the phone anchor

The bundled `public/assets/me.jpg` is a portrait scene: a phone in an open palm
at about `x = 51%`, `y = 52%`, with a cool halo rising above it. The app uses it
directly; there is no SVG fallback and no full-screen cover crop.

The `.stage` element keeps the photo's `941 / 1672` ratio. It fills the width on
a portrait phone and is viewport-height on a wide laptop, centred on a
`#0b0f17` page with feathered edges. Every anchor, light layer, card and wheel
measurement is relative to that stage (via `--stage-h` / `--stage-w`), never to
the viewport.

Default values are already tuned for the bundled photo:

```css
:root {
  --phone-x: 51;
  --phone-y: 52;
  --card-scale: 1;      /* front card ≈ 36% of stage height */
  --radius-scale: 1;      /* wheel spacing multiplier; 1 = full card gap */
}
```

Open <http://localhost:3000/?debug=1> to fine-tune. Click or drag on the stage
where the phone screen is; the panel prints the stage-relative percentages and
offers two sliders: **Card scale** (`--card-scale`) and **Wheel radius**
(`--radius-scale`). Values are saved locally under a versioned key, so settings
from the old viewport-based layout are ignored. Remove `?debug=1` when done.
The anchor drives the "rise out of the phone" animation, the contact light and
the centre of the wheel.

---

## 6. What to test

**On a laptop**

- One card rises out of the phone on load.
- Mouse wheel, click-drag and `←` / `→` rotate the wheel; it slows down and
  snaps to a card. `Esc` or "Back to phone" returns to the single card.
- Clicking a side card brings it to the front and marks it selected; clicking
  the front card again, Escape, Enter or "Back to phone" collapses to it. A new
  scroll/swipe reopens the wheel at that same card.
- The most-played card is visibly biggest and glows most; the least-played is
  smaller and dimmer but its title stays readable. A drag or a momentum scroll
  never accidentally selects a card.
- Space toggles the progress animation. The rewind/forward buttons move
  between cards.

**On a phone**

- Add to home screen is optional; just open the page.
- Swipe left/right with momentum; cards snap into place.
- Layout fits the screen; header and hint remain readable.

**Both**

- A song scrobbled several times appears as a single card (the most recent listen).
- `prefers-reduced-motion`: animations and inertia are disabled, snapping is
  instant.
- If you temporarily stop your server or block Last.fm, a cached response is
  still shown with the "last known listens" banner.
- Auto-refresh happens every 60 seconds (and when you return to the tab)
  without a page reload.

---

## 7. A short demo script (~3 minutes)

1. **0:00 — Concept.** "This is a photo of me and my phone. My Apple Music
   listens are scrobbled to Last.fm. I wanted to see what they *look* like."
2. **0:30 — Architecture.** Point at the diagram: "Browser → my Express server
   → Last.fm. The browser never sees my key. My server caches for 60 seconds
   so a crowd of visitors is still one request, and falls back to stale data
   if Last.fm is down."
3. **1:00 — The rise.** Reload: "The card starts flat (`rotateX(80deg)`, tiny,
   transparent) on the phone and stands up with a spring easing. A light cone,
   a bright contact line and a blurred cast shadow make it feel physical."
4. **1:30 — The wheel.** Scroll: "It becomes a cylinder around a vertical axis.
   Every poster keeps `rotateY` + `translateZ`, stays upright, and only ~11
   cards near the front are drawn even with 20 tracks. The radius adapts to the
   number of tracks so neighbouring posters never stack on top of each other.
   Total play count drives
   size and glow on a log scale; the floors keep the quietest card readable.
   Click a side card and it rotates to the front and stays selected through
   refreshes. The front is tinted by its cover; the sides turn to frosted glass
   with rim light and blur."
5. **2:15 — Data details.** "The browser reads `user.getRecentTracks` through my server;
   a cached `track.getInfo` lookup adds each song's total play count in the
   background, so the response never waits. It prefers extralarge artwork and
   tries iTunes,
   Deezer then `track.getInfo` when Last.fm gives the grey placeholder. Covers come
   through my own `/api/cover` proxy so I can read their pixels in a canvas and
   tint each card. Last.fm has no duration, so a stable seeded length drives
   the progress bar; now-playing animates for real."
6. **2:45 — Finish.** Show `?debug=1`, explain you swap `me.jpg` for your real
   photo, set the anchor and the two sliders, then press "Back to phone".

---

## 8. Files in this project

| File | Purpose |
| --- | --- |
| `server.js` | Express server, Last.fm + verified cover pipeline, caches, safe `/api/cover` proxy |
| `cover-match.js` | `normalize()`, artist/title verification and album scoring (unit-tested) |
| `test/cover-match.test.js` | North-star checks for matching and scoring |
| `package.json` | Dependencies and `npm start` / `npm run start:env` / `npm run dev` |
| `public/index.html` | Page structure, header, states, debug panel with sliders |
| `public/styles.css` | Stage geometry, photo grading, contact light, tinted + glass cards, 3D wheel |
| `public/app.js` | Rendering, dominant-colour canvas, stage-relative carousel math, input handling |
| `public/assets/me.jpg` | The portrait scene used by the stage |
| `Dockerfile`, `docker-compose.yml` | One-command Docker setup on port 3000 |
| `.env.example` | Empty template; copy to `.env` |
| `.gitignore`, `.dockerignore` | Keep secrets, dependencies and logs out of git/images |

### Do NOT commit

`.env`, `node_modules/`, `*.log`, `.git/` internals, and any real API key or
scrobble data you paste into notes. `.gitignore` already covers the first
three; `.dockerignore` keeps them out of the image too.
