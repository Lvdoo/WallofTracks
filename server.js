'use strict';

/*
 * What your music looks like — backend
 * ------------------------------------
 * The browser only ever talks to THIS server. Only this server talks to Last.fm
 * (and, for missing artwork, to the public iTunes and Deezer search APIs).
 *
 * Secrets: we only check that process.env.LASTFM_API_KEY and process.env.LASTFM_USER
 * exist. We never log them, never echo them, and never put them in a response.
 */

const express = require('express');
const path = require('path');
const {
  normalize,
  artistSet,
  featArtistSet,
  wantedArtistSet,
  artistMatches,
  pickBestCandidate,
  lastfmInfoVerified,
  scoreCandidate,
  classifyCandidate,
  validCoverUrl
} = require('./cover-match');

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
const TOP_LIMIT = 20;                  // All-time favourites shown in the wheel
const RECENT_LIMIT = 20;               // Last listens kept in /api/recent
const RECENT_FETCH_LIMIT = RECENT_LIMIT * 2; // Fetch extra so de-duplication still fills the list
const CACHE_TTL = 60 * 1000;           // Last.fm response cache: 60 seconds
const RETRY_DELAY = 60 * 1000;         // Backoff after a failed Last.fm call
const REQUEST_TIMEOUT = 5000;          // Default upstream timeout for track lists
const COVER_LOOKUP_TIMEOUT = 4000;     // Timeout for each cover source
const COVER_CONCURRENCY = 4;           // Max simultaneous outbound lookups
const COVER_CACHE_TTL = 24 * 60 * 60 * 1000; // Verified cover: 24 h
const COVER_MISS_TTL = 10 * 60 * 1000; // "Not found": retry sooner
const PLAYCOUNT_LOOKUP_TIMEOUT = 4000;  // Timeout for a Last.fm play-count lookup
const PLAYCOUNT_CACHE_TTL = 60 * 60 * 1000; // Per-track play count: 1 h
const GREY_COVER_HASH = '2a96cbd8b46e442fc41c2b86b821562f'; // Last.fm placeholder
const MAX_COVER_BYTES = 5 * 1024 * 1024; // Refuse to proxy huge images (SSRF guard)
const PROXY_CACHE_TTL = 6 * 60 * 60 * 1000; // Proxied image bytes live 6 h

/* ------------------------------------------------------------------ *
 * 3. In-memory state (no database — intentionally simple)
 * ------------------------------------------------------------------ */
/**
 * One independent store per list: the last 20 distinct sounds and the all-time top 20.
 * Each holds a cached response, a shared in-flight promise (so a crowd of
 * visitors costs ONE Last.fm call), a retry deadline and a safe error message.
 */
function makeStore() {
  return { cache: null, pending: null, retryAt: 0, lastFailure: null };
}
const recentStore = makeStore();
const topStore = makeStore();

const coverStore = new Map();   // normalized "artistSet+track+album" -> { image, source, album, expiresAt }
const coverPending = new Map(); // same key -> shared in-flight Promise
const playCountStore = new Map();  // normalized "artist+track" -> { count: number|null, expiresAt }
const playCountPending = new Map(); // same key -> shared in-flight Promise
const proxyCache = new Map();   // cover URL -> { body: Buffer, type: string, expiresAt: number }

// Tiny semaphore: at most COVER_CONCURRENCY outbound cover lookups at once.
let activeLookups = 0;
const lookupQueue = [];

function releaseLookupSlot() {
  activeLookups--;
  const next = lookupQueue.shift();
  if (next) next();
}

function acquireLookupSlot() {
  if (activeLookups < COVER_CONCURRENCY) {
    activeLookups++;
    return Promise.resolve(releaseLookupSlot);
  }
  return new Promise((resolve) => lookupQueue.push(resolve)).then(() => {
    activeLookups++;
    return releaseLookupSlot;
  });
}

async function withLookupSlot(work) {
  const release = await acquireLookupSlot();
  let released = false;
  try {
    return await work();
  } finally {
    if (!released) { released = true; release(); }
  }
}

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
 * fetch() with a deadline (5 s for track lists, 4 s per cover source). All
 * errors are converted to safe errors: native fetch errors can contain the
 * full request URL, so we never print or forward them. `url` is only used to
 * make the request, never in a message.
 */
async function fetchJson(url, label, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      throw safeError('timeout', `${label} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw safeError('network', `${label} is unreachable right now.`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Diagnostic-only fetch: reports HTTP status and raw counts without ever
 * throwing, and never includes a URL in its error text. Used solely by the
 * gated /api/debug/cover endpoint.
 */
async function fetchJsonDetailed(url, label, timeoutMs = COVER_LOOKUP_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    let json = null;
    try { json = await response.json(); } catch (_) { /* not JSON */ }
    return { status: response.status, ok: response.ok, json, error: null };
  } catch (err) {
    return {
      status: null,
      ok: false,
      json: null,
      error: err && err.name === 'AbortError' ? 'timeout' : 'network error'
    };
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

/* ------------------------------------------------------------------ *
 * 4a. Play counts — cached, shared, and NEVER in the request path
 * ------------------------------------------------------------------ */

/** Cache key: normalized artist + track (no album, no secret, no URL). */
function playCountKey(track) {
  return `${normalize(track.artist)}|${normalize(track.track)}`;
}

function freshPlayCount(key) {
  const entry = playCountStore.get(key);
  return entry && entry.expiresAt > Date.now() ? entry : null;
}

/** One Last.fm track.getInfo call. Returns null on ANY failure (safe errors only). */
async function lookupPlayCount(track) {
  if (!track.artist || !track.track) return null;
  const url = 'https://ws.audioscrobbler.com/2.0/' +
    '?method=track.getInfo' +
    '&artist=' + encodeURIComponent(track.artist) +
    '&track=' + encodeURIComponent(track.track) +
    '&autocorrect=1' +
    '&username=' + encodeURIComponent(process.env.LASTFM_USER) +
    '&api_key=' + encodeURIComponent(process.env.LASTFM_API_KEY) +
    '&format=json';

  try {
    // Reuse the existing 4-slot semaphore. This lookup is fire-and-forget, so
    // a slow/failing Last.fm never delays /api/recent.
    const json = await withLookupSlot(
      () => fetchJson(url, 'Last.fm play count', PLAYCOUNT_LOOKUP_TIMEOUT)
    );
    if (json && json.error) return null;
    const value = Number(json && json.track && json.track.userplaycount);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  } catch (_) {
    // Never print the URL: native errors may contain the API key.
    return null;
  }
}

/**
 * Start background lookups for tracks we do not know yet. The promises are
 * deliberately not returned: the HTTP response is written immediately.
 */
function schedulePlayCountFills(tracks) {
  const byKey = new Map();
  tracks.forEach((track) => {
    const key = playCountKey(track);
    if (!key || key === '|' || freshPlayCount(key) || playCountPending.has(key)) return;
    if (!byKey.has(key)) byKey.set(key, track);
  });

  for (const [key, track] of byKey) {
    const promise = (async () => {
      const count = await lookupPlayCount(track);
      // A failure is cached as null for an hour, so one bad track cannot make
      // every /api/recent poll retry it.
      playCountStore.set(key, { count, expiresAt: Date.now() + PLAYCOUNT_CACHE_TTL });
    })().finally(() => playCountPending.delete(key));
    playCountPending.set(key, promise);
    promise.catch(() => {}); // already handled; keep Node from complaining
  }
}

/**
 * Rank by TOTAL play count: #1 = most played. Known counts come first, ties are
 * broken by recency; tracks whose count is still null follow, ordered by the
 * fallback count (occurrences in the recent list) and then recency. This runs
 * on EVERY response, so a background fill reshuffles the ring on the next poll.
 */
function rankByPlayCount(tracks) {
  const recency = (track) => {
    if (track.nowPlaying) return Number.POSITIVE_INFINITY;
    const ts = track.playedAt ? Date.parse(track.playedAt) : 0;
    return Number.isFinite(ts) ? ts : 0;
  };
  const known = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
  const fallbackOf = (track) => Math.max(1, Number(track.fallbackCount) || 1);

  return tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => {
      const aKnown = known(a.track.playCount);
      const bKnown = known(b.track.playCount);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (aKnown && bKnown) {
        const diff = Number(b.track.playCount) - Number(a.track.playCount);
        if (diff) return diff;
      } else {
        const diff = fallbackOf(b.track) - fallbackOf(a.track);
        if (diff) return diff;
      }
      const aRec = recency(a.track);
      const bRec = recency(b.track);
      if (aRec !== bRec) return bRec > aRec ? 1 : -1;
      return a.index - b.index; // stable when everything ties
    })
    .map(({ track }, index) => ({ ...track, rank: index + 1, rankBy: 'playCount' }));
}

/**
 * Overlay the values we already know onto a fresh copy of the list. This runs
 * on EVERY /api/recent request, so values discovered in the background show up
 * on the next poll without waiting for the 60 s track cache to expire.
 */
function withPlayCountFields(tracks, req) {
  schedulePlayCountFills(tracks);
  const debugged = req.query.debug === '1' && debugCoversEnabled();

  const enriched = tracks.map((track) => {
    const key = playCountKey(track);
    const entry = freshPlayCount(key);
    const count = entry ? entry.count : null;
    return {
      ...track,
      playCount: count,
      fallbackCount: Math.max(1, Number(track.fallbackCount) || 1),
      ...(debugged ? { playCountSource: count == null ? 'recent' : 'lastfm' } : {})
    };
  });

  return withDebugFields(rankByPlayCount(enriched), req);
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
  const lastfmPlaycount = Number(raw.playcount);
  const rank = Number(raw['@attr'] && raw['@attr'].rank);

  return {
    track: name,
    artist,
    album: text(raw.album && raw.album['#text']) || text(raw.album && raw.album.name),
    image: pickLastfmImage(raw),
    durationSec: pseudoDurationSec(artist, name),
    // Only user.getTopTracks supplies these; recent listens get nulls.
    // Named distinctly from playCount so the JSON has no case-only duplicate.
    lastfmPlaycount: Number.isFinite(lastfmPlaycount) && lastfmPlaycount > 0 ? lastfmPlaycount : null,
    rank: Number.isFinite(rank) && rank > 0 ? rank : null,
    nowPlaying: Boolean(nowPlaying),
    // The now-playing track has NO date in Last.fm's response.
    playedAt: !nowPlaying && Number.isFinite(uts) && uts > 0
      ? new Date(uts * 1000).toISOString()
      : null
  };
}

/** Accent-insensitive artist+track identity, shared by dedup and ranking. */
function trackIdentityKey(track) {
  return [track.artist, track.track]
    .map((value) => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim())
    .join('|');
}

/**
 * Keep one card per song. Last.fm's recent list is newest-first and can contain
 * the same track several times (repeat scrobbles, or the same song credited to
 * a different release). The wheel should show each sound once, so keep the
 * first (most recent) occurrence and drop the rest.
 */
function removeDuplicateTracks(tracks) {
  const seen = new Set();
  return tracks.filter((track) => {
    const key = trackIdentityKey(track);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

/**
 * Call one Last.fm user method. The key and user are read from the environment
 * at request time; this URL is never logged or returned to the browser.
 */
async function fetchLastfmTracks(method, limit) {
  const url = 'https://ws.audioscrobbler.com/2.0/' +
    '?method=' + method +
    '&user=' + encodeURIComponent(process.env.LASTFM_USER) +
    '&api_key=' + encodeURIComponent(process.env.LASTFM_API_KEY) +
    '&limit=' + limit + '&extended=1&format=json';

  let json;
  try {
    json = await fetchJson(url, 'Last.fm');
  } catch (err) {
    if (err.body && err.body.error) throw lastfmFailure(Number(err.body.error));
    throw err;
  }
  if (json && json.error) throw lastfmFailure(Number(json.error));
  return json;
}

/* ------------------------------------------------------------------ *
 * 4b. Cover resolution — verified hits only, in priority order
 * ------------------------------------------------------------------ */

/** Cache per normalized (artistSet + track + album). */
function coverCacheKey(track) {
  return `${wantedArtistSet(track).sort().join('+')}|${normalize(track.track)}|${normalize(track.album)}`;
}

/** Short, single-line labels for logs. Never a URL, never a secret. */
function short(value, max = 42) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Log a failed source by category only — native errors contain the URL. */
function logSourceSkip(source, err) {
  console.warn(`[cover] ${source} skipped (${err.kind || err.name || 'error'})`);
}

/** One outbound lookup, under the shared 4-slot semaphore and 4 s deadline. */
async function lookupJson(label, url) {
  return withLookupSlot(() => fetchJson(url, label, COVER_LOOKUP_TIMEOUT));
}

function albumNamesMatch(wanted, candidate) {
  const a = normalize(wanted);
  const b = normalize(candidate);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

/**
 * B: iTunes FR then US. Song/mainArtist, song/secondArtist, then album plus
 * a lookup inside that album. Stop at the first VERIFIED hit.
 */
async function fromItunes(track) {
  const clean = cleanTitle(track.track);
  const first = mainArtist(track.artist);
  const second = secondArtist(track.artist);
  const cleanAlbum = cleanTitle(track.album);

  for (const country of ['FR', 'US']) {
    const songQueries = [[clean, first]];
    if (second) songQueries.push([clean, second]);

    for (const [title, artist] of songQueries) {
      if (!title || !artist) continue;
      try {
        const json = await lookupJson('iTunes Search',
          itunesDebugUrl(`${title} ${artist}`, 'song', country));
        const best = pickBestCandidate(itunesRows(json), track);
        if (best) return best;
      } catch (err) {
        logSourceSkip(`itunes-${country}-song`, err);
      }
    }

    if (!cleanAlbum || !first) continue;
    try {
      const json = await lookupJson('iTunes Albums',
        itunesDebugUrl(`${cleanAlbum} ${first}`, 'album', country));
      const albums = itunesRows(json).filter((album) =>
        validCoverUrl(album.image) &&
        artistMatches(track, album) &&
        albumNamesMatch(track.album, album.album)
      );
      for (const album of albums.slice(0, 8)) {
        if (!album.collectionId) continue;
        try {
          const inside = await lookupJson('iTunes Album Tracks',
            'https://itunes.apple.com/lookup?id=' + encodeURIComponent(album.collectionId) +
              '&entity=song&limit=200&country=' + country);
          const song = pickBestCandidate(
            itunesRows(inside).filter((row) => artistMatches(track, row)),
            track
          );
          if (song) {
            return { ...album, track: song.track, releaseDate: song.releaseDate || album.releaseDate };
          }
        } catch (err) {
          logSourceSkip(`itunes-${country}-album-tracks`, err);
        }
      }
    } catch (err) {
      logSourceSkip(`itunes-${country}-album`, err);
    }
  }
  return null;
}

/** C: Deezer plain /search/track first; advanced form only if it is empty. */
async function fromDeezer(track) {
  const clean = cleanTitle(track.track);
  const first = mainArtist(track.artist);
  let rows = [];
  try {
    rows = deezerRows(await lookupJson('Deezer Search',
      deezerDebugUrl(`${clean} ${first}`, 'search/track', 25)));
  } catch (err) {
    logSourceSkip('deezer-plain', err);
  }
  if (rows.length === 0) {
    try {
      rows = deezerRows(await lookupJson('Deezer Advanced',
        deezerDebugUrl(`artist:"${first}" track:"${clean}"`, 'search/track', 25)));
    } catch (err) {
      logSourceSkip('deezer-advanced', err);
    }
  }
  return pickBestCandidate(rows, track);
}

/** D: Last.fm track.getInfo — LAST resort; the key stays server-side. */
async function fromLastfmInfo(track) {
  if (!track.artist || !track.track) return null;
  let json;
  try {
    json = await lookupJson('Last.fm track info', lastfmInfoDebugUrl(track));
  } catch (err) {
    logSourceSkip('lastfm-trackinfo', err);
    return null;
  }
  if (json && json.error) return null;
  const candidate = lastfmInfoRow(json);
  if (!candidate || !lastfmInfoVerified(candidate, track)) return null;
  return candidate;
}

/* ------------------------------------------------------------------ *
 * 4c. Diagnostic helpers — used ONLY by the gated /api/debug/cover route.
 *     No secret value ever reaches these strings.
 * ------------------------------------------------------------------ */

function debugCoversEnabled() {
  return process.env.NODE_ENV !== 'production' || process.env.DEBUG_COVERS === '1';
}

/** Strip query parameters that carry credentials before a URL is displayed. */
function redactSecrets(url) {
  return String(url)
    .replace(/([?&](?:api_key|apikey)=)[^&]*/gi, '$1[REDACTED]')
    .replace(/([?&]user=)[^&]*/gi, '$1[REDACTED]');
}

/** Exactly the "cleanTrack" described in the diagnostic request. */
function cleanTitle(value) {
  return text(value)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[\s\-–—:]+\b(?:feat|featuring|ft|with)\b\.?.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mainArtist(value) {
  return artistSet(value)[0] || text(value);
}

function secondArtist(value) {
  return artistSet(value)[1] || null;
}

function itunesDebugUrl(term, entity, country, limit = 25) {
  return 'https://itunes.apple.com/search?term=' + encodeURIComponent(term) +
    '&entity=' + entity + '&limit=' + limit + '&country=' + country;
}

function deezerDebugUrl(query, path = 'search/track', limit = 25) {
  return 'https://api.deezer.com/' + path + '?q=' + encodeURIComponent(query) +
    '&limit=' + limit;
}

function lastfmInfoDebugUrl(track) {
  return 'https://ws.audioscrobbler.com/2.0/' +
    '?method=track.getInfo' +
    '&artist=' + encodeURIComponent(track.artist) +
    '&track=' + encodeURIComponent(track.track) +
    '&autocorrect=1' +
    '&api_key=' + encodeURIComponent(process.env.LASTFM_API_KEY) +
    '&format=json';
}

/** Map one raw API row to the common candidate shape (no decision made). */
function itunesRow(row) {
  if (!row) return null;
  return {
    artist: text(row.artistName),
    track: text(row.trackName),
    album: text(row.collectionName),
    image: typeof row.artworkUrl100 === 'string'
      ? row.artworkUrl100.replace('100x100bb', '600x600bb') : null,
    releaseDate: text(row.releaseDate),
    // Needed for the "album then find the track inside it" query.
    collectionId: row.collectionId || null
  };
}

function itunesRows(json) {
  return (Array.isArray(json && json.results) ? json.results : []).map(itunesRow).filter(Boolean);
}

function deezerRows(json) {
  return (Array.isArray(json && json.data) ? json.data : []).map(deezerRow).filter(Boolean);
}

function deezerRow(row) {
  if (!row) return null;
  const album = row.album || {};
  const image = validCoverUrl(album.cover_xl) ? album.cover_xl
    : (validCoverUrl(album.cover_big) ? album.cover_big : null);
  return {
    artist: text(row.artist && row.artist.name),
    track: text(row.title),
    album: text(album.title),
    image,
    releaseDate: text(row.release_date)
  };
}

function lastfmInfoRow(json) {
  const info = json && json.track;
  const album = info && info.album;
  if (!album) return null;
  const image = pickLastfmImage(album);
  return {
    artist: text(info.artist && (info.artist.name || info.artist['#text'])),
    track: text(info.name),
    album: text(album.title),
    image: validCoverUrl(image) ? image : null,
    releaseDate: ''
  };
}

/** Show what the matcher sees and why it accepted/rejected a candidate. */
function describeCandidate(candidate, wanted, classifyOptions) {
  return {
    artist: candidate.artist,
    track: candidate.track,
    album: candidate.album,
    coverUrl: candidate.image,
    normalized: {
      artist: normalize(candidate.artist),
      track: normalize(candidate.track),
      album: normalize(candidate.album)
    },
    artistSet: artistSet(candidate.artist),
    score: Math.round(scoreCandidate(candidate, wanted) * 100) / 100,
    reason: classifyCandidate(candidate, wanted, classifyOptions)
  };
}

/** Never throws: a broken source is itself a useful diagnostic result. */
async function debugAttempt(label, url, wanted, rowMapper, note, classifyOptions) {
  const { status, ok, json, error } = await withLookupSlot(() => fetchJsonDetailed(url, label));
  if (error || (status && status >= 400)) {
    console.warn(`[debug] ${label}: ${error || 'HTTP ' + status}`);
  }
  const raw = rowMapper(json);
  const rows = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return {
    label,
    query: redactSecrets(url),
    status,
    ok,
    error,
    rawResults: rows.length,
    note: note || null,
    candidates: rows.slice(0, 10).map((row) => describeCandidate(row, wanted, classifyOptions))
  };
}

/** iTunes FR / US: the current query plus each proposed query, in order. */
async function debugItunes(track, country, wanted) {
  const clean = cleanTitle(track.track);
  const first = mainArtist(track.artist);
  const second = secondArtist(track.artist);
  const cleanAlbum = cleanTitle(track.album);
  const attempts = [];

  if (country === 'FR') {
    attempts.push(debugAttempt(
      'iTunes FR (current)',
      itunesDebugUrl(`${track.artist} ${track.track}`, 'song', 'FR', 10),
      wanted,
      (json) => itunesRows(json),
      'Current pipeline query — kept so the old behaviour is visible.'
    ));
  }

  attempts.push(debugAttempt(
    `iTunes ${country} song/mainArtist`,
    itunesDebugUrl(`${clean} ${first}`, 'song', country),
    wanted,
    (json) => itunesRows(json)
  ));
  if (second) {
    attempts.push(debugAttempt(
      `iTunes ${country} song/secondArtist`,
      itunesDebugUrl(`${clean} ${second}`, 'song', country),
      wanted,
      (json) => itunesRows(json)
    ));
  }
  if (cleanAlbum) {
    attempts.push(debugAttempt(
      `iTunes ${country} album/mainArtist`,
      itunesDebugUrl(`${cleanAlbum} ${first}`, 'album', country),
      wanted,
      (json) => itunesRows(json),
      'Album-level result: the track must be checked inside the album.'
    ));
  }

  return { attempts: await Promise.all(attempts) };
}

/** Deezer: the broken advanced query plus the proposed plain query. */
async function debugDeezer(track, wanted) {
  const first = mainArtist(track.artist);
  const clean = cleanTitle(track.track);
  const attempts = await Promise.all([
    debugAttempt(
      'Deezer (current advanced)',
      'https://api.deezer.com/search?q=' +
        encodeURIComponent(`artist:"${track.artist}" track:"${track.track}"`) + '&limit=10',
      wanted,
      (json) => deezerRows(json),
      'Current pipeline query.'
    ),
    debugAttempt(
      'Deezer plain',
      deezerDebugUrl(`${clean} ${first}`),
      wanted,
      (json) => deezerRows(json),
      'Proposed replacement query.'
    ),
    debugAttempt(
      'Deezer advanced (fallback)',
      deezerDebugUrl(`artist:"${first}" track:"${clean}"`),
      wanted,
      (json) => deezerRows(json),
      'Only used if the plain query returns nothing.'
    )
  ]);
  return { attempts };
}

/** Last.fm track.getInfo — the api_key is redacted in the reported URL. */
async function debugLastfmInfo(track, wanted) {
  const url = lastfmInfoDebugUrl(track);
  const attempt = await debugAttempt(
    'Last.fm track.getInfo',
    url,
    wanted,
    lastfmInfoRow,
    'Last resort: requires the scrobble album or an exact artist+title.',
    { strictAlbum: true }
  );
  return { attempts: [attempt] };
}

/** A → B → C → D → E. Stop at the first VERIFIED hit. */
async function resolveCover(track) {
  const key = coverCacheKey(track);
  const cached = coverStore.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { image: cached.image, source: cached.source, album: cached.album };
  }
  if (coverPending.has(key)) return coverPending.get(key);

  const promise = (async () => {
    let result = { image: null, source: 'none', album: null };

    // A: the image Last.fm already sent (pickLastfmImage rejects placeholders).
    if (validCoverUrl(track.image)) {
      result = { image: track.image, source: 'lastfm', album: track.album || null };
    } else {
      const sources = [
        ['itunes', fromItunes],
        ['deezer', fromDeezer],
        ['lastfm-trackinfo', fromLastfmInfo]
      ];
      for (const [source, lookup] of sources) {
        try {
          const best = await lookup(track);
          if (best) {
            result = { image: best.image, source, album: best.album || null };
            break;
          }
        } catch (err) {
          // A broken source never kills the response: try the next one.
          logSourceSkip(source, err);
        }
      }
    }

    coverStore.set(key, {
      image: result.image,
      source: result.source,
      album: result.album,
      expiresAt: Date.now() + (result.image ? COVER_CACHE_TTL : COVER_MISS_TTL)
    });
    console.log(`[cover] ${short(track.track)} — ${short(track.artist)} → ${result.source}`);
    return result;
  })().finally(() => coverPending.delete(key));

  coverPending.set(key, promise);
  return promise;
}

/** Attach image + coverSource + chosen album to every track. */
async function resolveCovers(tracks) {
  await mapLimit(tracks, COVER_CONCURRENCY, async (track) => {
    const { image, source, album } = await resolveCover(track);
    track.image = image;
    track.coverSource = source;
    track.coverAlbum = album;
  });
  return tracks;
}

/** The last 20 distinct sounds (kept as a separate, still-useful endpoint). */
async function refreshTracks() {
  const json = await fetchLastfmTracks('user.getRecentTracks', RECENT_FETCH_LIMIT);
  const raw = json && json.recenttracks && json.recenttracks.track;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const normalized = list.map(normalizeTrack).filter(Boolean);

  // Count repeats BEFORE de-duplication: this is the fallback shown when a
  // Last.fm total is still missing, and the secondary key for null-count ranks.
  const occurrences = new Map();
  normalized.forEach((track) => {
    const key = trackIdentityKey(track);
    occurrences.set(key, (occurrences.get(key) || 0) + 1);
  });
  normalized.forEach((track) => {
    track.fallbackCount = occurrences.get(trackIdentityKey(track)) || 1;
  });

  return resolveCovers(removeDuplicateTracks(normalized).slice(0, RECENT_LIMIT));
}

/**
 * The 20 most-played tracks of all time, sorted by playcount. The response
 * supplies a rank, but we recompute it after sorting so the wheel is always
 * ordered from "most listened" to "least listened" in this top 20.
 */
async function refreshTopTracks() {
  const json = await fetchLastfmTracks('user.getTopTracks', TOP_LIMIT);
  const raw = json && json.toptracks && json.toptracks.track;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const tracks = list
    .map((item) => {
      const track = normalizeTrack(item);
      if (!track) return null;
      const artist = text(item.artist && item.artist.name) || track.artist;
      return {
        ...track,
        artist,
        lastfmPlaycount: track.lastfmPlaycount || 0,
        rank: track.rank || 0,
        nowPlaying: false,
        playedAt: null
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.lastfmPlaycount - a.lastfmPlaycount)
    .slice(0, TOP_LIMIT);

  tracks.forEach((track, index) => { track.rank = index + 1; });
  return resolveCovers(tracks);
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

/**
 * Shared handler for both lists. Fresh data is served from memory, failures
 * fall back to the last good response, and simultaneous visitors share one
 * upstream call through store.pending.
 */
/** ?debug=1 adds the ORIGINAL Last.fm fields next to the chosen cover. */
function withDebugFields(tracks, req) {
  if (req.query.debug !== '1' || !debugCoversEnabled()) return tracks;
  return tracks.map((track) => ({
    ...track,
    lastfm: { track: track.track, artist: track.artist, album: track.album },
    chosenCover: { image: track.image, source: track.coverSource, album: track.coverAlbum || null }
  }));
}

async function serveTrackList(req, res, store, refresh, label, prepare = (tracks) => tracks) {
  res.set('Cache-Control', 'no-store');
  const username = process.env.LASTFM_USER;
  const staleMessage = (iso) =>
    `Last.fm is unreachable, showing the last known ${label} from ${when(iso)}.`;

  const fresh = store.cache && Date.now() - Date.parse(store.cache.fetchedAt) < CACHE_TTL;
  if (fresh) {
    return res.json({
      username,
      tracks: prepare(store.cache.tracks, req),
      fetchedAt: store.cache.fetchedAt,
      stale: false
    });
  }

  if (store.cache && Date.now() < store.retryAt) {
    return res.json({
      username,
      tracks: prepare(store.cache.tracks, req),
      fetchedAt: store.cache.fetchedAt,
      stale: true,
      message: staleMessage(store.cache.fetchedAt)
    });
  }

  try {
    if (!store.pending) {
      store.pending = refresh()
        .then((tracks) => {
          store.cache = { tracks, fetchedAt: new Date().toISOString() };
          store.retryAt = 0;
          store.lastFailure = null;
          return tracks;
        })
        .catch((err) => {
          store.lastFailure = err.message;
          store.retryAt = Date.now() + RETRY_DELAY;
          throw err;
        })
        .finally(() => { store.pending = null; });
    }

    await store.pending;
    return res.json({
      username,
      tracks: prepare(store.cache.tracks, req),
      fetchedAt: store.cache.fetchedAt,
      stale: false
    });
  } catch (err) {
    if (store.cache) {
      return res.json({
        username,
        tracks: prepare(store.cache.tracks, req),
        fetchedAt: store.cache.fetchedAt,
        stale: true,
        message: staleMessage(store.cache.fetchedAt)
      });
    }
    // Nothing cached: a clear error, still with no key and no request URL.
    return res.status(502).json({
      username,
      tracks: [],
      fetchedAt: null,
      stale: false,
      error: store.lastFailure || `Unable to load ${label} right now. Please try again shortly.`
    });
  }
}

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'what-your-music-looks-like',
    uptimeSeconds: Math.round(process.uptime()),
    cachedTracks: recentStore.cache ? recentStore.cache.tracks.length : 0,
    cachedTopTracks: topStore.cache ? topStore.cache.tracks.length : 0
  });
});

/** The main view: the 20 most-listened tracks, best one first. */
app.get('/api/top', (req, res) => {
  serveTrackList(req, res, topStore, refreshTopTracks, 'top tracks');
});

/**
 * The last 20 distinct sounds, ORDERED BY RANK (total play count, 1 = most
 * played) so the frontend only displays the list. ?debug=1 also adds the
 * original Last.fm track / artist / album, playCountSource and playedAt.
 * No secrets.
 */
app.get('/api/recent', (req, res) => {
  serveTrackList(req, res, recentStore, refreshTracks, 'listens', withPlayCountFields);
});

/**
 * Gated cover diagnostics. Disabled in production unless DEBUG_COVERS=1.
 * Shows every query (secrets redacted), HTTP status, raw counts and the
 * top 10 candidates with normalized values, score and rejection reason.
 */
app.get('/api/debug/cover', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!debugCoversEnabled()) return res.status(404).json({ error: 'Not found.' });

  const q = req.query;
  const artist = typeof q.artist === 'string' ? q.artist.trim() : '';
  const track = typeof q.track === 'string' ? q.track.trim() : '';
  const album = typeof q.album === 'string' ? q.album.trim() : '';
  if (!artist || !track) {
    return res.status(400).json({ error: 'artist and track query parameters are required.' });
  }

  const wanted = { artist, track, album };
  try {
    const sources = [
      ['itunes-FR', () => debugItunes(wanted, 'FR', wanted)],
      ['itunes-US', () => debugItunes(wanted, 'US', wanted)],
      ['deezer', () => debugDeezer(wanted, wanted)],
      ['lastfm-trackinfo', () => debugLastfmInfo(wanted, wanted)]
    ];
    const results = await mapLimit(sources, 4, async ([name, run]) => [name, await run()]);
    return res.json({
      track: {
        artist,
        track,
        album,
        artistSet: artistSet(artist),
        titleArtistSet: featArtistSet(track),
        cleanTrack: cleanTitle(track),
        mainArtist: mainArtist(artist),
        secondArtist: secondArtist(artist),
        cleanAlbum: cleanTitle(album)
      },
      sources: Object.fromEntries(results)
    });
  } catch (err) {
    // Native errors can contain URLs; only a generic message is returned.
    return res.status(500).json({ error: 'Cover diagnostics failed.' });
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
  'last.fm',
  'cdn-images.dzcdn.net',         // Deezer cover_xl / cover_big
  'e-cdns-images.dzcdn.net'       // Deezer's alternate image host
]);

function coverHostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return ALLOWED_COVER_HOSTS.has(host) ||
    host.endsWith('.last.fm') ||
    host.endsWith('.mzstatic.com') ||   // Apple / iTunes artwork
    host.endsWith('.dzcdn.net');        // Any Deezer image CDN host
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
