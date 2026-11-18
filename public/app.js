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
 * swipe / drag / arrow keys) becomes a tilted Saturn ring of upright posters
 * around that phone. Your most-played track is the biggest and brightest;
 * quieter ones stay smaller but always readable. Clicking any visible card
 * selects it reliably.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Layout-only poster size used for spacing and the bounding box. The actual
  // per-frame size curve is --front-boost / --back-shrink (see applyWheel).
  const RING_FRONT_SCALE = 1.22;
  const RING_FRONT_WIDTH = 0.92; // front poster width / front neighbour spacing
  const els = {
    scene: $('scene'), stage: $('stage'), deck: $('deck'),
    username: $('username'), refreshTime: $('refreshTime'), counter: $('counter'),
    status: $('status'), statusText: $('statusText'),
    hint: $('hint'), backButton: $('backButton'),
    caption: $('caption'), captionRank: $('captionRank'),
    captionPlays: $('captionPlays'), captionTitle: $('captionTitle'),
    captionArtists: $('captionArtists'),
    banner: $('banner'), bannerText: $('bannerText'), retryButton: $('retryButton'),
    stateCard: $('stateCard'), stateIcon: $('stateIcon'), stateTitle: $('stateTitle'),
    stateBody: $('stateBody'), stateRetry: $('stateRetry'),
    debugPanel: $('debugPanel'), debugOverlay: $('debugOverlay'), debugValues: $('debugValues'),
    scaleSlider: $('scaleSlider'), scaleOut: $('scaleOut'),
    ringRxSlider: $('ringRxSlider'), ringRxOut: $('ringRxOut'),
    ringRollSlider: $('ringRollSlider'), ringRollOut: $('ringRollOut'),
    ringTiltSlider: $('ringTiltSlider'), ringTiltOut: $('ringTiltOut'),
    perspectiveSlider: $('perspectiveSlider'), perspectiveOut: $('perspectiveOut'),
    ringCySlider: $('ringCySlider'), ringCyOut: $('ringCyOut'),
    ringCardSlider: $('ringCardSlider'), ringCardOut: $('ringCardOut'),
    frontBoostSlider: $('frontBoostSlider'), frontBoostOut: $('frontBoostOut'),
    backShrinkSlider: $('backShrinkSlider'), backShrinkOut: $('backShrinkOut'),
    anchorPick: $('anchorPick'), hitOutline: $('hitOutline')
  };

  // The two halves of the Saturn ring are siblings of the cards inside the
  // deck, so their z-index can interleave with the depth-sorted posters.
  els.ringBack = makeRingSvg('back');
  els.ringFront = makeRingSvg('front');

  // Kept between the two ring halves for stable DOM ordering. Its old masked
  // photo made back posters disappear behind the person; CSS now keeps it
  // hidden so every poster remains visible.
  els.personCover = el('div', 'person-cover');
  els.personCover.setAttribute('aria-hidden', 'true');

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
    anchor: { x: 51, y: 52 },

    // Saturn ring geometry (stage-relative; --ring-* vars keep them tunable).
    ringRx: 52,           // % of stage width
    ringRy: 17,           // % of stage height, before --ring-tilt
    ringTilt: 1,          // multiplier on --ring-ry
    ringRoll: -9,         // degrees, banks the whole ring (cards stay upright)
    perspective: 2.2,     // camera distance f; smaller = stronger perspective
    ringCyOffset: 0,      // px, moves the whole ellipse vertically
    ringCardScale: 1,     // debug multiplier for the ring posters
    frontBoost: 1.3,        // size at θ = 0
    backShrink: 1,        // size at θ = π
    effectiveFrontBoost: 1,
    ring: {
      w: 0, h: 0, cx: 0, cy: 0, baseCy: 0, rx: 0, ry: 0,
      roll: 0, perspective: 2.2, autoPush: 0,
      cardW: 0, cardH: 0
    },

    // Stable selection: artist + track + playedAt, never an array index.
    selectedId: null,
    explicitSelection: false,
    press: null,          // pointer-down candidate for a click
    suppressClickUntil: 0, // blocks taps right after a drag / momentum scroll
    debugOn: false,
    enterStart: 0,        // staggered fly-out timestamp
    closeAt: 0,           // reverse (fly back into the phone) timestamp
    reorder: null         // rank reshuffle: ease each poster to its new slot
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

  /** One half of the Saturn ring: a faint band plus a luminous elliptical line. */
  function makeRingSvg(kind) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `ring ring--${kind}`);
    svg.setAttribute('aria-hidden', 'true');
    const band = document.createElementNS(SVG_NS, 'path');
    band.setAttribute('class', 'ring__band');
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('class', 'ring__line');
    // Shadows/reflections live in the front SVG so they paint above back cards
    // but below front cards (ring--front has z-index 500).
    const fx = kind === 'front' ? document.createElementNS(SVG_NS, 'g') : null;
    if (fx) {
      fx.setAttribute('class', 'ring__fx');
      svg.append(fx, band, line);
    } else {
      svg.append(band, line);
    }
    svg._parts = { band, line, fx };
    return svg;
  }

  /** One blurred shadow + one colour reflection per card, on the near ring. */
  function syncRingFx(cards) {
    const fx = els.ringFront._parts.fx;
    if (!fx) return;
    fx.replaceChildren();
    cards.forEach((card) => {
      const shadow = document.createElementNS(SVG_NS, 'ellipse');
      shadow.setAttribute('class', 'ring__shadow');
      const reflection = document.createElementNS(SVG_NS, 'ellipse');
      reflection.setAttribute('class', 'ring__reflection');
      fx.append(shadow, reflection);
      if (card._parts) card._parts.fx = { shadow, reflection };
    });
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
      // The server sends the occurrence count; keep the local one as a fallback
      // for older cached responses.
      const fallback = Math.max(
        1, Number(track.fallbackCount) || occurrences.get(playKey(track)) || 1
      );
      const count = fromLastfm !== null && track.playCount !== null &&
        Number.isFinite(fromLastfm) && fromLastfm >= 0
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
    updateCaption(null);
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
    // Show the offset actually applied, including any automatic phone clearance.
    const effectiveCy = state.tracks.length && state.ring.w
      ? state.ring.cy - state.ring.h * state.anchor.y / 100
      : state.ringCyOffset;
    const text =
      `--phone-x: ${state.anchor.x.toFixed(1)};\n` +
      `--phone-y: ${state.anchor.y.toFixed(1)};\n` +
      `--card-scale: ${state.cardScale.toFixed(2)};\n` +
      `--ring-rx: ${state.ringRx.toFixed(0)}%;\n` +
      `--ring-ry: ${state.ringRy.toFixed(0)}%;\n` +
      `--ring-roll: ${state.ringRoll.toFixed(0)}deg;\n` +
      `--ring-tilt: ${state.ringTilt.toFixed(2)};\n` +
      `--perspective: ${state.perspective.toFixed(2)};\n` +
      `--ring-cy-offset: ${effectiveCy.toFixed(0)}px;\n` +
      `--ring-card-scale: ${state.ringCardScale.toFixed(2)}×;\n` +
      `--front-boost: ${state.frontBoost.toFixed(2)};` +
      ` (effective ${state.effectiveFrontBoost.toFixed(2)}${
        state.effectiveFrontBoost < state.frontBoost - 0.001
          ? ', capped: phone clearance' : ''})\n` +
      `--back-shrink: ${state.backShrink.toFixed(2)};`;
    els.debugValues.textContent = text;
    console.log('[debug]', text.replace(/\n/g, ' '));
  }

  function applySettings() {
    root.style.setProperty('--card-scale', state.cardScale.toFixed(2));
    root.style.setProperty('--ring-rx', state.ringRx.toFixed(0));
    root.style.setProperty('--ring-ry', state.ringRy.toFixed(0));
    root.style.setProperty('--ring-roll', `${state.ringRoll.toFixed(0)}deg`);
    root.style.setProperty('--ring-tilt', state.ringTilt.toFixed(2));
    root.style.setProperty('--perspective', state.perspective.toFixed(2));
    root.style.setProperty('--ring-cy-offset', `${state.ringCyOffset.toFixed(0)}px`);
    root.style.setProperty('--ring-card-scale', state.ringCardScale.toFixed(2));
    els.scaleOut.textContent = state.cardScale.toFixed(2);
    els.ringRxOut.textContent = `${state.ringRx.toFixed(0)}%`;
    els.ringRollOut.textContent = `${state.ringRoll.toFixed(0)}°`;
    els.ringTiltOut.textContent = `${state.ringTilt.toFixed(2)}×`;
    els.perspectiveOut.textContent = state.perspective.toFixed(2);
    els.ringCyOut.textContent = `${state.ringCyOffset.toFixed(0)}px`;
    els.ringCardOut.textContent = `${state.ringCardScale.toFixed(2)}×`;
    els.frontBoostOut.textContent = state.frontBoost.toFixed(2);
    els.backShrinkOut.textContent = state.backShrink.toFixed(2);
    root.style.setProperty('--back-shrink', state.backShrink.toFixed(2));
    if (state.tracks.length) {
      computeRadius();
      if (state.mode === 'wheel') applyWheel();
    }
    updateFrontBoost();
    if (!els.debugPanel.hidden) printDebug();
  }

  function initDebug() {
    const params = new URLSearchParams(location.search);
    const on = params.get('debug') === '1';
    state.debugOn = on;

    try {
      const saved = JSON.parse(localStorage.getItem('wot-settings') || 'null');
      if (saved) {
        // Older layouts kept the anchor and phone card scale.
        if (saved.v >= 2 && saved.v <= 8) {
          if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) state.anchor = { x: saved.x, y: saved.y };
          if (Number.isFinite(saved.cardScale)) state.cardScale = clamp(saved.cardScale, 0.5, 1.6);
        }
        if (saved.v >= 4 && saved.v <= 8) {
          if (Number.isFinite(saved.ringRx)) state.ringRx = clamp(saved.ringRx, 20, 60);
          if (Number.isFinite(saved.ringCyOffset)) state.ringCyOffset = clamp(saved.ringCyOffset, -80, 80);
          if (Number.isFinite(saved.ringCardScale)) state.ringCardScale = clamp(saved.ringCardScale, 0.6, 1.5);
        }
        if (saved.v >= 5 && saved.v <= 8) {
          if (Number.isFinite(saved.ringRoll)) state.ringRoll = clamp(saved.ringRoll, -30, 30);
          if (Number.isFinite(saved.ringTilt)) state.ringTilt = clamp(saved.ringTilt, 0.4, 1.8);
          if (Number.isFinite(saved.perspective)) state.perspective = clamp(saved.perspective, 1.2, 5);
        }
        if (saved.v === 8 && Number.isFinite(saved.frontBoost)) {
          state.frontBoost = clamp(saved.frontBoost, 1, 2);
        }
        if (saved.v === 8 && Number.isFinite(saved.backShrink)) {
          state.backShrink = clamp(saved.backShrink, 0.3, 1);
        }
      }
    } catch (_) { /* ignore broken storage */ }

    root.style.setProperty('--phone-x', state.anchor.x.toFixed(1));
    root.style.setProperty('--phone-y', state.anchor.y.toFixed(1));
    els.scaleSlider.value = String(state.cardScale);
    els.ringRxSlider.value = String(state.ringRx);
    els.ringRollSlider.value = String(state.ringRoll);
    els.ringTiltSlider.value = String(state.ringTilt);
    els.perspectiveSlider.value = String(state.perspective);
    els.ringCySlider.value = String(state.ringCyOffset);
    els.ringCardSlider.value = String(state.ringCardScale);
    els.frontBoostSlider.value = String(state.frontBoost);
    els.backShrinkSlider.value = String(state.backShrink);
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
      applySettings();
    }
    let dragging = false;
    els.debugOverlay.addEventListener('pointerdown', (event) => { dragging = true; setAnchor(event); });
    els.debugOverlay.addEventListener('pointermove', (event) => { if (dragging) setAnchor(event); });
    window.addEventListener('pointerup', () => { dragging = false; });

    const bindSlider = (input, apply) => input.addEventListener('input', () => {
      apply(Number(input.value)); saveSettings(); applySettings();
    });
    bindSlider(els.scaleSlider, (v) => { state.cardScale = v; });
    bindSlider(els.ringRxSlider, (v) => { state.ringRx = v; });
    bindSlider(els.ringRollSlider, (v) => { state.ringRoll = v; });
    bindSlider(els.ringTiltSlider, (v) => { state.ringTilt = v; });
    bindSlider(els.perspectiveSlider, (v) => { state.perspective = v; });
    bindSlider(els.ringCySlider, (v) => { state.ringCyOffset = v; });
    bindSlider(els.ringCardSlider, (v) => { state.ringCardScale = v; });
    bindSlider(els.frontBoostSlider, (v) => { state.frontBoost = v; });
    bindSlider(els.backShrinkSlider, (v) => { state.backShrink = v; });
    // The anchor overlay covers the whole stage. Keep it off by default so
    // debug mode can still click cards and log their data-id; enable it only
    // while deliberately picking the phone position.
    els.anchorPick.addEventListener('change', () => {
      document.body.classList.toggle('pick-anchor', els.anchorPick.checked);
    });
    els.hitOutline.addEventListener('change', () => {
      document.body.classList.toggle('show-hit-areas', els.hitOutline.checked);
    });
  }

  function saveSettings() {
    localStorage.setItem('wot-settings', JSON.stringify({
      v: 8,
      x: state.anchor.x, y: state.anchor.y,
      cardScale: state.cardScale,
      ringRx: state.ringRx,
      ringRoll: state.ringRoll, ringTilt: state.ringTilt,
      perspective: state.perspective,
      ringCyOffset: state.ringCyOffset, ringCardScale: state.ringCardScale,
      frontBoost: state.frontBoost, backShrink: state.backShrink
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
    if (card === frontCard() || card.dataset.id === state.selectedId) updateSceneTint();
  }

  function updateSceneTint() {
    // The ring line/band and the photo spill follow the SELECTED cover, even
    // while that poster is still rotating into the front slot.
    const cards = Array.from(els.deck.querySelectorAll('.card'));
    const card = cards.find((item) => item.dataset.id === state.selectedId) || frontCard();
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
    Array.from(els.deck.querySelectorAll('.card')).forEach((card) => {
      card.classList.toggle('is-selected', card.dataset.id === state.selectedId);
    });
    updateCaption(track);
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
    }
  }

  /** The #N badge follows the SERVER rank, never the ring position. */
  function applyRank(card, track) {
    const rank = Math.max(1, Number(track.rank) || 1);
    card.style.setProperty('--rank', String(rank));
    card.classList.toggle('card--podium', rank <= 3);
    if (card._parts && card._parts.rankBadge) {
      card._parts.rankBadge.textContent = `#${rank}`;
    }
  }

  /** Shared by the card label and the caption block. */
  function playLabelFor(track, stats) {
    const count = stats ? stats.count : NaN;
    if (!Number.isFinite(count) || count <= 0) return '';
    const known = track.playCount !== null && track.playCount !== undefined &&
      track.playCount !== '' && Number.isFinite(Number(track.playCount));
    return `${known ? '' : '~'}${count} ${count === 1 ? 'play' : 'plays'}`;
  }

  /** Play count replaces the old "played X ago" label, in the same spot. */
  function updatePlayLabel(card, track, stats) {
    if (!card || !card._parts || !card._parts.playLabel) return;
    card._parts.playLabel.textContent = playLabelFor(track, stats);
  }

  /** Full credited artists: complete artist string + title "(feat. X)" names. */
  function captionArtistsFor(track) {
    const credited = String(track.artist || '').trim();
    const names = [];
    const pattern = /[\(\[]\s*(?:feat(?:uring)?|ft|with)\.?\s*([^\)\]]+)[\)\]]/gi;
    let match;
    while ((match = pattern.exec(String(track.track || '')))) {
      match[1].split(/\s*(?:,|&|\band\b|\bwith\b)\s*/i).forEach((part) => {
        const name = part.trim().replace(/^(?:feat(?:uring)?|ft)\.?\s*/i, '');
        if (name && !names.includes(name) &&
            !credited.toLowerCase().includes(name.toLowerCase())) names.push(name);
      });
    }
    return names.length ? `${credited} (feat. ${names.join(', ')})` : credited;
  }

  /** The caption is the only place the full, untruncated text lives. */
  function updateCaption(track, stats) {
    if (!track) {
      els.caption.classList.remove('is-visible', 'is-swap');
      return;
    }
    const statsForTrack = stats || (state.tracks.length
      ? computePlayStats(state.tracks).get(selectionId(track)) : null);
    els.captionRank.textContent = `#${Math.max(1, Number(track.rank) || 1)}`;
    els.captionPlays.textContent = playLabelFor(track, statsForTrack);
    els.captionTitle.textContent = String(track.track || '');
    els.captionArtists.textContent = captionArtistsFor(track);
    els.caption.classList.remove('is-swap');
    void els.caption.offsetWidth; // restart the text-swap animation
    els.caption.classList.add('is-swap', 'is-visible');
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
    const rank = Math.max(1, Number(track.rank) || index + 1);

    const card = el('div', 'card');
    card.dataset.id = selectionId(track);
    card.classList.toggle('card--podium', rank <= 3);
    card.style.setProperty('--i', index);
    card.style.setProperty('--rank', String(rank));
    card.style.setProperty('--tilt-z', `${hashString(track.track) % 7 - 3}deg`);
    card.style.setProperty('--tilt-x', `${hashString(track.artist) % 9 - 4}deg`);
    card.style.setProperty('--focus', '1');
    applyPlayVars(card, stats || { scale: 0.97, glow: 0.62, lift: 0.5, count: 1 });

    const scaler = el('div', 'card__scaler');
    const surface = el('div', 'card__surface');
    surface.append(
      el('div', 'card__glass'), el('div', 'card__tint'),
      el('div', 'card__gloss'), el('div', 'card__fog')
    );
    const selectedBadge = el('span', 'card__selected', 'Selected');
    selectedBadge.setAttribute('aria-hidden', 'true');
    surface.appendChild(selectedBadge);

    const content = el('div', 'card__content');

    // --- artwork (through our proxy so the canvas stays readable) ---
    const cover = el('div', 'cover');
    const label = track.album || track.track;
    const rankBadge = el('span', 'cover__rank', `#${rank}`);
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
        cover.replaceChildren(makeGradientCover(track.track), el('div', 'cover__shade'), rankBadge);
        applyTint(card, tintFromTitle(label));
      };
      image.src = `/api/cover?u=${encodeURIComponent(track.image)}`;
      cover.appendChild(image);
    } else {
      cover.appendChild(makeGradientCover(track.track));
      applyTint(card, tintFromTitle(label));
    }
    cover.appendChild(el('div', 'cover__shade'));
    cover.appendChild(rankBadge);
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

    // --- play count only (the old "played X ago" label is gone) ---
    // The now-playing dot still sits in this same discreet label slot.
    const time = el('div', track.nowPlaying ? 'card__time card__time--live' : 'card__time');
    if (track.nowPlaying) {
      const dot = el('i', 'live-dot');
      dot.setAttribute('aria-hidden', 'true');
      time.appendChild(dot);
    }
    const playLabel = el('span', 'card__plays', '');
    time.appendChild(playLabel);
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
      fill, knob, elapsed, remaining, time, playLabel, rankBadge, tintRgb: null,
      duration: durationFor(track), playedAt: track.playedAt,
      nowPlaying: track.nowPlaying, demoProgress: track.lastfmPlaycount != null,
      glowBase: stats ? stats.glow : 0.62,
      playCount: stats ? stats.count : 1,
      theta: null
    };
    updatePlayLabel(card, track, stats);
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
    els.deck.replaceChildren(els.ringBack, els.personCover, els.ringFront, card);
  }

  function clearCardStyles() {
    Array.from(els.deck.querySelectorAll('.card')).forEach((card) => {
      card.style.transform = '';
      card.style.opacity = '';
      card.style.visibility = '';
      card.style.filter = '';
      card.style.zIndex = '';
      card.style.setProperty('--focus', '1');
      card.style.setProperty('--fog', '1');
      if (card._parts && card._parts.glowBase) {
        card.style.setProperty('--glow', card._parts.glowBase.toFixed(3));
      }
      card.classList.remove('is-entering', 'is-back');
    });
  }

  /**
   * /api/recent is already sorted by rank: index 0 is #1 by total play count,
   * or the fallback (#1 repeat count, then recency) when counts are missing.
   */
  function findDefaultIndex(tracks) { return tracks.length ? 0 : 0; }

  function renderTracks(tracks, previousFirst) {
    const wasWheel = state.mode === 'wheel';

    // The server already returns the tracks in RANK order (#1 first). Keep at
    // most 24, centred on the explicit choice if one exists.
    let list = tracks;
    if (tracks.length > 24) {
      const ids = tracks.map(selectionId);
      const selectedAt = state.explicitSelection && state.selectedId
        ? ids.indexOf(state.selectedId) : -1;
      const start = clamp(selectedAt < 0 ? 0 : selectedAt - 12, 0, tracks.length - 24);
      list = tracks.slice(start, start + 24);
    }
    tracks = list;

    const stats = computePlayStats(tracks);
    const ids = tracks.map(selectionId);

    // Keep only an EXPLICIT choice. Until the user picks a card, every refresh
    // follows the server's rank #1 (index 0, already fallback/recency ordered).
    let index = state.explicitSelection && state.selectedId
      ? ids.indexOf(state.selectedId) : -1;
    if (index < 0) {
      if (state.explicitSelection && state.selectedId) state.explicitSelection = false;
      index = findDefaultIndex(tracks);
    }
    const followRank = wasWheel && !state.explicitSelection &&
      ids[index] !== state.selectedId;

    const oldCards = Array.from(els.deck.querySelectorAll('.card'));
    const orderChanged = oldCards.length !== tracks.length ||
      oldCards.some((card, i) => card.dataset.id !== ids[i]);

    // A rank change reorders the ring. Capture the current angle of every card
    // so applyWheel can ease it to the new slot instead of jumping.
    if (wasWheel && !state.closeAt && orderChanged) {
      const from = new Map();
      oldCards.forEach((card) => {
        const theta = card._parts && card._parts.theta;
        if (Number.isFinite(theta)) from.set(card.dataset.id, theta);
      });
      state.reorder = { start: performance.now(), duration: 520, from };
    }

    // Reuse the existing card elements: a stable data-id keeps the current
    // selection, covers, tints and glow alive across a reshuffle.
    const oldById = new Map(oldCards.map((card) => [card.dataset.id, card]));
    const newCards = tracks.map((track, i) => {
      const id = ids[i];
      let card = oldById.get(id);
      if (card) {
        oldById.delete(id);
        applyRank(card, track);
        applyPlayVars(card, stats.get(id));
        updatePlayLabel(card, track, stats.get(id));
        card._parts.nowPlaying = Boolean(track.nowPlaying);
        card._parts.playedAt = track.playedAt;
        if (card._parts.time) {
          card._parts.time.classList.toggle('card__time--live', Boolean(track.nowPlaying));
        }
        return card;
      }
      return buildCard(track, i, tracks, stats.get(id));
    });
    if (orderChanged) {
      // replaceChildren MOVES the reused nodes (identity, styles and covers are
      // preserved) and drops any old skeleton / removed track in one step.
      els.deck.replaceChildren(els.ringBack, els.personCover, els.ringFront, ...newCards);
    }
    syncRingFx(newCards);

    state.tracks = tracks;
    state.selectedId = ids[index];
    state.frontIndex = index;
    newCards.forEach((card, i) => {
      card.classList.toggle('is-selected', i === index);
      card.classList.remove('is-front');
    });
    updateCaption(tracks[index], stats.get(ids[index]));

    state.step = tracks.length > 1 ? 360 / tracks.length : 0;
    computeRadius();
    if (followRank) {
      // A new #1 arrived while the user had not chosen anything: rotate to it
      // by the shortest path instead of jumping the whole ring.
      const target = index * state.step;
      state.target = target + Math.round((state.rotation - target) / 360) * 360;
      state.velocity = 0;
      state.snapAt = 0;
      startLoop();
    } else {
      // Keep the selected poster at θ = 0 while the other posters ease into the
      // new rank order. stepTo() still finds the shortest path afterwards.
      state.rotation = index * state.step;
      state.velocity = 0;
      state.target = null;
      state.snapAt = 0;
    }
    if (state.debugOn) printDebug();

    // A newly scrobbled track slides in at the front.
    if (previousFirst && trackKey(tracks[0]) !== previousFirst && !wasWheel && orderChanged) {
      const firstCard = els.deck.querySelector('.card');
      if (firstCard) firstCard.classList.add('is-new');
    }

    if (wasWheel) applyWheel();
    else {
      clearCardStyles();
      els.counter.textContent = `${index + 1} / ${tracks.length}`;
      updateSceneTint();
    }
  }

  /* ---------------------------------------------------------------- *
   * The Saturn ring: a banked, perspective-projected ellipse
   * ---------------------------------------------------------------- */
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const smoothstep = (a, b, value) => {
    const t = clamp((value - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const CARD_RATIO = 0.642857143; // 9:14 upright poster
  const MIN_PERSPECTIVE_SCALE = 0.32;

  /** p = f/(f-z), normalized so the near point z=+1 gives exactly 1. */
  function perspectiveScale(z, f) {
    return clamp((f - 1) / (f - z), MIN_PERSPECTIVE_SCALE, 1);
  }

  /** One shared projection for cards, ring line and band. Depth stays θ-only. */
  function projectRing(theta, cfg, ryScale = 1) {
    const { cx, cy, rx, ry, rollRad, perspective } = cfg;
    const z = Math.cos(theta);
    const s = perspectiveScale(z, perspective);
    const x0 = rx * Math.sin(theta) * s;
    const y0 = ry * ryScale * z * (0.6 + 0.4 * s);
    const cosR = Math.cos(rollRad);
    const sinR = Math.sin(rollRad);
    return {
      x: cx + x0 * cosR - y0 * sinR,
      y: cy + x0 * sinR + y0 * cosR,
      z, s
    };
  }

  /** Bounding box of the posters on the rolled ring, at their largest (front). */
  function measureRing(cfg, cardW, cardH) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const steps = 72;
    for (let i = 0; i < steps; i++) {
      const p = projectRing(i * 2 * Math.PI / steps, cfg);
      const halfW = cardW * RING_FRONT_SCALE / 2;
      minX = Math.min(minX, p.x - halfW);
      maxX = Math.max(maxX, p.x + halfW);
      minY = Math.min(minY, p.y - cardH * RING_FRONT_SCALE);
      maxY = Math.max(maxY, p.y);
    }
    return { minX, maxX, minY, maxY };
  }

  /**
   * Ring centre = phone anchor. The base size is derived from the projected gap
   * between the front neighbours; the front is then scaled up and the back down
   * (see RING_*_SCALE) so the ring reads with real depth. rx is reduced only if
   * the rolled ring overflows.
   */
  function computeRadius() {
    const stage = els.stage.getBoundingClientRect();
    const w = stage.width || els.stage.clientWidth || 400;
    const h = stage.height || els.stage.clientHeight || 700;
    const cx = w * state.anchor.x / 100;
    const baseCy = h * state.anchor.y / 100 + state.ringCyOffset;
    const rollRad = state.ringRoll * Math.PI / 180;
    const ry = Math.max(1, h * state.ringRy / 100 * state.ringTilt);
    const f = state.perspective;
    const count = Math.max(1, state.tracks.length);
    const margin = Math.max(4, Math.min(w, h) * 0.012);
    const stepAngle = count > 1 ? 2 * Math.PI / count : 0;

    let rx = Math.max(1, w * state.ringRx / 100);
    let cfg, cardW, cardH, bbox;
    for (let attempt = 0; attempt < 16; attempt++) {
      // Keep the front card's bottom near 62-68% of the stage.
      const frontY0 = baseCy + ry * Math.cos(rollRad);
      const targetBottom = h * (state.anchor.y / 100 + 0.10);
      const cy = baseCy + clamp(targetBottom - frontY0, 0, h * 0.08);
      cfg = { w, h, cx, cy, rx, ry, rollRad, perspective: f };

      // Gap-based base size. RING_FRONT_WIDTH is the *effective* front width
      // after scaling, so front neighbours keep a small gap while the front
      // poster is noticeably bigger than the back ones.
      const a = projectRing(0, cfg);
      const b = projectRing(stepAngle, cfg);
      const frontSpacing = count > 1
        ? Math.hypot(b.x - a.x, b.y - a.y) : rx;
      cardW = clamp(
        frontSpacing * RING_FRONT_WIDTH / RING_FRONT_SCALE * state.ringCardScale,
        w * 0.045, h * 0.18 * state.ringCardScale
      );
      cardH = cardW / CARD_RATIO;

      bbox = measureRing(cfg, cardW, cardH);
      const fits = bbox.minX >= margin && bbox.maxX <= w - margin &&
        bbox.minY >= margin && bbox.maxY <= h - margin;
      if (fits) break;

      // Vertical overflow is fixed by lifting the ellipse; horizontal overflow
      // by reducing rx (which also reduces the spacing-based card size).
      if (bbox.maxY > h - margin) {
        cfg.cy -= bbox.maxY - (h - margin);
        bbox = measureRing(cfg, cardW, cardH);
        if (bbox.minX >= margin && bbox.maxX <= w - margin &&
            bbox.minY >= margin && bbox.maxY <= h - margin) break;
      }
      rx *= 0.94;
    }

    const autoPush = cfg.cy - baseCy;
    state.ring = {
      w, h, cx, cy: cfg.cy, baseCy, rx, ry,
      roll: state.ringRoll, rollRad, perspective: f,
      autoPush, cardW, cardH, bbox
    };
    root.style.setProperty('--radius', '0px'); // phone card never gets Z push-back
    root.style.setProperty('--ring-card-w', `${cardW.toFixed(1)}px`);
    root.style.setProperty('--ring-card-h', `${cardH.toFixed(1)}px`);
    root.style.setProperty(
      '--ring-cy-offset', `${(state.ringCyOffset + autoPush).toFixed(0)}px`
    );
    updateRingGeometry();
    updateFrontBoost();
  }

  /**
   * The front poster grows upward from its ring point. Cap the requested
   * --front-boost so its scaled top edge never rises above the phone anchor;
   * nothing else in the layout is moved.
   */
  function frontBoostLimit() {
    if (!state.ring.w || !state.ring.cardH) return state.frontBoost;
    const front = projectRing(0, state.ring);
    const phoneY = state.ring.h * state.anchor.y / 100;
    // The phone card stands on that anchor: its top edge is one card-height
    // above it (plus the 1% deck offset used by the CSS).
    const phoneTop = phoneY - state.ring.h * 0.01 -
      state.ring.h * 0.36 * state.cardScale;
    const room = front.y - phoneTop;
    // The final front scale is frontBoost (the projection s is divided out of
    // SIZE only). Keep the historical 1.12 safety margin for any future boost,
    // so the top edge can never rise into the phone.
    const limit = room / (state.ring.cardH * 1.12);
    return clamp(limit, 1, state.frontBoost);
  }

  function updateFrontBoost() {
    state.effectiveFrontBoost = frontBoostLimit();
    root.style.setProperty('--front-boost', state.effectiveFrontBoost.toFixed(3));
  }

  /** Sample the same projection for both half-ellipses and their inner bands. */
  function ringArc(cfg, from, to, ryScale = 1, steps = 56) {
    let d = '';
    for (let i = 0; i <= steps; i++) {
      const p = projectRing(from + (to - from) * i / steps, cfg, ryScale);
      d += `${i ? ' L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    }
    return d;
  }

  /** Back half is θ ∈ [π/2, 3π/2]; front half is θ ∈ [-π/2, π/2]. */
  function updateRingGeometry() {
    const { w, h } = state.ring;
    const f = (n) => n.toFixed(1);
    for (const svg of [els.ringBack, els.ringFront]) {
      svg.setAttribute('viewBox', `0 0 ${f(w)} ${f(h)}`);
    }
    const backLine = ringArc(state.ring, Math.PI / 2, Math.PI * 1.5);
    const backInner = ringArc(state.ring, Math.PI * 1.5, Math.PI / 2, 0.78);
    const frontLine = ringArc(state.ring, -Math.PI / 2, Math.PI / 2);
    const frontInner = ringArc(state.ring, Math.PI / 2, -Math.PI / 2, 0.78);
    els.ringBack._parts.band.setAttribute('d', `${backLine} ${backInner} Z`);
    els.ringBack._parts.line.setAttribute('d', backLine);
    els.ringFront._parts.band.setAttribute('d', `${frontLine} ${frontInner} Z`);
    els.ringFront._parts.line.setAttribute('d', frontLine);
  }

  /**
   * θ = 0 is the near point (bottom of the ellipse, in front of the person);
   * θ = π is the far point. Cards stay upright and anchored on the ring, but
   * scale smoothly with depth so the front posters are larger than the back.
   */
  function applyWheel(now = performance.now()) {
    const cards = Array.from(els.deck.querySelectorAll('.card'));
    const count = cards.length;
    if (!count) return;

    const { w, h, cx, cy, cardW, cardH, roll } = state.ring;
    const frontRaw = count > 1 ? state.rotation / state.step : 0;
    state.frontIndex = ((Math.round(frontRaw) % count) + count) % count;
    const stepRad = state.step * Math.PI / 180;
    const phoneX = cx;
    const phoneY = h * state.anchor.y / 100 - h * 0.01;

    const entering = !!state.enterStart && !reduceMotion;
    const exiting = !!state.closeAt && !reduceMotion;
    const reorder = state.reorder;
    const reorderT = reorder
      ? clamp((now - reorder.start) / reorder.duration, 0, 1) : 1;
    const reorderEase = easeInOut(reorderT);
    let finishedEnter = false;
    let finishedExit = false;

    for (let i = 0; i < count; i++) {
      const card = cards[i];
      // θ = base + i·(2π/n), with base = -rotation so advancing the rotation
      // brings the next (higher-index) card to θ = 0 at the near point.
      let theta = (i - frontRaw) * stepRad;
      // A rank change reshuffles the slots; ease each poster from the angle it
      // had before the reshuffle to its new one (shortest way round).
      if (reorder && reorderT < 1 && card._parts) {
        const from = reorder.from.get(card.dataset.id);
        if (Number.isFinite(from)) {
          const shortest = Math.atan2(Math.sin(theta - from), Math.cos(theta - from));
          theta = from + shortest * reorderEase;
        }
      }
      if (card._parts) card._parts.theta = theta;
      const p = projectRing(theta, state.ring);
      const d = (p.z + 1) / 2; // depth stays θ-only, never affected by roll
      const finalX = p.x;
      const finalY = p.y;

      // Uniform poster size: depth and play count no longer change scale.
      // The perspective s still drives positions; it is divided out of SIZE so
      // every card keeps exactly the same dimensions on the ring.
      // The debug sliders remain live if a depth curve is wanted again.
      const depthScale = lerp(state.backShrink, state.effectiveFrontBoost,
        smoothstep(0, 1, d));
      const scale = (p.s / p.s) * depthScale;
      let opacity = clamp(lerp(0.35, 1, d), 0.35, 1);
      let x = finalX;
      let y = finalY;

      // Staggered fly-out: the front card leaves the phone first, the rest
      // follow 30 ms apart along the tilted ellipse. Reverse on collapse.
      if (entering) {
        const delay = ((i - state.frontIndex + count) % count) * 30;
        const t = clamp((now - state.enterStart - delay) / 520, 0, 1);
        const e = easeOut(t);
        x = lerp(phoneX, finalX, e);
        y = lerp(phoneY, finalY, e);
        opacity *= e;
        if (now - state.enterStart > (count - 1) * 30 + 520) finishedEnter = true;
      } else if (exiting) {
        const t = clamp((now - state.closeAt) / 480, 0, 1);
        const e = easeInOut(t);
        x = lerp(finalX, phoneX, e);
        y = lerp(finalY, phoneY, e);
        if (card.dataset.id !== state.selectedId) opacity *= (1 - e);
        if (t >= 1) finishedExit = true;
      }

      const blur = lerp(2, 0, d);
      const brightness = lerp(0.6, 1, d);
      const saturation = lerp(0.7, 1, d);
      const fog = d;
      const glowBase = card._parts && card._parts.glowBase
        ? card._parts.glowBase : 0.62;
      const nearAngle = Math.abs(Math.atan2(Math.sin(theta), Math.cos(theta)));
      const isFront = count === 1 || nearAngle < stepRad * 0.35;

      card.style.visibility = 'visible';
      card.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      card.style.opacity = opacity.toFixed(3);
      card.style.filter =
        `blur(${blur.toFixed(2)}px) brightness(${brightness.toFixed(2)}) ` +
        `saturate(${saturation.toFixed(2)})`;
      card.style.zIndex = String(Math.round(d * 1000));
      card.style.setProperty('--focus', (0.35 + 0.65 * d).toFixed(2));
      card.style.setProperty('--fog', fog.toFixed(3));
      card.style.setProperty('--glow', Math.max(0.25, glowBase * (0.55 + 0.45 * d)).toFixed(3));
      card.classList.toggle('is-front', isFront);
      card.classList.toggle('is-back', d < 0.5);

      // Ring-plane marks: dark contact shadow + tinted reflection, front half
      // only. Both follow the same rolled point as the poster bottom.
      if (card._parts && card._parts.fx) {
        const near = clamp((d - 0.5) / 0.5, 0, 1);
        const { shadow, reflection } = card._parts.fx;
        const show = near > 0.01;
        shadow.style.display = show ? '' : 'none';
        reflection.style.display = show ? '' : 'none';
        if (show) {
          const sx = x.toFixed(1), sy = y.toFixed(1);
          const rotate = `rotate(${roll.toFixed(1)} ${sx} ${sy})`;
          shadow.setAttribute('cx', sx);
          shadow.setAttribute('cy', sy);
          shadow.setAttribute('rx', (cardW * scale * 0.55).toFixed(1));
          shadow.setAttribute('ry', (cardH * scale * 0.10).toFixed(1));
          shadow.setAttribute('transform', rotate);
          shadow.setAttribute('opacity', (near * 0.30).toFixed(3));

          const rgb = card._parts.tintRgb || '120, 150, 210';
          reflection.setAttribute('cx', sx);
          reflection.setAttribute('cy', (y + cardH * scale * 0.02).toFixed(1));
          reflection.setAttribute('rx', (cardW * scale * 0.48).toFixed(1));
          reflection.setAttribute('ry', (cardH * scale * 0.055).toFixed(1));
          reflection.setAttribute('transform', rotate);
          reflection.setAttribute('fill', `rgba(${rgb}, ${(near * 0.16).toFixed(3)})`);
        }
      }
    }

    els.counter.textContent = `${state.frontIndex + 1} / ${count}`;
    updateSceneTint();
    if (reorder && reorderT >= 1) state.reorder = null;
    if (finishedEnter) {
      state.enterStart = 0;
      cards.forEach((card) => card.classList.remove('is-entering'));
    }
    if (finishedExit) finishClose();
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
    state.reorder = null; // user input wins over a rank reshuffle
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
    applyWheel(now);
    // applyWheel may finish the fly-back and switch to phone mode.
    state.raf = state.mode === 'wheel' ? requestAnimationFrame(frame) : null;
  }

  function startLoop() { if (!state.raf) state.raf = requestAnimationFrame(frame); }
  function stopLoop() { if (state.raf) cancelAnimationFrame(state.raf); state.raf = null; }

  function openWheel() {
    // Reopening while the fly-back is still running simply reverses it.
    if (state.closeAt) {
      state.closeAt = 0;
      state.enterStart = performance.now();
      startLoop();
      return;
    }
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
    Array.from(els.deck.querySelectorAll('.card')).forEach((card, i) => {
      card.classList.toggle('is-selected', i === selected);
      card.classList.add('is-entering');
    });
    state.rotation = selected * state.step;
    state.target = null;
    state.velocity = 0;
    state.snapAt = 0;
    state.enterStart = performance.now();
    startLoop();
  }

  function closeWheel() {
    if (state.mode !== 'wheel' || state.closeAt) return;
    // The visible front card is the choice we collapse to.
    if (state.tracks.length) setSelected(state.frontIndex);
    state.target = null;
    state.velocity = 0;
    state.snapAt = 0;
    if (reduceMotion || !state.tracks.length) { finishClose(); return; }
    // Keep the ring alive for the reverse animation; applyWheel ends it.
    state.closeAt = performance.now();
    startLoop();
  }

  function finishClose() {
    state.mode = 'phone';
    document.body.classList.remove('is-wheel');
    els.backButton.hidden = true;
    stopLoop();
    state.rotation = 0;
    state.velocity = 0;
    state.target = null;
    state.snapAt = 0;
    state.closeAt = 0;
    state.enterStart = 0;
    clearCardStyles();
    Array.from(els.deck.querySelectorAll('.card')).forEach((card) => {
      card.classList.remove('is-front', 'is-entering');
    });
    if (state.tracks.length) {
      els.counter.textContent = `${findSelectedIndex() + 1} / ${state.tracks.length}`;
    }
    updateSceneTint();
  }

  function frontCard() {
    const cards = Array.from(els.deck.querySelectorAll('.card'));
    if (!cards.length) return null;
    if (state.mode === 'wheel' || state.closeAt) return cards[state.frontIndex] || null;
    return cards.find((card) => card.dataset.id === state.selectedId) || cards[0] || null;
  }

  function togglePlayAnimation() {
    state.paused = !state.paused;
    const card = frontCard();
    const button = card && card.querySelector('.control--play');
    if (button) button.innerHTML = state.paused ? ICONS.play : ICONS.pause;
  }

  /** A real click: select the card, rotate it to the front, or collapse if it
   *  is already the front one. Selection is by data-id, never by a stale index. */
  function selectCard(card) {
    if (!card || !card.dataset || !card.dataset.id) return;
    const cards = Array.from(els.deck.querySelectorAll('.card'));
    const index = cards.indexOf(card);
    if (index < 0) return;
    if (state.debugOn) console.log('[debug][click] data-id =', card.dataset.id);
    if (state.mode !== 'wheel') {
      setSelected(index);
      openWheel();
      return;
    }
    if (card.classList.contains('is-front')) closeWheel();
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

  /**
   * Topmost card under a screen point. Decorative layers have pointer-events:
   * none, but elementsFromPoint can still report them — walking up to [data-id]
   * and taking the highest z-index makes overlapping cards resolve correctly.
   */
  function cardAtPoint(clientX, clientY) {
    const stack = document.elementsFromPoint(clientX, clientY);
    let best = null;
    let bestZ = -Infinity;
    for (const node of stack) {
      const card = node.closest && node.closest('.card[data-id]');
      if (!card || !els.deck.contains(card)) continue;
      const z = Number(card.style.zIndex) || 0;
      if (z > bestZ) { bestZ = z; best = card; }
    }
    return best;
  }

  function bindInput() {
    let wheelCooldown = 0;
    let press = null;

    // The page is fixed, so a wheel event anywhere opens / spins the ring.
    window.addEventListener('wheel', (event) => {
      if (!state.tracks.length || isSceneUI(event.target)) return;
      event.preventDefault();
      openWheel();
      state.target = null;
      const now = performance.now();
      if (now - wheelCooldown < 16) return;
      wheelCooldown = now;
      const raw = event.deltaY + event.deltaX;
      const delta = event.deltaMode === 1 ? raw * 16 : raw;
      state.velocity = clamp(state.velocity + delta * 0.05, -24, 24);
      state.snapAt = now + 180;
      state.suppressClickUntil = now + 350; // momentum must never click a card
      moveGloss(event.clientX);
    }, { passive: false });

    // NO pointer capture here: capturing on pointerdown retargets the eventual
    // click away from the poster the user actually pressed.
    els.stage.addEventListener('pointerdown', (event) => {
      moveGloss(event.clientX);
      if (!state.tracks.length || isSceneUI(event.target)) return;
      if (event.button !== undefined && event.button !== 0) return;
      if (event.isPrimary === false) return;
      if (event.target.closest && event.target.closest('.control')) return;
      state.reorder = null; // user input wins over a rank reshuffle
      const now = performance.now();
      press = {
        id: event.pointerId,
        startX: event.clientX, startY: event.clientY,
        lastX: event.clientX, lastT: now, t: now,
        card: cardAtPoint(event.clientX, event.clientY),
        dragging: false, captured: false
      };
      state.press = press;
      state.dragging = false;
      state.target = null;
    });

    // Only horizontal movement turns into a drag; vertical gestures are left
    // to the page (touch-action: pan-y on the ring).
    window.addEventListener('pointermove', (event) => {
      moveGloss(event.clientX);
      if (!press || event.pointerId !== press.id) return;
      if (!press.dragging && Math.abs(event.clientX - press.startX) > 6) {
        press.dragging = true;
        state.dragging = true;
        document.body.classList.add('is-dragging');
        // Capture only after the drag threshold is crossed.
        try { els.stage.setPointerCapture(event.pointerId); press.captured = true; }
        catch (_) { /* older browser */ }
        openWheel();
      }
      if (!press.dragging) return;
      const deltaX = event.clientX - press.lastX;
      const now = performance.now();
      if (state.mode === 'wheel') {
        state.rotation += deltaX * 0.32;
        const elapsed = Math.max(8, now - press.lastT);
        state.velocity = clamp(deltaX * (16 / elapsed) * 0.9 + state.velocity * 0.1, -30, 30);
        state.target = null;
      }
      press.lastX = event.clientX;
      press.lastT = now;
    });

    function endPointer(event, cancelled) {
      if (!press || event.pointerId !== press.id) return;
      const p = press;
      press = null;
      state.press = null;
      state.dragging = false;
      document.body.classList.remove('is-dragging');
      if (p.captured) {
        try { els.stage.releasePointerCapture(p.pointerId); } catch (_) { /* already gone */ }
      }
      const now = performance.now();
      if (!p.dragging && !cancelled && now - p.t < 300 && now >= state.suppressClickUntil) {
        // Re-check at pointerup: if neighbours overlap, cardAtPoint picks the
        // one with the highest z-index (the poster actually on top). Releasing
        // outside every card intentionally selects nothing.
        const hit = cardAtPoint(event.clientX, event.clientY);
        if (state.debugOn) console.log('[debug][hit-test] data-id =', hit ? hit.dataset.id : null);
        if (hit) selectCard(hit);
      }
      if (p.dragging) {
        state.suppressClickUntil = now + 350;
        if (state.mode === 'wheel') state.snapAt = now + 120;
      }
      if (reduceMotion) { state.velocity = 0; snapToNearest(); }
    }
    window.addEventListener('pointerup', (event) => endPointer(event, false));
    window.addEventListener('pointercancel', (event) => endPointer(event, true));

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
        if (state.mode === 'wheel') applyWheel(performance.now());
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
