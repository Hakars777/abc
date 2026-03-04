'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIO_DIR = process.env.AUDIO_DIR
  ? path.resolve(process.env.AUDIO_DIR)
  : path.join(__dirname, 'audio');

const SUPPORTED_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus']);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function safeRelFromAudio(absPath) {
  const rel = path.relative(AUDIO_DIR, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

async function walkAudioDir(dirAbs, out) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
  } catch (e) {
    return;
  }

  for (const ent of entries) {
    const abs = path.join(dirAbs, ent.name);
    if (ent.isDirectory()) {
      await walkAudioDir(abs, out);
      continue;
    }
    if (!ent.isFile()) continue;

    const ext = path.extname(ent.name).toLowerCase();
    if (!SUPPORTED_EXT.has(ext)) continue;

    const rel = safeRelFromAudio(abs);
    if (!rel) continue;

    let st;
    try {
      st = await fs.promises.stat(abs);
    } catch (e) {
      continue;
    }

    const relPosix = toPosix(rel);
    const base = path.basename(rel);
    out.push({
      id: Buffer.from(relPosix, 'utf8').toString('base64url'),
      relPath: relPosix,
      name: base,
      size: st.size,
      mtimeMs: st.mtimeMs,
      url: `/audio/${encodeURIComponent(relPosix).replace(/%2F/g, '/')}`
    });
  }
}

app.get('/api/tracks', async (req, res) => {
  const list = [];
  await walkAudioDir(AUDIO_DIR, list);

  list.sort((a, b) => {
    const an = a.relPath.toLowerCase();
    const bn = b.relPath.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });

  res.json({ ok: true, audioDirExists: fs.existsSync(AUDIO_DIR), tracks: list });
});

app.use('/audio', express.static(AUDIO_DIR, {
  fallthrough: false,
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

app.use('/', express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

app.use((err, req, res, next) => {
  res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
});

module.exports = app;
