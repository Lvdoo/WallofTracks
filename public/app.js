'use strict';

/*
 * What your music looks like — frontend
 * -------------------------------------
 * Plain JavaScript. The browser talks ONLY to our own server:
 *   /api/recent  -> the last 50 listens (no secrets, ever)
 *   /api/cover   -> same-origin image proxy, so canvas can read cover pixels
 *
 * The visual idea: a giant iOS "Now Playing" card is a physical object inside
 * the photo. It rises out of the flat phone, casts a shadow, and (on scroll /
 * swipe / drag / arrow keys) becomes a 3D wheel of recent albums.
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
    anchor: { x: 50, y: 68 }
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
    const candidates = ['/assets/me.jpg', '/assets/me.svg'];
    let index = 0;
    function next() {
      if (index >= candidates.length) return;
      const url = candidates[index++];
      const probe = new Image();
      probe.onload = () => root.style.setProperty('--scene-photo', `url('${url}')`);
      probe.onerror = next;
      probe.src = url;
    }
    next();
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
      if (saved) {
        if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) state.anchor = { x: saved.x, y: saved.y };
        if (Number.isFinite(saved.cardScale)) state.cardScale = clamp(saved.cardScale, 0.5, 1.6);
        if (Number.isFinite(saved.radiusScale)) state.radiusScale = clamp(saved.radiusScale, 0.5, 2);
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
      const rect = els.scene.getBoundingClientRect();
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
    if (rgb) root.style.setProperty('--tint-rgb', rgb);
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

  function buildCard(track, index) {
    const card = el('div', 'card');
    card.style.setProperty('--i', index);
    card.style.setProperty('--tilt-z', `${hashString(track.track) % 7 - 3}deg`);
    card.style.setProperty('--tilt-x', `${hashString(track.artist) % 9 - 4}deg`);
    card.style.setProperty('--focus', '1');

    const scaler = el('div', 'card__scaler');
    const surface = el('div', 'card__surface');
    surface.append(el('div', 'card__glass'), el('div', 'card__tint'), el('div', 'card__gloss'));

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
        cover.replaceChildren(makeGradientCover(label), el('div', 'cover__shade'));
        applyTint(card, tintFromTitle(label));
      };
      image.src = `/api/cover?u=${encodeURIComponent(track.image)}`;
      cover.appendChild(image);
    } else {
      cover.appendChild(makeGradientCover(label));
      applyTint(card, tintFromTitle(label));
    }
    cover.appendChild(el('div', 'cover__shade'));
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

    // --- relative time / live pulse ---
    const time = el('div', track.nowPlaying ? 'card__time card__time--live' : 'card__time');
    if (track.nowPlaying) {
      const dot = el('i', 'live-dot');
      dot.setAttribute('aria-hidden', 'true');
      time.append(dot, document.createTextNode('Now playing'));
    } else {
      time.textContent = relativeTime(track.playedAt);
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
      fill, knob, elapsed, remaining, time, tintRgb: null,
      duration: durationFor(track), playedAt: track.playedAt, nowPlaying: track.nowPlaying
    };
    return card;
  }

  function renderLoading() {
    const card = el('div', 'card is-skeleton');
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
      card.classList.remove('is-entering');
    });
  }

  function renderTracks(tracks, previousFirst) {
    const wasWheel = state.mode === 'wheel';
    const previousKey = wasWheel && state.tracks.length
      ? trackKey(state.tracks[state.frontIndex]) : null;

    state.tracks = tracks;
    els.deck.replaceChildren(...tracks.map(buildCard));
    state.step = tracks.length > 1 ? 360 / tracks.length : 0;
    computeRadius();

    let index = 0;
    if (previousKey) {
      const found = tracks.findIndex((item) => trackKey(item) === previousKey);
      if (found >= 0) index = found;
    }
    state.rotation = index * state.step;
    state.velocity = 0;
    state.target = state.rotation;
    state.snapAt = 0;

    // A newly scrobbled track slides in at the front.
    if (previousFirst && trackKey(tracks[0]) !== previousFirst && !wasWheel) {
      els.deck.firstElementChild.classList.add('is-new');
    }

    if (wasWheel) { state.target = null; applyWheel(); }
    else {
      clearCardStyles();
      els.counter.textContent = `1 / ${tracks.length}`;
      updateSceneTint();
    }
  }

  /* ---------------------------------------------------------------- *
   * The virtualised 3D wheel
   * ---------------------------------------------------------------- */
  function computeRadius() {
    const width = (els.deck.offsetWidth || 300) * state.cardScale;
    const count = state.tracks.length;
    // Neighbouring posters sit about one card-width apart.
    state.radius = count > 1
      ? (width * 1.06) / (2 * Math.sin(Math.PI / count)) * state.radiusScale
      : width * 0.6 * state.radiusScale;
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
      only.style.setProperty('--focus', '1');
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
        continue;
      }
      const angle = (delta - offset) * state.step;
      const ratio = Math.min(1, distance / (half + 0.5));
      card.style.visibility = 'visible';
      card.style.transform = `rotateY(${angle.toFixed(2)}deg) translateZ(${state.radius}px)`;
      card.style.opacity = distance > half + 0.4 ? '0' : (1 - ratio * 0.42).toFixed(3);
      card.style.filter = `blur(${(ratio * 2.4).toFixed(2)}px) brightness(${(1 - ratio * 0.34).toFixed(2)})`;
      card.style.setProperty('--focus', (1 - ratio).toFixed(2));
      card.style.zIndex = String(100 - Math.round(distance * 2));
    }
    els.counter.textContent = `${state.frontIndex + 1} / ${count}`;
    updateSceneTint();
  }

  function snapToNearest() {
    if (!state.step) { state.target = 0; return; }
    state.target = Math.round(state.rotation / state.step) * state.step;
    state.velocity = 0;
  }

  function stepTo(index) {
    if (state.mode !== 'wheel') openWheel();
    if (!state.step) { state.target = 0; return; }
    let target = index * state.step;
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
    state.rotation = 0;
    state.target = 0;
    state.velocity = 0;
    state.snapAt = 0;
    Array.from(els.deck.children).forEach((card, index) => {
      if (index > 0) card.classList.add('is-entering');
    });
    window.setTimeout(() => {
      Array.from(els.deck.children).forEach((card) => card.classList.remove('is-entering'));
    }, 900);
    startLoop();
  }

  function closeWheel() {
    if (state.mode !== 'wheel') return;
    state.mode = 'phone';
    document.body.classList.remove('is-wheel');
    els.backButton.hidden = true;
    stopLoop();
    state.rotation = 0;
    state.velocity = 0;
    state.target = null;
    state.snapAt = 0;
    clearCardStyles();
    if (state.tracks.length) els.counter.textContent = `1 / ${state.tracks.length}`;
  }

  function frontCard() {
    const cards = els.deck.children;
    if (!cards.length) return null;
    return cards[state.mode === 'wheel' ? state.frontIndex : 0];
  }

  function togglePlayAnimation() {
    state.paused = !state.paused;
    const card = frontCard();
    const button = card && card.querySelector('.control--play');
    if (button) button.innerHTML = state.paused ? ICONS.play : ICONS.pause;
  }

  /* ---------------------------------------------------------------- *
   * Input: wheel, touch swipe, mouse drag, keyboard
   * ---------------------------------------------------------------- */
  function moveGloss(clientX) {
    const shift = (clientX / window.innerWidth - 0.5) * 46;
    root.style.setProperty('--gloss-shift', `${shift.toFixed(1)}px`);
  }

  function bindInput() {
    let wheelCooldown = 0;
    els.stage.addEventListener('wheel', (event) => {
      if (!state.tracks.length) return;
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
      moveGloss(event.clientX);
    }, { passive: false });

    els.stage.addEventListener('pointerdown', (event) => {
      moveGloss(event.clientX);
      if (!state.tracks.length || event.target.closest('.control')) return;
      if (event.button !== undefined && event.button !== 0) return;
      state.dragging = true;
      state.moved = false;
      state.dragStartX = event.clientX;
      state.lastX = event.clientX;
      state.lastT = performance.now();
      state.target = null;
    });

    els.stage.addEventListener('pointermove', (event) => {
      moveGloss(event.clientX);
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

    function endDrag() {
      if (!state.dragging) return;
      state.dragging = false;
      if (state.mode === 'wheel') state.snapAt = performance.now() + 120;
      else if (state.moved) openWheel();
      if (reduceMotion) { state.velocity = 0; snapToNearest(); }
    }
    els.stage.addEventListener('pointerup', endDrag);
    els.stage.addEventListener('pointercancel', endDrag);

    els.deck.addEventListener('click', (event) => {
      if (event.target.closest('.control')) return;
      if (state.moved) return;
      if (state.mode !== 'wheel') { openWheel(); return; }
      const card = event.target.closest('.card');
      if (card) stepTo(Array.prototype.indexOf.call(els.deck.children, card));
    });

    window.addEventListener('keydown', (event) => {
      if (!state.tracks.length) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault(); stepTo(state.frontIndex + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault(); stepTo(state.frontIndex - 1);
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
      if (state.tracks.length) { computeRadius(); applyWheel(); }
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
          'Play something in Apple Music with a scrobbler app connected to Last.fm, and it will appear here as a giant player card.');
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
    if (parts.nowPlaying) {
      seconds = ((Date.now() - state.nowPlayingStart) / 1000) % parts.duration; // live animation
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
