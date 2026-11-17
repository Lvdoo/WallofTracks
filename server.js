'use strict';

/*
 * What your music looks like — backend
 * ------------------------------------
 * The browser only ever talks to THIS server. Only this server talks to Last.fm
 * (and to the public iTunes Search API for missing album artwork).
 *
 * Secrets: we only check that process.env.LASTFM_API_KEY and process.env.LASTFM_USER
 * exist. We never log them, never echo them, and never put them in a response.
 */

const express = require('express');
const path = require('path');

/* ------------------------------------------------------------------ *
 * 1. Startup check — fail early, clearly, WITHOUT printing any values
 * ------------------------------------------------------------------ */
if (!process.env.LASTFM_API_KEY || !process.env.LASTFM_USER) {
  console.error(
    '[startup] Missing configuration: LASTFM_API_KEY and LASTFM_USER must both be set. ' +
    'Copy .env.example to .env and fill in both values, then restart. Exiting.'
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 2. Tunable constants
 * ------------------------------------------------------------------ */
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 60 * 1000;          // Last.fm response cache: 60 seconds
const COVER_TTL = 6 * 60 * 60 * 1000; // iTunes artwork cache: 6 hours
const RETRY_DELAY = 60 * 1000;        // Backoff after a failed Last.fm call
const REQUEST_TIMEOUT = 5000;         // Abort any upstream request after 5 s
const GREY_COVER_HASH = '2a96cbd8b46e442fc41c2b86b821562f'; // Last.fm placeholder
const MAX_COVER_BYTES = 5 * 1024 * 1024; // Refuse to proxy huge images (SSRF guard)
const PROXY_CACHE_TTL = 6 * 60 * 60 * 1000; // Proxied image bytes live 6 h

/* ------------------------------------------------------------------ *
 * 3. In-memory state (no database — intentionally simple)
 * ------------------------------------------------------------------ */
let cache = null;       // { tracks: [...], fetchedAt: ISO string }
let pending = null;     // Shared in-flight promise so many visitors cost ONE Last.fm call
let retryAt = 0;        // Don't hammer Last.fm while it is down
let lastFailure = null; // Safe, human-readable message from the last failure
const coverCache = new Map(); // "artist|album" -> { image: string|null, expiresAt: number }
const proxyCache = new Map(); // cover URL -> { body: Buffer, type: string, expiresAt: number }

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

/* ------------------------------------------------------------------ *
 * 4. Small helpers
 * ------------------------------------------------------------------ */

/** Create an Error whose message is safe to show to a browser (no URL, no key). */
function safeError(kind, message) {
  const err = new Error(message);
  err.kind = kind;     // Used only for terse console output
  err.safe = true;
  return err;
}

/**
 * fetch() with a 5 second deadline. All errors are converted to safe errors:
 * native fetch errors can contain the full request URL, so we never print or
 * forward them. `url` is only used to make the request, never in a message.
 */
async function fetchJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      // Last.fm sometimes sends its JSON error code with a non-200 status.
      // Keep the parsed body on the safe error so the caller can translate it.
      const error = safeError('http', `${label} returned HTTP ${response.status}.`);
      try { error.body = await response.json(); } catch (_) { /* no useful body */ }
      throw error;
    }
    try {
      return await response.json();
    } catch (parseError) {
      throw safeError('parse', `${label} returned data we could not read.`);
    }
  } catch (err) {
    if (err && err.safe) throw err;
    if (err && err.name === 'AbortError') {
      throw safeError('timeout', `${label} did not answer within 5 seconds.`);
    }
    throw safeError('network', `${label} is unreachable right now.`);
  } finally {
    clearTimeout(timer);
  }
}

/** Run async work over a list with a small fixed concurrency (be nice to APIs). */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Last.fm wraps text values in { '#text': '...' }; normalise both shapes. */
function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value['#text'] === 'string') return value['#text'].trim();
  return '';
}

/** Reject empty URLs and Last.fm's well-known grey placeholder image. */
function validImage(url) {
  return typeof url === 'string' &&
    /^https?:\/\//i.test(url) &&
    !url.includes(GREY_COVER_HASH);
}

/** Prefer the extralarge Last.fm image, then progressively smaller sizes. */
function pickLastfmImage(track) {
  const images = Array.isArray(track.image) ? track.image : [];
  for (const size of ['extralarge', 'large', 'medium', 'small']) {
    const entry = images.find((image) => image && image.size === size);
    if (entry && validImage(entry['#text'])) return entry['#text'];
  }
  return null;
}

/**
 * Last.fm does not send a duration. Use a stable, seeded "plausible" length
 * (2:00–5:09) so the same song always shows the same progress bar.
 */
function pseudoDurationSec(artist, name) {
  const seed = `${artist}|${name}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return 120 + (Math.abs(hash) % 190);
}

/** Turn one raw Last.fm track into the shape the frontend expects. */
function normalizeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = text(raw.name);
  if (!name) return null;

  const nowPlaying =
    raw['@attr'] && String(raw['@attr'].nowplaying).toLowerCase() === 'true';
  const uts = Number(raw.date && raw.date.uts);
  const artist = text(raw.artist && raw.artist['#text']) || text(raw.artist && raw.artist.name);

  return {
    track: name,
    artist,
    album: text(raw.album && raw.album['#text']) || text(raw.album && raw.album.name),
    image: pickLastfmImage(raw),
    durationSec: pseudoDurationSec(artist, name),
    nowPlaying: Boolean(nowPlaying),
    // The now-playing track has NO date in Last.fm's response.
    playedAt: !nowPlaying && Number.isFinite(uts) && uts > 0
      ? new Date(uts * 1000).toISOString()
      : null
  };
}

/** Keep only consecutive repeats (A, A, B, A stays A, B, A). */
function removeConsecutiveDuplicates(tracks) {
  return tracks.filter((current, index) => {
    if (index === 0) return true;
    const previous = tracks[index - 1];
    const same =
      current.track.toLowerCase() === previous.track.toLowerCase() &&
      current.artist.toLowerCase() === previous.artist.toLowerCase() &&
      current.album.toLowerCase() === previous.album.toLowerCase();
    return !same;
  });
}

function coverKey(artist, album) {
  return `${artist}|${album}`.toLowerCase();
}

/**
 * Look up a missing cover in the public iTunes Search API (no key needed).
 * Returns `null` on any failure: artwork is a nice-to-have, never fatal.
 */
async function getItunesCover(artist, album) {
  if (!artist) return null;

  const key = coverKey(artist, album);
  const hit = coverCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.image;

  const term = album ? `${artist} ${album}` : artist;
  const url = 'https://itunes.apple.com/search?term=' +
    encodeURIComponent(term) + '&entity=album&limit=5';

  let image = null;
  try {
    const json = await fetchJson(url, 'iTunes Search');
    const results = Array.isArray(json.results) ? json.results : [];
    const artwork = results.find(
      (item) => item && typeof item.artworkUrl100 === 'string' &&
        /^https:\/\//i.test(item.artworkUrl100)
    );
    // iTunes hands us 100px art; the same URL with 600x600 is served at 600px.
    if (artwork) image = artwork.artworkUrl100.replace('100x100bb', '600x600bb');
  } catch (err) {
    // Log only the safe category, never the URL or any secret.
    console.warn(`[artwork] lookup skipped (${err.kind || 'error'})`);
  }

  // Cache successes AND failures so a broken lookup is not repeated constantly.
  coverCache.set(key, {
    image,
    expiresAt: Date.now() + (image ? COVER_TTL : 60 * 1000)
  });
  return image;
}

/** Translate Last.fm's numeric error codes into clear, safe messages. */
function lastfmFailure(code) {
  const known = {
    10: 'Last.fm rejected the API key. Check LASTFM_API_KEY in your .env file.',
    6: 'Last.fm could not find that user. Check LASTFM_USER in your .env file.',
    29: 'Last.fm rate limit reached. Please try again shortly.'
  };
  return safeError(`lastfm-${code}`, known[code] || `Last.fm returned an error (code ${code}).`);
}

/** Call Last.fm, normalise the response, then repair missing artwork. */
async function refreshTracks() {
  // The key and user are read directly from the environment at request time.
  // This URL is never logged or returned to the client.
  const url = 'https://ws.audioscrobbler.com/2.0/' +
    '?method=user.getRecentTracks' +
    '&user=' + encodeURIComponent(process.env.LASTFM_USER) +
    '&api_key=' + encodeURIComponent(process.env.LASTFM_API_KEY) +
    '&limit=50&extended=1&format=json';

  let json;
  try {
    json = await fetchJson(url, 'Last.fm');
  } catch (err) {
    if (err.body && err.body.error) throw lastfmFailure(Number(err.body.error));
    throw err;
  }

  if (json && json.error) throw lastfmFailure(Number(json.error));

  const raw = json && json.recenttracks && json.recenttracks.track;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const tracks = removeConsecutiveDuplicates(
    list.map(normalizeTrack).filter(Boolean)
  ).slice(0, 50);

  // Apple Music scrobbles often lack usable art. Resolve each unique album once.
  const needed = new Map();
  tracks.forEach((track) => {
    if (!track.image) {
      const album = track.album || track.track;
      const key = coverKey(track.artist, album);
      if (!needed.has(key)) needed.set(key, { artist: track.artist, album });
    }
  });
  const resolved = await mapLimit([...needed.entries()], 4, async ([key, value]) => {
    return [key, await getItunesCover(value.artist, value.album)];
  });
  const covers = new Map(resolved);
  tracks.forEach((track) => {
    if (!track.image) {
      track.image = covers.get(coverKey(track.artist, track.album || track.track)) || null;
    }
  });

  return tracks;
}

/** Human-readable timestamp used in the stale-data message. */
function when(iso) {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString();
}

/* ------------------------------------------------------------------ *
 * 5. Routes
 * ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'what-your-music-looks-like',
    uptimeSeconds: Math.round(process.uptime()),
    cachedTracks: cache ? cache.tracks.length : 0
  });
});

app.get('/api/recent', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const username = process.env.LASTFM_USER;

  // A fresh cache is returned immediately — no upstream call at all.
  const fresh = cache && Date.now() - Date.parse(cache.fetchedAt) < CACHE_TTL;
  if (fresh) {
    return res.json({
      username,
      tracks: cache.tracks,
      fetchedAt: cache.fetchedAt,
      stale: false
    });
  }

  // If a previous attempt failed recently, keep serving the old data quietly.
  if (cache && Date.now() < retryAt) {
    return res.json({
      username,
      tracks: cache.tracks,
      fetchedAt: cache.fetchedAt,
      stale: true,
      message: `Last.fm is unreachable, showing the last known listens from ${when(cache.fetchedAt)}.`
    });
  }

  try {
    // Share one request between all visitors who arrive at the same time.
    if (!pending) {
      pending = refreshTracks()
        .then((tracks) => {
          cache = { tracks, fetchedAt: new Date().toISOString() };
          retryAt = 0;
          lastFailure = null;
          return tracks;
        })
        .catch((err) => {
          lastFailure = err.message;
          retryAt = Date.now() + RETRY_DELAY;
          throw err;
        })
        .finally(() => { pending = null; });
    }

    await pending;
    return res.json({
      username,
      tracks: cache.tracks,
      fetchedAt: cache.fetchedAt,
      stale: false
    });
  } catch (err) {
    if (cache) {
      const message = `Last.fm is unreachable, showing the last known listens from ${when(cache.fetchedAt)}.`;
      return res.json({
        username,
        tracks: cache.tracks,
        fetchedAt: cache.fetchedAt,
        stale: true,
        message
      });
    }
    // Nothing cached: a clear error, still with no key and no request URL.
    return res.status(502).json({
      username,
      tracks: [],
      fetchedAt: null,
      stale: false,
      error: lastFailure || 'Unable to load recent listens right now. Please try again shortly.'
    });
  }
});

/* ------------------------------------------------------------------ *
 * 6. Same-origin image proxy for cover art
 * ------------------------------------------------------------------ *
 * The frontend draws covers into a <canvas> to find their dominant colour.
 * A cross-origin image would taint the canvas, so we fetch it here instead.
 * Strict host allowlist + https + redirect refusal + size limit + timeout
 * make this safe against SSRF (the browser can only ask for known image hosts).
 */
const ALLOWED_COVER_HOSTS = new Set([
  'lastfm.freetls.fastly.net',
  'lastfm-img.freetls.fastly.net', // Last.fm also serves this hostname
  'last.fm'
]);

function coverHostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return ALLOWED_COVER_HOSTS.has(host) ||
    host.endsWith('.last.fm') ||
    host.endsWith('.mzstatic.com');
}

app.get('/api/cover', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const requested = typeof req.query.u === 'string' ? req.query.u : '';

  let url;
  try {
    url = new URL(requested);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid cover URL.' });
  }
  if (url.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only https cover URLs are allowed.' });
  }
  if (!coverHostAllowed(url.hostname)) {
    return res.status(400).json({ error: 'This cover host is not allowed.' });
  }

  // A cached image is returned directly, with no upstream request at all.
  const hit = proxyCache.get(requested);
  if (hit && hit.expiresAt > Date.now()) {
    res.set('Content-Type', hit.type);
    res.set('Cache-Control', 'public, max-age=21600');
    return res.send(hit.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let reader = null;
  try {
    const upstream = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'manual', // never follow a redirect to an internal address
      headers: { Accept: 'image/*' }
    });
    if (!upstream.ok) throw safeError('http', 'Cover image could not be loaded.');

    const type = String(upstream.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//i.test(type)) throw safeError('type', 'That URL is not an image.');

    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared > MAX_COVER_BYTES) throw safeError('size', 'Cover image is too large.');

    reader = upstream.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_COVER_BYTES) throw safeError('size', 'Cover image is too large.');
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    proxyCache.set(requested, { body, type, expiresAt: Date.now() + PROXY_CACHE_TTL });

    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=21600');
    return res.send(body);
  } catch (err) {
    // Log only the safe category: native errors can contain the request URL.
    if (!err.safe) console.warn(`[cover] fetch skipped (${err.name || 'error'})`);
    if (err.kind === 'size') return res.status(413).json({ error: err.message });
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Cover image timed out.' });
    return res.status(502).json({ error: (err.safe && err.message) || 'Cover image could not be loaded.' });
  } finally {
    clearTimeout(timer);
    if (reader) reader.cancel().catch(() => {});
  }
});

/* ------------------------------------------------------------------ *
 * 7. Static frontend
 * ------------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const server = app.listen(PORT, () => {
  console.log(`[server] What your music looks like is running on http://localhost:${PORT}`);
});

// Ctrl+C / Docker stop should close cleanly.
function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
