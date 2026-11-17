# What your music looks like

A single page that turns your recent Last.fm scrobbles into GIANT, glossy
"Now Playing" poster cards that look like physical objects inside a photo of
you. The latest card rises out of the flat phone, is tinted with the dominant
colour of its album cover, casts a shadow and glows where it meets the phone.
Scroll, swipe or press the arrow keys and it becomes a 3D wheel of your latest
albums — the Instagram/Pinterest "floating music player card" look, made with
CSS 3D transforms.

Everything is deliberately simple: Node.js + Express on the server, plain
HTML/CSS/JavaScript in the browser, no build step and no front-end libraries.

---

## 1. How it works (the idea)

- You scrobble from Apple Music on iPhone with a scrobbler app. Those listens
  land in your Last.fm account.
- This app asks **its own server** for the last 50 listens.
- The server — and only the server — calls Last.fm, cleans up the data, finds
  missing album art via iTunes, and caches the result for 60 seconds.
- The browser receives plain JSON and draws the cards with CSS 3D transforms.
  The API key never reaches the browser.

```
Browser  ──GET /api/recent──▶  Express server  ──user.getRecentTracks──▶  Last.fm
   │                              │    │
   │                              │    ├── 60 s in-memory cache (+ stale fallback)
   │                              │    └── missing art ──▶ iTunes Search API (no key)
   │        ──GET /api/cover?u=…─▶│
   │           (same-origin)      └──────── cover bytes ──▶ Last.fm / Apple CDN
   └── static HTML/CSS/JS ──────── server
```

### Why the image proxy exists

The page reads each cover's pixels in a `<canvas>` to find its dominant colour.
A cross-origin image would taint the canvas, so the browser asks **our** server
for the image via `/api/cover?u=<url>`. That route allows only https URLs from
`*.mzstatic.com`, `lastfm.freetls.fastly.net`, `lastfm-img.freetls.fastly.net`
and `*.last.fm`, refuses redirects, caps the response at 5 MB, times out after
5 s and caches the bytes for 6 h. This keeps the canvas readable and prevents
SSRF: a visitor cannot make the server fetch arbitrary internal addresses.

The extracted colour is darkened until white text stays readable, then used as
a vertical gradient on the front card. Side cards switch to a frosted-glass
material with a bright rim light, and the front card's colour also tints the
light spilling onto the "surface" around the phone.

### Why the cache matters

A party of 20 visitors should not cause 20 Last.fm requests. The server keeps
one cached response for 60 seconds and shares one in-flight request between
simultaneous visitors. If Last.fm times out (5 s), is rate-limited or goes
down, the server serves the last good result with `"stale": true` and a
friendly message. The page then shows *"Last.fm is unreachable, showing the
last known listens from 14:32"* instead of breaking. If there is no cached data
at all, you get a clear error and a Retry button.

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
- Nothing logs or returns the key. `/api/health` and `/api/recent` contain no
  secrets; the username is returned so the header can show it.

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
curl http://localhost:3000/api/recent
```

---

## 5. The photo and the phone anchor

The bundled `public/assets/me.jpg` is only a **placeholder** — a dark portrait
scene with a flat phone in the lower middle. The app tries `me.jpg` first and
falls back to `me.svg` if it is missing.

1. Replace `public/assets/me.jpg` with your own photo. Keep the same filename.
   A portrait photo works best (cover-fit, centred).
2. Open <http://localhost:3000/?debug=1>.
3. Click or drag on the photo where the phone screen is. The panel shows the
   values and prints them in the browser console. It also has two sliders:
   **Card scale** (`--card-scale`, how big the front poster is) and **Wheel
   radius** (`--radius-scale`, how far the side cards sit). All four values are
   saved locally and printed together.
4. Put the anchor (and, if you tuned them, the scale values) in `public/styles.css`
   at the top:

```css
:root {
  --phone-x: 50;
  --phone-y: 68;
  --card-scale: 1;
  --radius-scale: 1;
}
```

Remove `?debug=1` when you are done. The anchor is used for the "rise out of
the phone" animation, the light glow and the centre of the wheel.

If your photo is **landscape** and the phone gets cropped out on a portrait
phone screen, adjust the crop near the top of `public/styles.css`:

```css
:root {
  --photo-x: 30%;   /* move the visible slice left / right */
  --photo-y: 50%;   /* move it up / down */
}
```

The anchor percent values are relative to the *visible* (cropped) photo, so
set the crop first, then run `?debug=1` to set the anchor.

---

## 6. What to test

**On a laptop**

- One card rises out of the phone on load.
- Mouse wheel, click-drag and `←` / `→` rotate the wheel; it slows down and
  snaps to a card. `Esc` or "Back to phone" returns to the single card.
- Clicking a side card brings it to the front.
- Space toggles the progress animation. The rewind/forward buttons move
  between cards.

**On a phone**

- Add to home screen is optional; just open the page.
- Swipe left/right with momentum; cards snap into place.
- Layout fits the screen; header and hint remain readable.

**Both**

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
   cards near the front are drawn even with 50 listens. The front is tinted by
   its cover; the sides turn to frosted glass with rim light and blur."
5. **2:15 — Data details.** "The server removes consecutive duplicate
   scrobbles, handles the now-playing track with no date, prefers extralarge
   artwork and asks iTunes when Last.fm gives the grey placeholder. Covers come
   through my own `/api/cover` proxy so I can read their pixels in a canvas and
   tint each card. Last.fm has no duration, so a stable seeded length drives
   the progress bar; now-playing animates for real."
6. **2:45 — Finish.** Show `?debug=1`, explain you swap `me.jpg` for your real
   photo, set the anchor and the two sliders, then press "Back to phone".

---

## 8. Files in this project

| File | Purpose |
| --- | --- |
| `server.js` | Express server, Last.fm + iTunes calls, 60 s cache, safe `/api/cover` proxy |
| `package.json` | Dependencies and `npm start` / `npm run start:env` / `npm run dev` |
| `public/index.html` | Page structure, header, states, debug panel with sliders |
| `public/styles.css` | Photo grading, light/shadow, tinted + glass card materials, 3D wheel |
| `public/app.js` | Rendering, dominant-colour canvas, carousel math, all input handling |
| `public/assets/me.jpg` | Placeholder photo — replace with your own |
| `public/assets/me.svg` | Fallback if the JPG is missing |
| `Dockerfile`, `docker-compose.yml` | One-command Docker setup on port 3000 |
| `.env.example` | Empty template; copy to `.env` |
| `.gitignore`, `.dockerignore` | Keep secrets, dependencies and logs out of git/images |

### Do NOT commit

`.env`, `node_modules/`, `*.log`, `.git/` internals, and any real API key or
scrobble data you paste into notes. `.gitignore` already covers the first
three; `.dockerignore` keeps them out of the image too.
