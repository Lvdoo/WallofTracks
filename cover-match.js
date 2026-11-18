'use strict';

/*
 * Cover matching — no network, no secrets, no server state.
 *
 * A candidate artwork is accepted ONLY when the artist sets intersect exactly,
 * the titles match, and the album is not a compilation. A wrong cover is worse
 * than no cover, so anything unverified is rejected and the frontend draws its
 * generated gradient instead.
 */

const GREY_COVER_HASH = '2a96cbd8b46e442fc41c2b86b821562f';
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

const BAD_ARTIST = /\b(?:cover|karaoke|tribute|instrumental|backing\s*track)\b/i;
const COMPILATION = /\b(?:compilation|greatest\s+hits|best\s+of|hits|karaoke|tribute|playlist|now\s+that['’`]?s|mix|backing\s+tracks?|instrumental|covers?)\b/i;
const SINGLE = /\b(?:single|ep)\b/i;
const ARTIST_SEPARATORS = /\s*(?:,|&|\bx\b|\bet\b|\bfeat(?:uring)?\.?\b|\bft\.?\b|\bwith\b)\s*/i;

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value['#text'] === 'string') return value['#text'].trim();
  return '';
}

/**
 * Lowercase, strip accents and special letters, drop bracketed extras,
 * collaboration credits and version suffixes, then keep only latin letters,
 * numbers and spaces. Examples:
 *   "Song - Single"        -> "song"
 *   "Café (Remastered 2011)" -> "cafe"
 *   "A$AP Rocky"           -> "asap rocky"
 *   "La Mano 1.9"          -> "la mano 19"
 *   "Θ. Macarena"          -> "macarena"
 *   "L2B & D2"             -> "l2b and d2"
 */
function normalize(value) {
  let s = text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // NFD does not decompose these two ligatures.
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/['’`]/g, ' ')
    .replace(/\$/g, 's')
    .replace(/&/g, ' and ')
    // "1.9" keeps both digits but loses the dot.
    .replace(/(\d)\.(\d)/g, '$1$2');

  // Drop Θ., Cyrillic, emoji and other non-Latin scripts before punctuation.
  s = s.replace(/[^\u0000-\u024F\s]/g, ' ');

  // "(Remastered 2011)", "[Deluxe Edition]", "(feat. X)" etc.
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');

  // A separator is required so a real title like "With You" stays intact.
  s = s.replace(/[\s\-–—:]+\b(?:feat(?:uring)?|ft|with)\b\.?.*$/i, ' ');
  s = s.replace(/[\s\-–—:]+\bremaster(?:ed)?\b.*$/i, ' ');
  s = s.replace(/[\s\-–—:]+\b(?:deluxe|limited|special|expanded|anniversary|collector)\b.*$/i, ' ');
  s = s.replace(/(?:\s*[-–—:]\s*|\s+)(?:single|ep)\s*$/i, ' ');

  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Exact normalized artist SET — no "contains" shortcut. */
function artistSet(value) {
  const raw = text(value);
  if (!raw) return [];
  const stripped = raw.replace(/\([^)]*\b(?:feat(?:uring)?|ft|with)\b[^)]*\)/gi, ' ');
  return [...new Set(stripped.split(ARTIST_SEPARATORS).map(normalize).filter(Boolean))];
}

/** Artist credits hidden inside a title such as "Song (feat. Other)". */
function featArtistSet(title) {
  const found = [];
  const value = text(title);
  // Titles use both "(feat. X)" and "[feat. X]".
  const patterns = [
    /\(([^)]*\b(?:feat|featuring|ft|with)\b[^)]*)\)/gi,
    /\[([^\]]*\b(?:feat|featuring|ft|with)\b[^\]]*)\]/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(value))) found.push(...artistSet(match[1]));
  }
  return [...new Set(found)];
}

/** The scrobble's artists = credited artists + any "(feat. X)" in the title. */
function wantedArtistSet(track) {
  return [...new Set([
    ...artistSet(track && track.artist),
    ...featArtistSet(track && track.track)
  ])];
}

function candidateArtistSet(candidate) {
  return [...new Set([
    ...artistSet(candidate && candidate.artist),
    ...featArtistSet(candidate && candidate.track)
  ])];
}

function fullArtistEqual(wanted, candidate) {
  const a = normalize(wanted);
  return Boolean(a && a === normalize(candidate));
}

function artistMatches(wanted, candidate) {
  const expected = wantedArtistSet(wanted);
  const actual = candidateArtistSet(candidate);
  if (!expected.length || !actual.length) return false;
  if (expected.some((name) => actual.includes(name))) return true;
  return fullArtistEqual(wanted.artist, candidate.artist);
}

function trackMatches(wanted, candidate) {
  const a = normalize(wanted);
  const b = normalize(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  return shorter.length >= 6 && (a.includes(b) || b.includes(a));
}

/** Only https, non-empty, and never Last.fm's grey placeholder. */
function validCoverUrl(url) {
  return typeof url === 'string' &&
    /^https:\/\//i.test(url) &&
    !url.includes(GREY_COVER_HASH);
}

function isBadAlbum(album) {
  return COMPILATION.test(text(album));
}

function isSingleAlbum(album) {
  return SINGLE.test(text(album));
}

function isVerified(candidate, wanted) {
  if (!candidate || !wanted) return false;
  if (!validCoverUrl(candidate.image)) return false;
  if (BAD_ARTIST.test(text(candidate.artist))) return false;
  // Compilation / karaoke / "hits" artwork is never the cover of the song.
  if (isBadAlbum(candidate.album)) return false;
  return artistMatches(wanted, candidate) && trackMatches(wanted.track, candidate.track);
}

/**
 * Last.fm track.getInfo is the LAST resort: autocorrect frequently returns a
 * different album, so require the scrobble album OR an exact artist+title.
 */
function lastfmInfoVerified(candidate, wanted) {
  if (!isVerified(candidate, wanted)) return false;
  const albumMatch = Boolean(normalize(wanted.album)) &&
    normalize(candidate.album) === normalize(wanted.album);
  const exact = fullArtistEqual(wanted.artist, candidate.artist) &&
    normalize(wanted.track) === normalize(candidate.track);
  return albumMatch || exact;
}

/**
 * Preference order: exact album, album contains/contained, not a compilation,
 * not a single when an album version exists, then earliest release date.
 */
function scoreCandidate(candidate, wanted) {
  const target = typeof wanted === 'string' ? { album: wanted } : (wanted || {});
  let score = 0;
  const wantedAlbum = normalize(target.album);
  const gotAlbum = normalize(candidate && candidate.album);
  if (wantedAlbum) {
    if (gotAlbum === wantedAlbum) score += 100;
    else if (gotAlbum && (gotAlbum.includes(wantedAlbum) || wantedAlbum.includes(gotAlbum))) score += 50;
  }
  if (!isBadAlbum(candidate.album)) score += 20;
  if (!isSingleAlbum(candidate.album)) score += 10;
  const released = Date.parse(text(candidate.releaseDate));
  if (Number.isFinite(released)) {
    // Last tie-break: the earliest release wins, but never more than 10 pts.
    score += Math.min(10, Math.max(0, (Date.now() - released) / YEAR_MS));
  }
  return score;
}

/** The four reasons reported by the diagnostic endpoint. */
function classifyCandidate(candidate, wanted, options) {
  const target = typeof wanted === 'string' ? { album: wanted } : (wanted || {});
  if (!candidate || !validCoverUrl(candidate.image)) return 'bad album type';
  if (BAD_ARTIST.test(text(candidate.artist))) return 'bad album type';
  if (isBadAlbum(candidate.album)) return 'bad album type';
  if (!artistMatches(target, candidate)) return 'artist mismatch';
  if (!trackMatches(target.track, candidate.track)) return 'title mismatch';
  if (options && options.strictAlbum && !lastfmInfoVerified(candidate, target)) return 'bad album type';
  return 'accepted';
}

/** Best VERIFIED candidate. Strict `>` keeps the first candidate on a tie. */
function pickBestCandidate(candidates, wanted) {
  let best = null;
  let bestScore = -Infinity;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!isVerified(candidate, wanted)) continue;
    const score = scoreCandidate(candidate, wanted);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function pickVerified(candidates, wanted) {
  const best = pickBestCandidate(candidates, wanted);
  return best ? best.image : null;
}

module.exports = {
  normalize,
  artistSet,
  featArtistSet,
  wantedArtistSet,
  candidateArtistSet,
  fullArtistEqual,
  artistMatches,
  trackMatches,
  validCoverUrl,
  isBadAlbum,
  isSingleAlbum,
  isVerified,
  lastfmInfoVerified,
  scoreCandidate,
  classifyCandidate,
  pickBestCandidate,
  pickVerified
};
