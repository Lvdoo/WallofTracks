'use strict';

/*
 * What your music looks like — frontend
 * -------------------------------------
 * Plain JavaScript. The browser talks ONLY to our own server:
 *   /api/recent  -> the last 20 distinct sounds, with server-cached play counts
 *   /api/cover   -> same-origin image proxy, so canvas can read cover pixels
 *
 * The visual idea: a giant iOS "Now Playing" card is a physical object inside
 * the photo. It rises out of the flat phone, casts a shadow, and (on scroll /
 * swipe / drag / arrow keys) becomes a 3D wheel of your recent listens.
 * Your most-played track is the biggest and brightest; quieter ones stay
 * smaller but always readable. Clicking any visible card selects it.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const els = {
    scene: $('scene'), stage: $('stage'), deck: $('deck'),
    username: $('username'), refreshTime: $('refreshTime'), counter: $('counter'),
    status: $('status'), statusText: $('statusText'),
    hint: $('hint'), backButton: $('backButton'),
    banner: $('banner'), bannerText: $('bannerText'), retryButton: $('retryButton'),
    stateCard: $('stateCard'), stateIcon: $('stateIcon'), stateTitle: $('stateTitle'),
    stateBody: $('stateBody'), stateRetry: $('stateRetry'),
    debugPanel: $('debugPanel'), debugOverlay: $('debugOverlay'), debugValues: $('debugValues'),
    scaleSlider: $('scaleSlider'), scaleOut: $('scaleOut'),
    radiusSlider: $('radiusSlider'), radiusOut: $('radiusOut')
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    tracks: [],
    mode: 'phone',        // 'phone' = one card, 'wheel' = carousel
    rotation: 0,          // degrees
    velocity: 0,          // degrees per frame (inertia)
    target: null,         // snap target in degrees
    snapAt: 0,
    dragging: false,
    moved: false,
    step: 0,              // degrees between cards
    radius: 0,
    frontIndex: 0,
    raf: null,
    paused: false,        // freezes the visual progress only
    nowPlayingStart: Date.now(),
    cardScale: 1,
    radiusScale: 1,
    anchor: { x: 51, y: 52 },

    // Stable selection: artist + track + playedAt, never an array index.
    selectedId: null,
    explicitSelection: false,
    press: null,          // pointer-down candidate for a click
    suppressClickUntil: 0 // blocks taps right after a drag / momentum scroll
  };

  // Static SVGs. No brand marks: just generic player glyphs.
  const ICONS = {
    rewind: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 12 20 6v12zM3 12l8-6v12z"/></svg>',
    forward: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 12 4 6v12zM21 12l-9-6v12z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1.4"/><rect x="14" y="4.5" width="4" height="15" rx="1.4"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15L19 12z"/></svg>',
    airplay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-1"/><path d="m12 14 5 6H7z"/></svg>',
    speakerLow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h4l5-4v14l-5-4H3z"/></svg>',
    speakerHigh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h4l5-4v14l-5-4H3z"/><path d="M16 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    equalizer: '<svg class="eq" viewBox="0 0 18 16" aria-hidden="true"><rect x="2" y="6" width="2" height="4" rx="1"/><rect x="6.5" y="3" width="2" height="10" rx="1"/><rect x="11" y="5" width="2" height="6" rx="1"/><rect x="15.5" y="7" width="2" height="2" rx="1"/></svg>'
  };

  /* ---------------------------------------------------------------- *
   * Small utilities
   * ---------------------------------------------------------------- */
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function hashString(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
    return Math.abs(hash);
  }

  function trackKey(track) {
    return `${track.track}|${track.artist}|${track.album}`.toLowerCase();
  }

  /** Accent-insensitive, lowercase label used for stable keys. */
  function normalizeLabel(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** Stable across a 60 s refresh and inserted scrobbles. */
  function selectionId(track) {
    const when = track.playedAt || (track.nowPlaying ? 'now' : 'unknown');
    return `${normalizeLabel(track.artist)}|${normalizeLabel(track.track)}|${when}`;
  }

  /** Same track across repeated listens: used for the recent-list fallback. */
  function playKey(track) {
    return `${normalizeLabel(track.artist)}|${normalizeLabel(track.track)}`;
  }

  /**
   * Log-scale weight over the tracks currently loaded. Last.fm's value wins;
   * while it is still null we fall back to the number of times the same
   * normalized track appears in this recent list (never less than 1).
   */
  function computePlayStats(tracks) {
    const occurrences = new Map();
    tracks.forEach((track) => {
      const key = playKey(track);
      occurrences.set(key, (occurrences.get(key) || 0) + 1);
    });

    const raw = tracks.map((track) => {
      const fromLastfm = Number(track.playCount);
      const fallback = Math.max(1, occurrences.get(playKey(track)) || 1);
      const count = Number.isFinite(fromLastfm) && fromLastfm > 0
        ? Math.floor(fromLastfm) : fallback;
      return { id: selectionId(track), count };
    });

    const counts = raw.map((item) => item.count);
    const min = counts.length ? Math.min(...counts) : 1;
    const max = counts.length ? Math.max(...counts) : 1;
    const span = Math.log1p(max) - Math.log1p(min);

    return new Map(raw.map((item) => {
      const w = span > 0 ? (Math.log1p(item.count) - Math.log1p(min)) / span : 0.5;
      const weight = clamp(w, 0, 1);
      return [item.id, {
        count: item.count,
        weight,
        scale: 0.82 + 0.30 * weight,          // lerp(0.82, 1.12, w)
        glow: 0.25 + 0.75 * weight,           // lerp(0.25, 1, w)
        lift: weight
      }];
    }));
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
  }

  function relativeTime(iso) {
    if (!iso) return 'time unknown';
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
    if (minutes < 1) return 'played just now';
    if (minutes < 60) return `played ${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `played ${hours} h ago`;
    return `played ${Math.floor(hours / 24)} d ago`;
  }

  function durationFor(track) {
    return track.durationSec > 0 ? track.durationSec : 120 + (hashString(track.track) % 190);
  }

  function hslToRgb(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }

  function setStatus(text, kind) {
    els.statusText.textContent = text;
    els.status.classList.toggle('is-stale', kind === 'stale');
    els.status.classList.toggle('is-error', kind === 'error');
  }

  function showState(icon, title, body, retry) {
    state.tracks = [];
    state.selectedId = null;
    state.explicitSelection = false;
    state.press = null;
    state.mode = 'phone';
    document.body.classList.remove('is-wheel');
    stopLoop();
    els.stateIcon.textContent = icon;
    els.stateTitle.textContent = title;
    els.stateBody.textContent = body;
    els.stateRetry.hidden = !retry;
    els.stateCard.hidden = false;
    els.deck.replaceChildren();
    els.hint.classList.add('is-hidden');
    els.backButton.hidden = true;
    els.counter.textContent = '0 / 0';
  }

  function hideState() { els.stateCard.hidden = true; }

  /* ---------------------------------------------------------------- *
   * Photo + tuning panel (?debug=1)
   * ---------------------------------------------------------------- */
  function loadScenePhoto() {
    // The stage has the photo's exact ratio, so no cover-crop fallback needed.
    root.style.setProperty('--scene-photo', "url('/assets/me.jpg')");
  }

  function printDebug() {
    const text =
      `--phone-x: ${state.anchor.x.toFixed(1)};\n` +
      `--phone-y: ${state.anchor.y.toFixed(1)};\n` +
      `--card-scale: ${state.cardScale.toFixed(2)};\n` +
      `--radius-scale: ${state.radiusScale.toFixed(2)};`;
    els.debugValues.textContent = text;
    console.log('[debug]', text.replace(/\n/g, ' '));
  }

  function applySettings() {
    root.style.setProperty('--card-scale', state.cardScale.toFixed(2));
    root.style.setProperty('--radius-scale', state.radiusScale.toFixed(2));
    els.scaleOut.textContent = state.cardScale.toFixed(2);
    els.radiusOut.textContent = `${state.radiusScale.toFixed(2)}×`;
    if (state.tracks.length) {
      computeRadius();
      if (state.mode === 'wheel') applyWheel();
    }
    if (!els.debugPanel.hidden) printDebug();
  }

  function initDebug() {
    const on = new URLSearchParams(location.search).get('debug') === '1';

    try {
      const saved = JSON.parse(localStorage.getItem('wot-settings') || 'null');
      // v1 stored viewport-relative values for the old photo. Ignore them so
      // the new stage defaults are not silently overridden by stale storage.
      // v2's radius scale was tuned against the old capped wheel formula, which
      // made cards overlap; keep its anchor/card scale but start the wheel from
      // the new default so the fix is visible without clearing storage.
      if (saved && (saved.v === 2 || saved.v === 3)) {
        if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) state.anchor = { x: saved.x, y: saved.y };
        if (Number.isFinite(saved.cardScale)) state.cardScale = clamp(saved.cardScale, 0.5, 1.6);
        if (saved.v === 3 && Number.isFinite(saved.radiusScale)) {
          state.radiusScale = clamp(saved.radiusScale, 0.5, 2);
        }
      }
    } catch (_) { /* ignore broken storage */ }

    root.style.setProperty('--phone-x', state.anchor.x.toFixed(1));
    root.style.setProperty('--phone-y', state.anchor.y.toFixed(1));
    els.scaleSlider.value = String(state.cardScale);
    els.radiusSlider.value = String(state.radiusScale);
    applySettings();

    if (!on) return;
    els.debugPanel.hidden = false;
    els.debugOverlay.hidden = false;
    printDebug();

    function setAnchor(event) {
      const rect = els.stage.getBoundingClientRect();
      state.anchor = {
        x: clamp((event.clientX - rect.left) / rect.width * 100, 0, 100),
        y: clamp((event.clientY - rect.top) / rect.height * 100, 0, 100)
      };
      root.style.setProperty('--phone-x', state.anchor.x.toFixed(1));
      root.style.setProperty('--phone-y', state.anchor.y.toFixed(1));
      saveSettings();
      printDebug();
    }
    let dragging = false;
    els.debugOverlay.addEventListener('pointerdown', (event) => { dragging = true; setAnchor(event); });
    els.debugOverlay.addEventListener('pointermove', (event) => { if (dragging) setAnchor(event); });
    window.addEventListener('pointerup', () => { dragging = false; });

    els.scaleSlider.addEventListener('input', () => {
      state.cardScale = Number(els.scaleSlider.value);
      saveSettings(); applySettings();
    });
    els.radiusSlider.addEventListener('input', () => {
      state.radiusScale = Number(els.radiusSlider.value);
      saveSettings(); applySettings();
    });
  }

  function saveSettings() {
    localStorage.setItem('wot-settings', JSON.stringify({
      v: 3,
      x: state.anchor.x, y: state.anchor.y,
      cardScale: state.cardScale, radiusScale: state.radiusScale
    }));
  }

  /* ---------------------------------------------------------------- *
   * Dominant colour: the canvas trick that makes a card look "printed"
   * ---------------------------------------------------------------- */
  function extractTint(image) {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, 24, 24);
    const pixels = ctx.getImageData(0, 0, 24, 24).data;

    let best = null, bestScore = 0, sumR = 0, sumG = 0, sumB = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const value = max / 255;
      const saturation = max === 0 ? 0 : (max - min) / max;
      if (value < 0.1 || value > 0.98) continue; // ignore black / blown-out pixels
      const score = saturation * value;
      if (score > bestScore) { bestScore = score; best = [r, g, b]; }
      if (saturation > 0.12) { sumR += r; sumG += g; sumB += b; count++; }
    }
    const rgb = best || (count ? [sumR / count, sumG / count, sumB / count] : [120, 150, 210]);
    return darkenForWhiteText(rgb);
  }

  /** Darken a cover colour enough that white UI text stays readable. */
  function darkenForWhiteText(rgb) {
    const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    const factor = luminance > 0.34 ? 0.34 / luminance : 1;
    const top = rgb.map((c) => Math.round(clamp(c * factor, 0, 255)));
    const bottom = top.map((c) => Math.round(c * 0.42));
    return { top: `rgb(${top.join(', ')})`, bottom: `rgb(${bottom.join(', ')})`, rgb: top.join(', ') };
  }

  function tintFromTitle(title) {
    const hue = hashString(title) % 360;
    const rgb = hslToRgb(hue, 0.55, 0.42);
    return {
      top: `hsl(${hue} 42% 20%)`,
      bottom: `hsl(${(hue + 18) % 360} 46% 8%)`,
      rgb: rgb.join(', ')
    };
  }

  function applyTint(card, tint) {
    card.style.setProperty('--tint-top', tint.top);
    card.style.setProperty('--tint-bottom', tint.bottom);
    if (!card._parts) return;
    card._parts.tintRgb = tint.rgb;
    if (card === frontCard()) updateSceneTint();
  }

  function updateSceneTint() {
    const card = frontCard();
    const rgb = card && card._parts && card._parts.tintRgb;
    if (!rgb) return;
    root.style.setProperty('--tint-rgb', rgb);

    // The spill on the photo's beam is 70% cool photo white + 30% cover tint.
    const cover = rgb.split(',').map((value) => Number(value.trim()));
    if (cover.length === 3 && cover.every((value) => Number.isFinite(value))) {
      const coolWhite = [205, 230, 255];
      const spill = coolWhite.map((value, i) => Math.round(value * 0.7 + cover[i] * 0.3));
      root.style.setProperty('--spill-rgb', spill.join(', '));
    }
  }

  function findSelectedIndex() {
    if (!state.selectedId) return 0;
    const index = state.tracks.findIndex((track) => selectionId(track) === state.selectedId);
    return index < 0 ? 0 : index;
  }

  function setSelected(index, explicit = true) {
    if (!state.tracks.length) return;
    const safe = ((index % state.tracks.length) + state.tracks.length) % state.tracks.length;
    const track = state.tracks[safe];
    state.selectedId = selectionId(track);
    if (explicit) state.explicitSelection = true;
    Array.from(els.deck.children).forEach((card, i) => {
      card.classList.toggle('is-selected', card.dataset.id === state.selectedId);
    });
  }

  function applyPlayVars(card, stats) {
    if (!card || !stats) return;
    card.style.setProperty('--play-scale', stats.scale.toFixed(3));
    card.style.setProperty('--play-glow', stats.glow.toFixed(3));
    card.style.setProperty('--play-lift', stats.lift.toFixed(3));
    card.style.setProperty('--glow', stats.glow.toFixed(3));
    if (card._parts) {
      card._parts.glowBase = stats.glow;
      card._parts.playCount = stats.count;
      if (card._parts.playLabel) {
        card._parts.playLabel.textContent =
          `played ${stats.count} ${stats.count === 1 ? 'time' : 'times'}`;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Card construction
   * ---------------------------------------------------------------- */
  function makeGradientCover(title) {
    const hash = hashString(title);
    const hue = hash % 360;
    const cover = el('div', 'cover__gradient', (title.trim()[0] || '♪').toUpperCase());
    cover.style.background = `linear-gradient(145deg, hsl(${hue} 72% 52%), hsl(${(hue + 60) % 360} 62% 22%))`;
    cover.setAttribute('aria-hidden', 'true');
    return cover;
  }

  function makeControl(kind) {
    const button = el('button', `control control--${kind}`);
    button.type = 'button';
    button.setAttribute('aria-label', {
      rewind: 'Previous album', play: 'Freeze or resume the progress', forward: 'Next album'
    }[kind]);
    button.innerHTML = kind === 'play' ? ICONS.pause : ICONS[kind]; // pause is the default, like the edits
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (kind === 'rewind') stepTo(state.frontIndex - 1);
      else if (kind === 'forward') stepTo(state.frontIndex + 1);
      else togglePlayAnimation();
    });
    return button;
  }

  function buildCard(track, index, list, stats) {
    const rank = track.rank || index + 1;

    const card = el('div', 'card');
    card.dataset.id = selectionId(track);
    if (rank <= 3) card.classList.add('card--podium');
    card.style.setProperty('--i', index);
    card.style.setProperty('--rank', String(rank));
    card.style.setProperty('--tilt-z', `${hashString(track.track) % 7 - 3}deg`);
    card.style.setProperty('--tilt-x', `${hashString(track.artist) % 9 - 4}deg`);
    card.style.setProperty('--focus', '1');
    applyPlayVars(card, stats || { scale: 0.97, glow: 0.62, lift: 0.5, count: 1 });

    const scaler = el('div', 'card__scaler');
    const surface = el('div', 'card__surface');
    surface.append(el('div', 'card__glass'), el('div', 'card__tint'), el('div', 'card__gloss'));
    const selectedBadge = el('span', 'card__selected', 'Selected');
    selectedBadge.setAttribute('aria-hidden', 'true');
    surface.appendChild(selectedBadge);

    const content = el('div', 'card__content');

    // --- artwork (through our proxy so the canvas stays readable) ---
    const cover = el('div', 'cover');
    const label = track.album || track.track;
    if (track.image) {
      const image = document.createElement('img');
      image.alt = `Artwork for ${label}`;
      image.decoding = 'async';
      image.loading = index > 6 ? 'lazy' : 'eager';
      image.onload = () => {
        try { applyTint(card, extractTint(image)); }
        catch (_) { applyTint(card, tintFromTitle(label)); } // e.g. tainted canvas
      };
      image.onerror = () => {
        cover.replaceChildren(
          makeGradientCover(track.track),
          el('div', 'cover__shade'),
          el('span', 'cover__rank', `#${rank}`)
        );
        applyTint(card, tintFromTitle(label));
      };
      image.src = `/api/cover?u=${encodeURIComponent(track.image)}`;
      cover.appendChild(image);
    } else {
      cover.appendChild(makeGradientCover(track.track));
      applyTint(card, tintFromTitle(label));
    }
    cover.appendChild(el('div', 'cover__shade'));
    cover.appendChild(el('span', 'cover__rank', `#${rank}`));
    content.appendChild(cover);

    // --- title / artist / small icons ---
    const meta = el('div', 'card__meta');
    const labels = el('div', 'card__labels');
    const title = el('h2', 'card__title', track.track);
    title.title = track.track;
    const artist = el('p', 'card__artist', track.artist || 'Unknown artist');
    labels.append(title, artist);
    const icons = el('div', 'card__icons');
    const eq = el('span', track.nowPlaying ? 'eq is-live' : 'eq');
    eq.innerHTML = ICONS.equalizer;
    const airplay = el('span');
    airplay.innerHTML = ICONS.airplay;
    icons.append(eq, airplay);
    meta.append(labels, icons);
    content.appendChild(meta);

    // --- relative time + the play count label (hidden only if unknown) ---
    const time = el('div', track.nowPlaying ? 'card__time card__time--live' : 'card__time');
    if (track.nowPlaying) {
      const dot = el('i', 'live-dot');
      dot.setAttribute('aria-hidden', 'true');
      time.append(dot, document.createTextNode('Now playing'));
    } else {
      time.textContent = relativeTime(track.playedAt);
    }
    const playCount = stats && stats.count;
    let playLabel = null;
    if (Number.isFinite(playCount) && playCount > 0) {
      time.appendChild(document.createTextNode(' · '));
      playLabel = el('span', 'card__plays',
        `played ${playCount} ${playCount === 1 ? 'time' : 'times'}`);
      time.appendChild(playLabel);
    }
    content.appendChild(time);

    // --- progress with knob, elapsed and remaining time ---
    const progress = el('div', 'progress');
    const bar = el('div', 'progress__track');
    const fill = el('div', 'progress__fill');
    const knob = el('div', 'progress__knob');
    bar.append(fill, knob);
    const times = el('div', 'progress__times');
    const elapsed = el('span', '', '0:00');
    const remaining = el('span', '', '-0:00');
    times.append(elapsed, remaining);
    progress.append(bar, times);
    content.appendChild(progress);

    // --- chunky transport controls ---
    const controls = el('div', 'controls');
    controls.append(makeControl('rewind'), makeControl('play'), makeControl('forward'));
    content.appendChild(controls);

    // --- volume slider with speaker icons ---
    const volume = el('div', 'volume');
    const left = el('span');
    left.innerHTML = ICONS.speakerLow;
    const right = el('span');
    right.innerHTML = ICONS.speakerHigh;
    const trackBar = el('div', 'volume__track');
    trackBar.append(el('div', 'volume__fill'), el('div', 'volume__knob'));
    volume.append(left, trackBar, right);
    content.appendChild(volume);

    surface.appendChild(content);
    scaler.appendChild(surface);
    card.appendChild(scaler);

    card._parts = {
      fill, knob, elapsed, remaining, time, playLabel, tintRgb: null,
      duration: durationFor(track), playedAt: track.playedAt,
      nowPlaying: track.nowPlaying, demoProgress: track.playcount != null,
      glowBase: stats ? stats.glow : 0.62,
      playCount: playCount || 1
    };
    return card;
  }

  function renderLoading() {
    const card = el('div', 'card is-skeleton is-selected');
    const scaler = el('div', 'card__scaler');
    const surface = el('div', 'card__surface');
    surface.append(el('div', 'card__glass'), el('div', 'card__tint'));
    const content = el('div', 'card__content');
    ['skeleton--cover', 'skeleton--title', 'skeleton--artist', 'skeleton--bar'].forEach((name) => {
      content.appendChild(el('div', `skeleton ${name}`));
    });
    surface.appendChild(content);
    scaler.appendChild(surface);
    card.appendChild(scaler);
    els.deck.replaceChildren(card);
  }

  function clearCardStyles() {
    Array.from(els.deck.children).forEach((card) => {
      card.style.transform = '';
      card.style.opacity = '';
      card.style.visibility = '';
      card.style.filter = '';
      card.style.zIndex = '';
      card.style.setProperty('--focus', '1');
      if (card._parts && card._parts.glowBase) {
        card.style.setProperty('--glow', card._parts.glowBase.toFixed(3));
      }
      card.classList.remove('is-entering');
    });
  }

  function renderTracks(tracks, previousFirst) {
    const wasWheel = state.mode === 'wheel';
    const stats = computePlayStats(tracks);
    const ids = tracks.map(selectionId);

    // Keep only an EXPLICIT choice. Until the user picks a card, every refresh
    // follows the now-playing / newest listen.
    let index = state.explicitSelection && state.selectedId
      ? ids.indexOf(state.selectedId) : -1;
    if (index < 0) {
      if (state.explicitSelection && state.selectedId) state.explicitSelection = false;
      index = 0;
    }

    const oldCards = Array.from(els.deck.children);
    const sameCards = oldCards.length === tracks.length &&
      oldCards.every((card, i) => card.dataset.id === ids[i]);
    if (sameCards) {
      // Values arrived in the background: update in place so CSS can animate
      // the size/glow change instead of rebuilding every card.
      tracks.forEach((track, i) => applyPlayVars(oldCards[i], stats.get(ids[i])));
    } else {
      els.deck.replaceChildren(...tracks.map((track, i) =>
        buildCard(track, i, tracks, stats.get(ids[i]))));
    }

    state.tracks = tracks;
    state.selectedId = ids[index];
    state.frontIndex = index;
    Array.from(els.deck.children).forEach((card, i) => {
      card.classList.toggle('is-selected', i === index);
      card.classList.remove('is-front');
    });

    state.step = tracks.length > 1 ? 360 / tracks.length : 0;
    computeRadius();
    state.rotation = index * state.step;
    state.velocity = 0;
    state.target = null;
    state.snapAt = 0;

    // A newly scrobbled track slides in at the front.
    if (previousFirst && trackKey(tracks[0]) !== previousFirst && !wasWheel && !sameCards) {
      els.deck.firstElementChild.classList.add('is-new');
    }

    if (wasWheel) applyWheel();
    else {
      clearCardStyles();
      els.counter.textContent = `${index + 1} / ${tracks.length}`;
      updateSceneTint();
    }
  }

  /* ---------------------------------------------------------------- *
   * The virtualised 3D wheel
   * ---------------------------------------------------------------- */
  function computeRadius() {
    const stage = els.stage.getBoundingClientRect();
    const stageH = stage.height || 600;
    const stageW = stage.width || stageH * 0.562829665;
    // --card-h / --card-w already include --card-scale; do not apply it twice.
    const width = els.deck.offsetWidth || stageH * 0.23;
    const count = state.tracks.length;
    // Keep about one card-width of clearance between neighbours. The ring
    // widens as the list grows, so 20 posters fan out instead of piling up
    // on top of each other; the ones further back simply leave the stage.
    const spacing = width * 1.06;
    const ideal = count > 1
      ? spacing / (2 * Math.sin(Math.PI / count))
      : width * 0.5;
    // Safety cap only: it must never be what makes cards overlap.
    const maxRadius = stageW * 2;
    state.radius = Math.max(0, Math.min(ideal, maxRadius) * state.radiusScale);
    root.style.setProperty('--radius', `${Math.round(state.radius)}px`);
  }

  function applyWheel() {
    const cards = els.deck.children;
    const count = cards.length;
    if (!count) return;

    if (count === 1) {
      const only = cards[0];
      only.style.transform = `translateZ(${state.radius}px)`;
      only.style.visibility = 'visible';
      only.style.opacity = '1';
      only.style.filter = 'none';
      only.style.setProperty('--focus', '1');
      only.classList.add('is-front');
      state.frontIndex = 0;
      els.counter.textContent = '1 / 1';
      updateSceneTint();
      return;
    }

    // Only ~11 cards near the front are painted; the rest are virtualised.
    const frontRaw = state.rotation / state.step;
    const nearest = Math.round(frontRaw);
    const offset = frontRaw - nearest;
    const half = Math.min(5, Math.floor((count - 1) / 2));
    state.frontIndex = ((nearest % count) + count) % count;

    for (let i = 0; i < count; i++) {
      const card = cards[i];
      let delta = ((i - nearest) % count + count) % count;
      if (delta > count / 2) delta -= count;
      const distance = Math.abs(delta - offset);

      if (Math.abs(delta) > half + 1) {
        card.style.visibility = 'hidden';
        card.style.opacity = '0';
        card.classList.remove('is-front');
        continue;
      }
      const angle = (delta - offset) * state.step;
      const ratio = Math.min(1, distance / (half + 0.5));
      const focus = 1 - ratio;
      const isFront = distance < 0.08;
      const isSelected = card.dataset.id === state.selectedId;
      const crisp = isFront || isSelected;
      const glowBase = card._parts && card._parts.glowBase
        ? card._parts.glowBase : 0.62;

      card.style.visibility = 'visible';
      card.style.transform = `rotateY(${angle.toFixed(2)}deg) translateZ(${state.radius}px)`;
      card.style.opacity = crisp ? '1' : Math.max(0.72, 1 - ratio * 0.28).toFixed(3);
      // Keep the existing wheel blur, but never darken past the readability floor.
      card.style.filter = crisp ? 'none'
        : `blur(${(ratio * 2.4).toFixed(2)}px) brightness(${Math.max(0.8, 1 - ratio * 0.2).toFixed(2)})`;
      card.style.setProperty('--focus', focus.toFixed(2));
      // Multiplicative with the wheel focus, clamped to the same 0.25 floor.
      card.style.setProperty('--glow',
        Math.max(0.25, glowBase * (0.62 + 0.38 * focus)).toFixed(3));
      card.style.zIndex = String(100 - Math.round(distance * 2));
      card.classList.toggle('is-front', isFront);
    }
    els.counter.textContent = `${state.frontIndex + 1} / ${count}`;
    updateSceneTint();
  }

  function snapToNearest() {
    if (!state.step) { state.target = 0; return; }
    const turns = Math.round(state.rotation / state.step);
    state.target = turns * state.step;
    state.velocity = 0;
    if (state.mode === 'wheel' && state.tracks.length) {
      setSelected(((turns % state.tracks.length) + state.tracks.length) % state.tracks.length);
    }
  }

  function stepTo(index) {
    if (state.mode !== 'wheel') openWheel();
    if (!state.step) { state.target = 0; return; }
    const count = state.tracks.length;
    const safe = ((index % count) + count) % count;
    setSelected(safe);
    let target = safe * state.step;
    target += Math.round((state.rotation - target) / 360) * 360;
    state.target = target;
    state.velocity = 0;
    state.snapAt = 0;
  }

  function frame(now) {
    if (state.mode !== 'wheel') { state.raf = null; return; }
    if (!state.dragging) {
      if (state.target !== null) {
        const difference = state.target - state.rotation;
        if (Math.abs(difference) < 0.08) {
          state.rotation = state.target;
          state.target = null;
          state.velocity = 0;
        } else {
          state.rotation += difference * (reduceMotion ? 1 : 0.16); // spring
        }
      } else if (Math.abs(state.velocity) > 0.02) {
        state.rotation += state.velocity;
        state.velocity *= reduceMotion ? 0 : 0.94; // inertia
        state.snapAt = now + 160;
      } else if (state.snapAt && now >= state.snapAt) {
        snapToNearest();
        state.snapAt = 0;
      }
    }
    applyWheel();
    state.raf = requestAnimationFrame(frame);
  }

  function startLoop() { if (!state.raf) state.raf = requestAnimationFrame(frame); }
  function stopLoop() { if (state.raf) cancelAnimationFrame(state.raf); state.raf = null; }

  function openWheel() {
    if (state.mode === 'wheel' || !state.tracks.length) return;
    state.mode = 'wheel';
    document.body.classList.remove('is-loading');
    document.body.classList.add('is-wheel');
    els.backButton.hidden = false;
    els.hint.classList.add('is-hidden');
    computeRadius();
    // Reopen at whatever the user selected, not necessarily the newest listen.
    const selected = findSelectedIndex();
    state.selectedId = selectionId(state.tracks[selected]);
    Array.from(els.deck.children).forEach((card, i) => {
      card.classList.toggle('is-selected', i === selected);
      if (i > 0) card.classList.add('is-entering');
    });
    state.rotation = selected * state.step;
    state.target = null;
    state.velocity = 0;
    state.snapAt = 0;
    window.setTimeout(() => {
      Array.from(els.deck.children).forEach((card) => card.classList.remove('is-entering'));
    }, 900);
    startLoop();
  }

  function closeWheel() {
    if (state.mode !== 'wheel') return;
    // The visible front card is the choice we collapse to.
    if (state.tracks.length) setSelected(state.frontIndex);
    state.mode = 'phone';
    document.body.classList.remove('is-wheel');
    els.backButton.hidden = true;
    stopLoop();
    state.rotation = 0;
    state.velocity = 0;
    state.target = null;
    state.snapAt = 0;
    clearCardStyles();
    Array.from(els.deck.children).forEach((card) => card.classList.remove('is-front'));
    if (state.tracks.length) {
      els.counter.textContent = `${findSelectedIndex() + 1} / ${state.tracks.length}`;
    }
    updateSceneTint();
  }

  function frontCard() {
    const cards = Array.from(els.deck.children);
    if (!cards.length) return null;
    if (state.mode === 'wheel') return cards[state.frontIndex] || null;
    return cards.find((card) => card.dataset.id === state.selectedId) || cards[0] || null;
  }

  function togglePlayAnimation() {
    state.paused = !state.paused;
    const card = frontCard();
    const button = card && card.querySelector('.control--play');
    if (button) button.innerHTML = state.paused ? ICONS.play : ICONS.pause;
  }

  /** A real tap on any visible card: rotate to it, or collapse if it is front. */
  function selectCard(card) {
    if (!card || card.style.visibility === 'hidden') return;
    if (state.mode !== 'wheel') { openWheel(); return; }
    const index = Array.prototype.indexOf.call(els.deck.children, card);
    if (index < 0) return;
    if (index === state.frontIndex) closeWheel();
    else stepTo(index);
  }

  /* ---------------------------------------------------------------- *
   * Input: wheel, touch swipe, mouse drag, keyboard
   * ---------------------------------------------------------------- */
  function moveGloss(clientX) {
    const rect = els.stage.getBoundingClientRect();
    const shift = ((clientX - rect.left) / (rect.width || 1) - 0.5) * 46;
    root.style.setProperty('--gloss-shift', `${shift.toFixed(1)}px`);
  }

  /** Debug panel and small UI sit above the stage; they are not drag surfaces. */
  function isSceneUI(target) {
    return !!(target && target.closest &&
      target.closest('.topbar, .hint, .back, .banner, .debug, .debug-overlay, .state-card'));
  }

  function bindInput() {
    let wheelCooldown = 0;
    els.stage.addEventListener('wheel', (event) => {
      if (!state.tracks.length || isSceneUI(event.target)) return;
      event.preventDefault();
      openWheel();
      state.target = null;
      // Throttle trackpads a little so a single flick is not 40 events.
      const now = performance.now();
      if (now - wheelCooldown < 16) return;
      wheelCooldown = now;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      state.velocity = clamp(state.velocity + delta * 0.05, -24, 24);
      state.snapAt = now + 180;
      // A tap during the momentum tail must not select a card.
      state.suppressClickUntil = now + 350;
      moveGloss(event.clientX);
    }, { passive: false });

    els.stage.addEventListener('pointerdown', (event) => {
      moveGloss(event.clientX);
      if (!state.tracks.length || isSceneUI(event.target) || event.target.closest('.control')) return;
      if (event.button !== undefined && event.button !== 0) return;
      if (event.isPrimary === false) return;
      state.press = {
        card: event.target.closest('.card'),
        x: event.clientX, y: event.clientY,
        t: performance.now(), moved: false, pointerId: event.pointerId
      };
      try { els.stage.setPointerCapture(event.pointerId); } catch (_) { /* older browser */ }
      state.dragging = true;
      state.moved = false;
      state.dragStartX = event.clientX;
      state.lastX = event.clientX;
      state.lastT = performance.now();
      state.target = null;
    });

    els.stage.addEventListener('pointermove', (event) => {
      moveGloss(event.clientX);
      if (state.press && !state.press.moved) {
        const dx = event.clientX - state.press.x;
        const dy = event.clientY - state.press.y;
        if (Math.hypot(dx, dy) > 6) state.press.moved = true;
      }
      if (!state.dragging) return;
      const deltaX = event.clientX - state.lastX;
      const now = performance.now();
      if (Math.abs(event.clientX - state.dragStartX) > 6) {
        state.moved = true;
        openWheel();
      }
      if (state.mode === 'wheel') {
        const change = deltaX * 0.32;
        state.rotation += change;
        const elapsed = Math.max(8, now - state.lastT);
        state.velocity = clamp(change * (16 / elapsed) * 0.9 + state.velocity * 0.1, -30, 30);
      }
      state.lastX = event.clientX;
      state.lastT = now;
    });

    function endDrag(event) {
      if (event && event.isPrimary === false) return;
      if (!state.dragging) return;
      const press = state.press;
      const now = performance.now();
      state.dragging = false;
      state.press = null;
      if (press) {
        try { els.stage.releasePointerCapture(press.pointerId); } catch (_) { /* already gone */ }
      }

      const isTap = press && press.card && !press.moved &&
        now - press.t < 250 && now >= state.suppressClickUntil;
      if (isTap) selectCard(press.card);
      else if (press && press.moved) state.suppressClickUntil = now + 300;

      if (state.mode === 'wheel') state.snapAt = performance.now() + 120;
      else if (state.moved) openWheel();
      if (reduceMotion) { state.velocity = 0; snapToNearest(); }
    }
    els.stage.addEventListener('pointerup', endDrag);
    els.stage.addEventListener('pointercancel', endDrag);

    window.addEventListener('keydown', (event) => {
      if (!state.tracks.length) return;
      if (event.target.closest && event.target.closest('button')) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault(); stepTo(state.frontIndex + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault(); stepTo(state.frontIndex - 1);
      } else if (event.key === 'Enter' && state.mode === 'wheel') {
        event.preventDefault();
        selectCard(frontCard()); // Enter collapses to the front/selected card
      } else if (event.key === 'Escape' && state.mode === 'wheel') {
        closeWheel();
      } else if (event.key === ' ') {
        event.preventDefault(); togglePlayAnimation();
      }
    });

    els.backButton.addEventListener('click', closeWheel);
    els.retryButton.addEventListener('click', load);
    els.stateRetry.addEventListener('click', load);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    window.addEventListener('resize', () => {
      if (state.tracks.length) {
        computeRadius();
        if (state.mode === 'wheel') applyWheel();
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Data + once-per-second progress tick
   * ---------------------------------------------------------------- */
  async function load() {
    try {
      const response = await fetch('/api/recent', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load your recent listens.');

      const previousFirst = state.tracks.length ? trackKey(state.tracks[0]) : null;
      els.username.textContent = data.username || 'Last.fm';
      els.refreshTime.textContent = data.fetchedAt
        ? `updated ${new Date(data.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : '—';

      if (data.stale) {
        setStatus('last known listens', 'stale');
        els.bannerText.textContent = data.message || 'Last.fm is unreachable, showing the last known listens.';
        els.banner.hidden = false;
      } else {
        setStatus('live', '');
        els.banner.hidden = true;
      }

      if (!Array.isArray(data.tracks) || data.tracks.length === 0) {
        showState('♪', 'No listens yet',
          'Play something in Apple Music with a scrobbler app connected to Last.fm, and your recent listens will appear here as giant player cards.');
        document.body.classList.remove('is-loading');
        return;
      }

      hideState();
      document.body.classList.remove('is-loading');
      renderTracks(data.tracks, previousFirst);
      state.nowPlayingStart = Date.now();
      tick();
    } catch (error) {
      setStatus('offline', 'error');
      showState('⚠', 'Cannot load your listens',
        error.message || 'Your server could not reach Last.fm. Please try again in a moment.', true);
    }
  }

  function tick() {
    const card = frontCard();
    if (!card || !card._parts || state.paused) return;
    const parts = card._parts;

    let seconds;
    if (parts.nowPlaying || parts.demoProgress) {
      // Last.fm has no "progress" for all-time favourites: loop it gently so
      // the player card still looks alive without pretending to be a scrobble.
      seconds = ((Date.now() - state.nowPlayingStart) / 1000) % parts.duration;
    } else {
      seconds = Math.min(parts.duration, Math.max(0, (Date.now() - Date.parse(parts.playedAt)) / 1000));
      parts.time.textContent = relativeTime(parts.playedAt);
    }

    const percent = `${(seconds / parts.duration * 100).toFixed(2)}%`;
    parts.fill.style.width = percent;
    parts.knob.style.left = percent;
    parts.elapsed.textContent = formatTime(seconds);
    parts.remaining.textContent = `-${formatTime(parts.duration - seconds)}`;
  }

  /* ---------------------------------------------------------------- *
   * Go
   * ---------------------------------------------------------------- */
  loadScenePhoto();
  initDebug();
  bindInput();
  renderLoading();
  setStatus('loading', '');
  load();
  window.setInterval(load, 60 * 1000); // poll every minute
  window.setInterval(tick, 1000);
})();
