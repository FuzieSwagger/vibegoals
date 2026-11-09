/* ==========================================================================
   VibeGoals — крошечный сервер без зависимостей.
   Раздаёт статику из этой папки и хранит общее состояние.

   Хранилище:
   - по умолчанию — data/state.json рядом с сервером;
   - если заданы UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN,
     состояние живёт в Upstash Redis (нужно на Render: там диск эфемерный).

   Запуск:  node server.js
   Порт:    PORT=8787 (по умолчанию)
   ========================================================================== */

'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 1024 * 1024; // 1 МБ

// Внешнее хранилище (Upstash Redis REST). Необязательно.
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const STATE_KEY = process.env.STATE_KEY || 'vibegoals:state';
const REMOTE = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const CACHE_TTL = REMOTE ? 10000 : 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const EMPTY_STATE = {
  version: 1,
  startDate: '2026-11-01',
  people: [],
  goals: [],
  entries: [],
  deleted: [],
  updatedAt: 0,
};

/* --------------------------------------------------------------------------
   Состояние
   -------------------------------------------------------------------------- */

let stateCache = null;
let cacheAt = 0;
let writeChain = Promise.resolve();
let postChain = Promise.resolve();

/** Выполнить команду Upstash Redis через REST API. */
async function redisCommand(command) {
  const response = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
  const data = await response.json();
  if (data && data.error) throw new Error(`Upstash: ${data.error}`);
  return data ? data.result : null;
}

async function readRemoteState() {
  const raw = await redisCommand(['GET', STATE_KEY]);
  if (!raw) return null;
  return sanitize(JSON.parse(raw));
}

async function writeRemoteState(next) {
  await redisCommand(['SET', STATE_KEY, JSON.stringify(next)]);
}

/** Сериализует изменения, чтобы два одновременных POST не затёрли друг друга. */
function serializePost(task) {
  const run = postChain.then(task, task);
  postChain = run.catch(() => {});
  return run;
}

async function readState() {
  if (stateCache && (!REMOTE || Date.now() - cacheAt < CACHE_TTL)) {
    return stateCache;
  }

  if (REMOTE) {
    // Если Upstash недоступен — не подменяем данные пустым состоянием.
    stateCache = (await readRemoteState()) || { ...EMPTY_STATE };
  } else {
    try {
      const raw = await fs.readFile(STATE_FILE, 'utf8');
      stateCache = sanitize(JSON.parse(raw));
    } catch {
      stateCache = { ...EMPTY_STATE };
    }
  }

  cacheAt = Date.now();
  return stateCache;
}

function sanitize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const deleted = Array.isArray(source.deleted)
    ? [...new Set(source.deleted.filter((id) => typeof id === 'string'))]
    : [];
  const gone = new Set(deleted);

  const entries = (Array.isArray(source.entries) ? source.entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => typeof entry.id === 'string' && entry.id && !gone.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      personId: typeof entry.personId === 'string' ? entry.personId : '',
      amount: Math.max(0, Number(entry.amount) || 0),
      date: typeof entry.date === 'string' ? entry.date.slice(0, 10) : '',
      source: String(entry.source || '').slice(0, 60),
      note: String(entry.note || '').slice(0, 120),
    }))
    .filter((entry) => entry.amount > 0);

  return {
    version: 1,
    startDate: typeof source.startDate === 'string' ? source.startDate : EMPTY_STATE.startDate,
    people: Array.isArray(source.people) ? source.people.slice(0, 2) : [],
    goals: Array.isArray(source.goals) ? source.goals.slice(0, 2) : [],
    entries,
    deleted,
    updatedAt: Number(source.updatedAt) || 0,
  };
}

/**
 * Та же логика, что mergeStates() в app.js:
 * записи объединяются по id (a важнее b), надгробия — объединение,
 * метаданные берутся из состояния с более свежим updatedAt.
 */
function mergeStates(a, b) {
  const map = new Map();
  for (const entry of [...(b.entries || []), ...(a.entries || [])]) {
    map.set(entry.id, entry);
  }
  const deleted = new Set([...(b.deleted || []), ...(a.deleted || [])]);
  const newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;

  return sanitize({
    ...newer,
    entries: [...map.values()].filter((entry) => !deleted.has(entry.id)),
    deleted: [...deleted],
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
  });
}

async function writeState(next) {
  stateCache = next;
  cacheAt = Date.now();

  const task = writeChain
    .catch(() => {}) // предыдущая ошибка не должна блокировать следующие записи
    .then(async () => {
      if (REMOTE) {
        await writeRemoteState(next);
        return;
      }

      const payload = JSON.stringify(next, null, 2);
      // Запись через временный файл + rename, чтобы не оставить полуфайл.
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, STATE_FILE);
    });

  writeChain = task.catch(() => {});
  return task;
}

/* --------------------------------------------------------------------------
   HTTP
   -------------------------------------------------------------------------- */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  cors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  cors(res);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });

    req.on('error', reject);
  });
}

async function handleApi(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    const current = await readState();
    sendJson(res, 200, current);
    return;
  }

  if (req.method === 'POST') {
    const incoming = sanitize(await readBody(req));
    const merged = await serializePost(async () => {
      const stored = await readState();
      const next = mergeStates(incoming, stored);
      await writeState(next);
      return next;
    });
    sendJson(res, 200, merged);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }

  if (decoded === '/' || decoded === '') decoded = '/index.html';

  // Никаких data/, dotfiles и выхода за пределы папки.
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.') || segment === 'data')) {
    sendText(res, 404, 'Not found');
    return;
  }

  const filePath = path.join(ROOT, ...segments);
  const relative = path.relative(ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      sendText(res, 404, 'Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const data = await fs.readFile(filePath);
    const noStore = ['.html', '.css', '.js', '.mjs', '.json'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': noStore ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/state') {
      await handleApi(req, res);
      return;
    }
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, storage: REMOTE ? 'upstash' : 'file' });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Unknown endpoint' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    if (status >= 500) console.error(error);
    if (!res.headersSent) sendJson(res, status, { error: error.message || 'Server error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`VibeGoals: http://localhost:${PORT}`);
  console.log(
    REMOTE
      ? `Данные:    Upstash Redis (${STATE_KEY})`
      : `Данные:    ${path.relative(process.cwd(), STATE_FILE)}`,
  );
});
