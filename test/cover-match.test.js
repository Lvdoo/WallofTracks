'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalize,
  artistSet,
  featArtistSet,
  wantedArtistSet,
  artistMatches,
  trackMatches,
  validCoverUrl,
  isVerified,
  lastfmInfoVerified,
  scoreCandidate,
  classifyCandidate,
  pickBestCandidate
} = require('../cover-match');

const IMG = 'https://cdn-images.dzcdn.net/images/cover/a.jpg';
const IMG2 = 'https://cdn-images.dzcdn.net/images/cover/b.jpg';

function candidate(overrides) {
  return { artist: 'Artist', track: 'Song', album: 'Real Album', image: IMG, releaseDate: '', ...overrides };
}

test('normalize handles accents, ligatures, apostrophes, $, numbers, Greek and &', () => {
  assert.equal(normalize('Café'), 'cafe');
  assert.equal(normalize('Ça va'), 'ca va');
  assert.equal(normalize('œuf'), 'oeuf');
  assert.equal(normalize('Æther'), 'aether');
  assert.equal(normalize("J'te haïs"), 'j te hais');
  assert.equal(normalize('J’te haïs'), 'j te hais');
  assert.equal(normalize('A$AP Rocky'), 'asap rocky');
  assert.equal(normalize('La Mano 1.9'), 'la mano 19');
  assert.equal(normalize('Θ. Macarena'), 'macarena');
  assert.equal(normalize('L2B & D2'), 'l2b and d2');
});

test('normalize strips brackets, feat., versions and "- single" but keeps "With You"', () => {
  assert.equal(normalize('Song - Single'), 'song');
  assert.equal(normalize('Album (Deluxe Edition)'), 'album');
  assert.equal(normalize('Café (Remastered 2011)'), 'cafe');
  assert.equal(normalize('Gasolina (feat. Ninho)'), 'gasolina');
  assert.equal(normalize('Song feat. Someone'), 'song');
  assert.equal(normalize('With You'), 'with you');
});

test('artists split into an exact set on all separators and the title feat.', () => {
  assert.deepEqual(artistSet('L2B & D2'), ['l2b', 'd2']);
  assert.deepEqual(artistSet('Djadja x Dinaz'), ['djadja', 'dinaz']);
  assert.deepEqual(artistSet('Djadja X Dinaz'), ['djadja', 'dinaz']);
  assert.deepEqual(artistSet('Ninho et Niska'), ['ninho', 'niska']);
  assert.deepEqual(artistSet('L2B, D2 feat. Rsko'), ['l2b', 'd2', 'rsko']);
  assert.deepEqual(featArtistSet("Amis d'enfance (feat. RSKO)"), ['rsko']);
  assert.deepEqual(featArtistSet('Praise the Lord (Da Shine) [feat. Skepta]'), ['skepta']);
  assert.deepEqual(wantedArtistSet({ artist: 'Mig', track: "Quand j'y repense (feat. Tiakola)" }), ['mig', 'tiakola']);
});

test('artist verification uses exact set intersection, never "contains"', () => {
  const wanted = { artist: 'L2B & D2', track: 'Sur Moi' };
  assert.equal(artistMatches(wanted, candidate({ artist: 'L2B' })), true);
  assert.equal(artistMatches(wanted, candidate({ artist: 'D2' })), true);
  assert.equal(artistMatches(wanted, candidate({ artist: 'L2B & SDM' })), true);
  assert.equal(artistMatches(wanted, candidate({ artist: 'L2BD2' })), false);
  assert.equal(artistMatches(wanted, candidate({ artist: 'La Fouine' })), false);
  assert.equal(artistMatches(
    { artist: 'Hornet La Frappe', track: 'Gasolina' },
    candidate({ artist: 'hornet la Frappe' })
  ), true);
});

test('title is exact, with a guarded contains rule (shorter title >= 6 chars)', () => {
  assert.equal(trackMatches('Sur Moi', 'Sur Moi'), true);
  assert.equal(trackMatches('Gasolina', 'Gasolina (feat. Ninho)'), true);
  assert.equal(trackMatches('Ronnie Kray', 'Ronnie Kray (Remastered 2011)'), true);
  assert.equal(trackMatches("Quand j'y repense", 'Quand j y repense'), true);
  assert.equal(trackMatches('Song', 'Completely Different Song'), false);
});

test('verification rejects placeholders, cover artists and compilations', () => {
  const wanted = { artist: 'Artist', track: 'Song', album: 'Real Album' };
  assert.equal(validCoverUrl('https://lastfm.freetls.fastly.net/i/2a96cbd8b46e442fc41c2b86b821562f.png'), false);
  assert.equal(isVerified(candidate(), wanted), true);
  assert.equal(isVerified(candidate({ image: 'http://cdn-images.dzcdn.net/a.jpg' }), wanted), false);
  assert.equal(isVerified(candidate({ artist: 'Artist Cover' }), wanted), false);
  assert.equal(isVerified(candidate({ album: 'HITS RAP HIVER 2023' }), wanted), false);
  assert.equal(isVerified(candidate({ album: 'Chart Backing Tracks 2018, Vol. 10' }), wanted), false);
  assert.equal(classifyCandidate(candidate({ album: 'HITS RAP HIVER 2023' }), wanted), 'bad album type');
  assert.equal(classifyCandidate(candidate({ artist: 'Someone Else' }), wanted), 'artist mismatch');
  assert.equal(classifyCandidate(candidate({ track: 'Different' }), wanted), 'title mismatch');
  assert.equal(classifyCandidate(candidate(), wanted), 'accepted');
});

test('track.getInfo requires the scrobble album or an exact artist+title', () => {
  const wanted = { artist: 'Mig', track: "Quand j'y repense (feat. Tiakola)", album: 'Toujours +' };
  assert.equal(lastfmInfoVerified(candidate({
    artist: 'Mig', track: "Quand j'y repense (feat. Tiakola)", album: 'HITS RAP HIVER 2023'
  }), wanted), false);
  assert.equal(lastfmInfoVerified(candidate({
    artist: 'Mig', track: "Quand j'y repense (feat. Tiakola)", album: 'Toujours +'
  }), wanted), true);
  assert.equal(lastfmInfoVerified(candidate({
    artist: 'Mig', track: 'Autre chanson', album: 'Toujours +'
  }), wanted), false);
});

test('scoring prefers exact album, then partial album, then non-single', () => {
  const wanted = { artist: 'Artist', track: 'Song', album: 'Real Album' };
  const exact = scoreCandidate(candidate({ album: 'Real Album' }), wanted);
  const partial = scoreCandidate(candidate({ album: 'The Real Album Story', image: IMG2 }), wanted);
  const unrelated = scoreCandidate(candidate({ album: 'Other Album', image: IMG2 }), wanted);
  const single = scoreCandidate(candidate({ album: 'Song - Single', image: IMG2 }), wanted);
  assert.ok(exact > partial, 'exact album should outrank a partial album');
  assert.ok(partial > unrelated, 'partial album should outrank an unrelated album');
  assert.ok(unrelated > single, 'single should be the last resort');
});

test('earliest release date breaks ties', () => {
  const wanted = { artist: 'Artist', track: 'Song', album: 'Real Album' };
  const old = scoreCandidate(candidate({ releaseDate: '2010-01-01', image: IMG2 }), wanted);
  const recent = scoreCandidate(candidate({ releaseDate: '2024-01-01', image: IMG2 }), wanted);
  assert.ok(old > recent, 'an older release should outrank a newer one');
});

test('pickBestCandidate chooses the best verified candidate and never guesses', () => {
  const wanted = { artist: 'Artist', track: 'Song', album: 'Real Album' };
  const wrong = candidate({ artist: 'Someone Else', album: 'Real Album', image: IMG2 });
  const first = candidate({ album: 'Other Album', image: IMG2 });
  const best = candidate({ album: 'Real Album' });
  assert.equal(pickBestCandidate([wrong], wanted), null);
  assert.equal(pickBestCandidate([first, best], wanted), best);
  assert.equal(pickBestCandidate([best, first], wanted), best);
});
