# What your music looks like

A single page that turns your 20 most recent distinct Last.fm sounds into GIANT, glossy
"Now Playing" poster cards that look like physical objects inside a photo of
you. The card rises out of the flat phone. Your most-played track is the biggest
and the brightest; quieter ones stay smaller and dimmer, but always readable.
Scroll anywhere on the page (vertical swipe on mobile, trackpad, mouse wheel) or
press the arrow keys and your recent listens form a banked, perspective-projected
Saturn ring of upright posters around the phone/waist height; click any poster to
select it and rotate it to the front — the Instagram/Pinterest "floating music
player card" look, with the ring projected in JavaScript and the cards kept
perfectly upright.

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
- Every `/api/recent` response recomputes the `rank`: **#1 = highest total play
  count**, ties broken by recency, then null counts ordered by the fallback
  (repeat listens) and recency. The list and the ring are returned in that rank
  order; the browser only displays it. Background play-count fills can reshuffle
  the ring on the next poll, and the posters ease to their new slots over ~520 ms
  without losing the selection. `rankBy: "playCount"` is sent with every item.
- The browser receives plain JSON and draws the cards with CSS transforms
  (the phone card rises in 3D; the Saturn ring is projected in JavaScript).
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
a vertical gradient on the front card and as a tint on the ring line/band.
Cards further back switch to a frosted-glass material with a bright rim light,
and a 70/30 mix of photo white and the cover colour tints the soft spill on the
beam already present in the photo.

### Why the cache matters

A party of 20 visitors should not cause 20 Last.fm requests. The server keeps
one cached response for 60 seconds and shares one in-flight request between
simultaneous visitors. If Last.fm times out (5 s), is rate-limited or goes
down, the server serves the last good result with `"stale": true` and a
friendly message. The page then shows *"Last.fm is unreachable, showing the
last known listens from 14:32"* instead of breaking. If there is no cached
data at all, you get a clear error and a Retry button.

### Why the cards glow

The browser computes a log-scale weight across the tracks currently loaded:

```
w = (log(1 + count) - log(1 + min)) / (log(1 + max) - log(1 + min))
```

If every count is the same, `w = 0.5`. On the single phone card the weight still
drives size and lift; on the ring a poster's physical size follows its DEPTH on
the ellipse (front ~1.22×, back ~0.9×) while play count only drives the glow:

| Variable | Least played | Most played | Purpose |
| --- | --- | --- | --- |
| `--play-scale` | 0.82 | 1.12 | Phone-card size only |
| `--glow` | 0.25 | 1 | Rim, halo, gloss and cast shadow |
| `--play-lift` | 0 | 1 | Slight float for favourites |

The ring's depth cues are perspective-projected and clamped: opacity never drops
below 0.35, blur never exceeds 2 px, brightness never drops below 0.6 and
saturation never drops below 0.7, so the quietest back card is still readable.
The small label under the title now shows only the **play count** ("12 plays",
"1 play"), with a pulsing dot when the track is currently playing; a missing
Last.fm total shows the repeat-listen fallback prefixed with `~` ("~1 play").
The relative "played X ago" text is gone everywhere, though `playedAt` is still
kept in the data and in `?debug=1` output. The front card stays fully opaque and
sharp, with its rim light, larger play-count label and rewind/forward controls.
Clicking ANY card selects it and rotates it to the front; "Back to phone" /
Escape / Enter collapses to that selection, and a new swipe reopens the ring at
the same track.

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
`#0b0f17` page with feathered edges. Every anchor, light layer, card and ring
measurement is relative to that stage (via `--stage-h` / `--stage-w`), never to
the viewport.

Default values are already tuned for the bundled photo:

```css
:root {
  --phone-x: 51;        /* ring centre X */
  --phone-y: 52;        /* ring centre Y / phone height */
  --card-scale: 1;      /* phone card ≈ 36% of stage height */
  --ring-rx: 52;        /* % of stage width */
  --ring-ry: 17;        /* % of stage height, before --ring-tilt */
  --ring-roll: -9deg;   /* banks the whole ring; posters stay upright */
  --ring-tilt: 1;       /* multiplier on --ring-ry */
  --perspective: 2.2;   /* camera distance: lower = stronger perspective */
  --ring-cy-offset: 0px;
}
```

Open <http://localhost:3000/?debug=1> to fine-tune. Cards stay clickable; the
panel prints the current CSS values to the screen and console and offers sliders
for **Card scale**, **Ring radius X** (`--ring-rx`), **Ring roll**
(`--ring-roll`), **Ring tilt** (`--ring-tilt`), **Perspective**
(`--perspective`), **Ring Y offset** (`--ring-cy-offset`) and **Ring card size**,
plus **Show card hit areas** and **Pick phone anchor** toggles. Tick the anchor
toggle only while click or dragging on the photo to place the phone. The clicked
`data-id` is logged to the console so overlapping/back-half hits can be checked.
Values are saved locally under a versioned key, so settings from the old layouts
are ignored. Remove `?debug=1` when done. The anchor drives the "rise out of the
phone" animation, the contact light and the centre of the ring.

---

## 6. What to test

**On a laptop**

- One card rises out of the phone on load.
- Scrolling / swiping / dragging / `←` `→` opens the **Saturn ring**: up to 24
  upright posters stand on a banked, perspective-projected ellipse around the
  phone, large/sharp in front and small/dim/cool behind, with a subtle tinted
  ring band. A masked copy of the same photo covers the back half where it
  crosses the person's silhouette, so those posters pass genuinely BEHIND the
  body while the front half stays in front; front cards also get soft ring-plane
  shadows and colour reflections.
  The ring slows down and snaps to the nearest poster. `Esc`, Enter or "Back to
  phone" returns to the single card.
- Clicking ANY poster — front, side or back — selects it and rotates it to the
  front; clicking it again, Escape, Enter or "Back to phone" collapses to it. A
  new scroll/swipe reopens the ring at that same poster.
- Ring posters sit evenly around the ellipse at rank order (#1 = most listened),
  and the ones in FRONT are visibly larger than the ones behind. The #1 badge
  follows that rank, not the ring position. The header counter shows the
  selected rank over the total. Every poster shows its play count (never a
  relative time), larger on the front card. When background lookups arrive, the
  badges update and the posters ease into their new slots while the selection
  stays put. A drag or a momentum scroll never accidentally selects a card, and
  `?debug=1` hit outlines/console IDs confirm which `data-id` was hit for
  overlapping neighbours.
- Space toggles the progress animation. On the front card, rewind/forward
  select the previous/next poster; other cards' controls are decorative.

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
4. **1:30 — The ring.** Scroll: "The posters fly out of the phone and stand on
   a tilted Saturn ring around it — evenly spaced upright posters, with the
   near ones LARGER, sharp and opaque and the far ones smaller, dimmer and slightly
   blurred. The base size follows the projected neighbour gap, so more tracks
   simply mean smaller posters instead of crowding. Total play count still
   drives glow on a log scale. Click any card and it rotates by the shortest
   path to the front and stays selected through refreshes. The ring line and
   band are tinted by the front cover; back cards turn to frosted glass with
   rim light and blur."
5. **2:15 — Data details.** "The browser reads `user.getRecentTracks` through my server;
   a cached `track.getInfo` lookup adds each song's total play count in the
   background, so the response never waits. It prefers extralarge artwork and
   tries iTunes,
   Deezer then `track.getInfo` when Last.fm gives the grey placeholder. Covers come
   through my own `/api/cover` proxy so I can read their pixels in a canvas and
   tint each card. Last.fm has no duration, so a stable seeded length drives
   the progress bar; now-playing animates for real."
6. **2:45 — Finish.** Show `?debug=1`, explain you swap `me.jpg` for your real
   photo, set the anchor and the ring sliders, tick the hit-area outline to
   check the `data-id` log, then press "Back to phone".

---

## 8. Files in this project

| File | Purpose |
| --- | --- |
| `server.js` | Express server, Last.fm + verified cover pipeline, caches, safe `/api/cover` proxy |
| `cover-match.js` | `normalize()`, artist/title verification and album scoring (unit-tested) |
| `test/cover-match.test.js` | North-star checks for matching and scoring |
| `package.json` | Dependencies and `npm start` / `npm run start:env` / `npm run dev` |
| `public/index.html` | Page structure, header, states, debug panel with sliders |
| `public/styles.css` | Stage geometry, photo grading, contact light, tinted + glass cards, Saturn ring, pointer/hover states |
| `public/app.js` | Rendering, dominant-colour canvas, stage-relative ring projection, reliable hit-testing and input handling |
| `public/assets/me.jpg` | The portrait scene used by the stage |
| `Dockerfile`, `docker-compose.yml` | One-command Docker setup on port 3000 |
| `.env.example` | Empty template; copy to `.env` |
| `.gitignore`, `.dockerignore` | Keep secrets, dependencies and logs out of git/images |

### Do NOT commit

`.env`, `node_modules/`, `*.log`, `.git/` internals, and any real API key or
scrobble data you paste into notes. `.gitignore` already covers the first
three; `.dockerignore` keeps them out of the image too.
