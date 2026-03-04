'use strict';

const $ = (sel) => document.querySelector(sel);

const listEl = $('#list');
const searchInput = $('#searchInput');
const hintEl = $('#hint');
const countLabel = $('#countLabel');

const nowTitle = $('#nowTitle');
const nowPath = $('#nowPath');

const prevBtn = $('#prevBtn');
const playBtn = $('#playBtn');
const nextBtn = $('#nextBtn');

const vol = $('#vol');
const rate = $('#rate');
const rateVal = $('#rateVal');

const timeCur = $('#timeCur');
const timeDur = $('#timeDur');

const rescanBtn = $('#rescanBtn');
const unlockEl = $('#unlock');

let tracks = [];
let filtered = [];
let activeIndex = -1;

let audioCtx = null;
let audioCtxUnlocked = false;
let previewQueue = [];
let previewRunning = false;

let wavesurfer = null;
let isWavesurferReady = false;
let uiPlaying = false;

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function cacheKeyFor(t) {
  // ключ привязан к relPath+size+mtime, чтобы кеш сам инвалидировался при замене файла
  return `peaks:v1:${t.relPath}|${t.size}|${Math.floor(t.mtimeMs)}`;
}

function loadCache(t) {
  try {
    const raw = localStorage.getItem(cacheKeyFor(t));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== 1) return null;
    if (!Array.isArray(obj.peaks) || typeof obj.duration !== 'number') return null;
    return obj;
  } catch {
    return null;
  }
}

function saveCache(t, obj) {
  try {
    localStorage.setItem(cacheKeyFor(t), JSON.stringify(obj));
  } catch {
    // игнорируем (переполнен localStorage)
  }
}

function ensureAudioContext() {
  if (audioCtx) return true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    audioCtx = null;
    return false;
  }
  return true;
}

async function unlockAudioContextIfNeeded() {
  if (!ensureAudioContext()) return false;
  if (audioCtxUnlocked) return true;

  if (audioCtx.state === 'running') {
    audioCtxUnlocked = true;
    unlockEl.classList.add('hidden');
    return true;
  }

  unlockEl.classList.remove('hidden');

  const handler = async () => {
    try {
      await audioCtx.resume();
    } catch {}
    if (audioCtx.state === 'running') {
      audioCtxUnlocked = true;
      unlockEl.classList.add('hidden');
      document.removeEventListener('pointerdown', handler, { capture: true });
      startPreviewQueue();
    }
  };

  document.addEventListener('pointerdown', handler, { capture: true, once: false });
  return false;
}

function computePeaksFromAudioBuffer(buf, points) {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const len = buf.length;

  const peaks = new Array(points).fill(0);
  const step = Math.max(1, Math.floor(len / points));

  for (let i = 0; i < points; i++) {
    const start = i * step;
    const end = Math.min(len, start + step);
    let max = 0;

    for (let s = start; s < end; s++) {
      const a0 = Math.abs(ch0[s] || 0);
      const a1 = ch1 ? Math.abs(ch1[s] || 0) : 0;
      const a = a0 > a1 ? a0 : a1;
      if (a > max) max = a;
    }

    peaks[i] = max;
  }

  // нормализация 0..1
  let pmax = 0;
  for (const p of peaks) if (p > pmax) pmax = p;
  if (pmax > 0) {
    for (let i = 0; i < peaks.length; i++) peaks[i] = peaks[i] / pmax;
  }

  return peaks;
}

function drawPreview(canvas, peaks) {
  const ctx = canvas.getContext('2d');

  // HiDPI
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const pxW = Math.max(1, Math.floor(cssW * dpr));
  const pxH = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }

  ctx.clearRect(0, 0, pxW, pxH);

  const n = peaks.length;
  if (n === 0) return;

  const denom = Math.max(1, n - 1);
  const mid = pxH / 2;
  const ampScale = pxH * 0.45;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Filled waveform (like classic Soundsnap-style previews)
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / denom) * pxW;
    const y = mid - (peaks[i] * ampScale);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = n - 1; i >= 0; i--) {
    const x = (i / denom) * pxW;
    const y = mid + (peaks[i] * ampScale);
    ctx.lineTo(x, y);
  }
  ctx.closePath();

  ctx.fillStyle = 'rgba(233, 236, 241, 0.60)';
  ctx.fill();

  // subtle center line
  ctx.fillStyle = 'rgba(35, 39, 56, 0.7)';
  ctx.fillRect(0, Math.floor(mid), pxW, 1);
}

function drawPreviewWhenSized(canvas, peaks, triesLeft = 3) {
  if (!canvas) return;
  if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
    drawPreview(canvas, peaks);
    return;
  }
  if (triesLeft <= 0) return;
  requestAnimationFrame(() => drawPreviewWhenSized(canvas, peaks, triesLeft - 1));
}

function setHint(text) {
  hintEl.textContent = text || '';
}

function setCountLabel() {
  countLabel.textContent = `${filtered.length} / ${tracks.length}`;
}

function makeItem(t, idx) {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.id = t.id;

  const btn = document.createElement('button');
  btn.className = 'iconBtn';
  btn.textContent = '▶';
  btn.title = 'Play';

  const meta = document.createElement('div');
  meta.className = 'meta';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = t.name;

  const pth = document.createElement('div');
  pth.className = 'path';
  pth.textContent = t.relPath;

  const smallrow = document.createElement('div');
  smallrow.className = 'smallrow';

  const durBadge = document.createElement('div');
  durBadge.className = 'badge';
  durBadge.textContent = '—';

  const statBadge = document.createElement('div');
  statBadge.className = 'badge';
  statBadge.textContent = 'wave…';

  smallrow.appendChild(durBadge);
  smallrow.appendChild(statBadge);

  meta.appendChild(name);
  meta.appendChild(pth);
  meta.appendChild(smallrow);

  const canvas = document.createElement('canvas');
  canvas.className = 'preview';

  el.appendChild(btn);
  el.appendChild(meta);
  el.appendChild(canvas);

  // пробуем кеш сразу
  const cached = loadCache(t);
  if (cached) {
    durBadge.textContent = fmtTime(cached.duration);
    statBadge.textContent = 'cached';
    t._cached = cached;
  } else {
    durBadge.textContent = '—';
    statBadge.textContent = 'queue';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectByFilteredIndex(idx);
    togglePlay();
  });

  el.addEventListener('click', () => {
    selectByFilteredIndex(idx);
  });

  t._ui = { el, btn, durBadge, statBadge, canvas };
  return el;
}

function renderList() {
  listEl.innerHTML = '';
  filtered.forEach((t, idx) => {
    const item = makeItem(t, idx);
    listEl.appendChild(item);
  });
  setCountLabel();
  updateActiveUI();

  // Draw cached previews after canvases get real layout sizes.
  requestAnimationFrame(() => {
    let need2 = false;
    for (const t of filtered) {
      if (!t._ui || !t._cached || !Array.isArray(t._cached.peaks)) continue;
      const canvas = t._ui.canvas;
      if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
        need2 = true;
        continue;
      }
      drawPreview(canvas, t._cached.peaks);
    }
    if (need2) {
      requestAnimationFrame(() => {
        for (const t of filtered) {
          if (!t._ui || !t._cached || !Array.isArray(t._cached.peaks)) continue;
          drawPreviewWhenSized(t._ui.canvas, t._cached.peaks);
        }
      });
    }
  });

  queuePreviewsForVisible();
}

function applySearch() {
  const q = (searchInput.value || '').trim().toLowerCase();
  if (!q) {
    filtered = [...tracks];
    setHint('');
  } else {
    filtered = tracks.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.relPath.toLowerCase().includes(q)
    );
    setHint(`Фильтр: "${q}"`);
  }

  renderList();
}

function updateActiveUI() {
  const activeId = activeIndex >= 0 ? tracks[activeIndex].id : null;

  // подсветка
  for (const t of filtered) {
    if (!t._ui) continue;
    const isActive = activeId && t.id === activeId;
    t._ui.el.classList.toggle('active', !!isActive);
  }

  // кнопки play в списке
  for (const t of filtered) {
    if (!t._ui) continue;
    const isActive = activeId && t.id === activeId;
    t._ui.btn.classList.toggle('playing', !!(isActive && uiPlaying));
    t._ui.btn.textContent = (isActive && uiPlaying) ? '❚❚' : '▶';
  }

  // инфо сверху
  if (activeIndex < 0) {
    nowTitle.textContent = 'Ничего не выбрано';
    nowPath.textContent = '';
  } else {
    const t = tracks[activeIndex];
    nowTitle.textContent = t.name;
    nowPath.textContent = t.relPath;
  }
}

function findTrackIndexById(id) {
  return tracks.findIndex(t => t.id === id);
}

function selectByFilteredIndex(filteredIdx) {
  if (filteredIdx < 0 || filteredIdx >= filtered.length) return;
  const id = filtered[filteredIdx].id;
  const idx = findTrackIndexById(id);
  if (idx < 0) return;

  if (activeIndex === idx) {
    updateActiveUI();
    return;
  }

  activeIndex = idx;
  updateActiveUI();
  loadActiveIntoPlayer();
}

function selectRelative(delta) {
  if (tracks.length === 0) return;
  if (activeIndex < 0) activeIndex = 0;
  else {
    let n = activeIndex + delta;
    if (n < 0) n = tracks.length - 1;
    if (n >= tracks.length) n = 0;
    activeIndex = n;
  }
  updateActiveUI();
  loadActiveIntoPlayer();
}

function initWavesurfer() {
  if (wavesurfer) return;

  wavesurfer = WaveSurfer.create({
    container: '#mainWave',
    height: 180,
    normalize: true,
    interact: true,
    cursorWidth: 1,
    cursorColor: 'rgba(233, 236, 241, 0.5)',
    waveColor: 'rgba(233, 236, 241, 0.25)',
    progressColor: 'rgba(233, 236, 241, 0.85)',
    mediaControls: false
  });

  wavesurfer.on('ready', () => {
    isWavesurferReady = true;
    const d = wavesurfer.getDuration();
    timeDur.textContent = fmtTime(d);
  });

  wavesurfer.on('audioprocess', () => {
    const cur = wavesurfer.getCurrentTime();
    timeCur.textContent = fmtTime(cur);
  });

  wavesurfer.on('timeupdate', () => {
    const cur = wavesurfer.getCurrentTime();
    timeCur.textContent = fmtTime(cur);
  });

  wavesurfer.on('play', () => {
    uiPlaying = true;
    playBtn.textContent = 'Pause';
    updateActiveUI();
  });

  wavesurfer.on('pause', () => {
    uiPlaying = false;
    playBtn.textContent = 'Play';
    updateActiveUI();
  });

  wavesurfer.on('finish', () => {
    uiPlaying = false;
    playBtn.textContent = 'Play';
    updateActiveUI();
  });

  wavesurfer.on('error', (e) => {
    console.error('WaveSurfer error:', e);
  });

  // начальные параметры
  wavesurfer.setVolume(Number(vol.value));
  wavesurfer.setPlaybackRate(Number(rate.value));
}

function getCachedForTrack(t) {
  if (t._cached) return t._cached;
  const c = loadCache(t);
  if (c) t._cached = c;
  return c;
}

function loadActiveIntoPlayer() {
  if (activeIndex < 0) return;
  initWavesurfer();

  const t = tracks[activeIndex];
  isWavesurferReady = false;

  const cached = getCachedForTrack(t);
  if (cached && cached.peaks && typeof cached.duration === 'number') {
    wavesurfer.load(t.url, cached.peaks, cached.duration);
    timeDur.textContent = fmtTime(cached.duration);
  } else {
    wavesurfer.load(t.url);
    timeDur.textContent = '0:00';
  }

  timeCur.textContent = '0:00';
  uiPlaying = false;
  playBtn.textContent = 'Play';
  updateActiveUI();

  // чтобы preview-очередь точно работала, пытаемся разблокировать контекст
  unlockAudioContextIfNeeded();
}

function togglePlay() {
  if (!wavesurfer) {
    if (activeIndex < 0 && tracks.length > 0) activeIndex = 0;
    if (activeIndex < 0) return;
    loadActiveIntoPlayer();
  }

  unlockAudioContextIfNeeded();

  if (!wavesurfer) return;
  wavesurfer.playPause();
}

function queuePreviewsForVisible() {
  // добавляем в очередь только те, что без кеша
  for (const t of filtered) {
    if (!t._ui) continue;
    const cached = getCachedForTrack(t);
    if (cached) continue;
    if (t._queued) continue;
    t._queued = true;
    previewQueue.push(t);
  }

  startPreviewQueue();
}

function startPreviewQueue() {
  if (previewRunning) return;
  if (!ensureAudioContext()) return;

  // если браузер не дал AudioContext без жеста — ждём
  if (!audioCtxUnlocked && audioCtx.state !== 'running') {
    unlockAudioContextIfNeeded();
    return;
  }

  previewRunning = true;

  const step = async () => {
    if (previewQueue.length === 0) {
      previewRunning = false;
      return;
    }

    const t = previewQueue.shift();
    if (!t) {
      previewRunning = false;
      return;
    }

    if (getCachedForTrack(t)) {
      if (t._ui) {
        t._ui.statBadge.textContent = 'cached';
        requestAnimationFrame(() => {
          if (t._ui && t._ui.canvas && t._cached) {
            drawPreviewWhenSized(t._ui.canvas, t._cached.peaks);
          }
        });
      }
      schedule(step);
      return;
    }

    if (t._ui) {
      t._ui.statBadge.textContent = 'wave…';
    }

    try {
      const resp = await fetch(t.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arr = await resp.arrayBuffer();

      const buf = await audioCtx.decodeAudioData(arr.slice(0));
      const points = 220;
      const peaks = computePeaksFromAudioBuffer(buf, points);
      const duration = buf.duration;

      const obj = { v: 1, points, duration, peaks };
      saveCache(t, obj);
      t._cached = obj;

      if (t._ui) {
        t._ui.durBadge.textContent = fmtTime(duration);
        t._ui.statBadge.textContent = 'ok';
        requestAnimationFrame(() => drawPreviewWhenSized(t._ui.canvas, peaks));
      }
    } catch (e) {
      if (t._ui) {
        t._ui.statBadge.textContent = 'err';
        t._ui.statBadge.classList.add('err');
      }
      console.warn('preview fail:', t.relPath, e);
    }

    schedule(step);
  };

  schedule(step);
}

function schedule(fn) {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(() => fn(), { timeout: 350 });
  } else {
    setTimeout(() => fn(), 30);
  }
}

async function fetchTracks() {
  listEl.innerHTML = '';
  setHint('Загрузка списка...');
  countLabel.textContent = '...';

  const r = await fetch('/api/tracks');
  const j = await r.json();
  if (!j.ok) {
    setHint('Ошибка /api/tracks');
    return;
  }

  tracks = j.tracks || [];
  filtered = [...tracks];

  if (!j.audioDirExists) {
    setHint('Папка ./audio не найдена. Создай папку "audio" рядом с server.js и положи туда файлы.');
  } else {
    setHint('');
  }

  // сброс UI ссылок
  for (const t of tracks) {
    t._ui = null;
    t._cached = null;
    t._queued = false;
  }

  renderList();

  // если уже есть активный — перезагрузить его
  if (activeIndex >= 0 && activeIndex < tracks.length) {
    updateActiveUI();
  } else {
    activeIndex = tracks.length > 0 ? 0 : -1;
    updateActiveUI();
  }

  if (activeIndex >= 0) {
    loadActiveIntoPlayer();
  }
}

searchInput.addEventListener('input', () => applySearch());

rescanBtn.addEventListener('click', async () => {
  // при обновлении списка активный трек по возможности сохранить по id
  const activeId = activeIndex >= 0 ? tracks[activeIndex].id : null;
  await fetchTracks();
  if (activeId) {
    const idx = findTrackIndexById(activeId);
    if (idx >= 0) {
      activeIndex = idx;
      updateActiveUI();
      loadActiveIntoPlayer();
    }
  }
});

prevBtn.addEventListener('click', () => selectRelative(-1));
nextBtn.addEventListener('click', () => selectRelative(1));
playBtn.addEventListener('click', () => togglePlay());

vol.addEventListener('input', () => {
  const v = Number(vol.value);
  if (wavesurfer) wavesurfer.setVolume(v);
});

rate.addEventListener('input', () => {
  const r = Number(rate.value);
  rateVal.textContent = `${r.toFixed(2)}×`;
  if (wavesurfer) wavesurfer.setPlaybackRate(r);
});

document.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    selectRelative(-1);
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    selectRelative(1);
  }
});

window.addEventListener('pointerdown', () => {
  // мягкая попытка разлочить AudioContext на первом клике
  unlockAudioContextIfNeeded();
}, { once: true });

(async () => {
  rateVal.textContent = `${Number(rate.value).toFixed(2)}×`;
  await fetchTracks();
})();



