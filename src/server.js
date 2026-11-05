'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const { promisify } = require('util');
const { URL } = require('url');

const execFileAsync = promisify(execFile);

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

function pickRoot() {
  const raw = process.env.PATCHES_ROOT;
  if (!raw || !String(raw).trim()) {
    throw new Error('PATCHES_ROOT must be set in .env');
  }
  return path.resolve(String(raw).trim());
}

const ROOT = pickRoot();
const DU_TIMEOUT_MS = Number(process.env.DU_TIMEOUT_MS) || 3_600_000;
const GLOBAL_STATS_TTL_MS = Number(process.env.GLOBAL_STATS_TTL_MS) || 300_000;

function insideRoot(resolved) {
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  return resolved === ROOT || resolved.startsWith(rootWithSep);
}

function decodeRel(raw) {
  if (raw == null || raw === '' || raw === '/') return '';
  const rel = String(raw).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return '';
  const segments = rel.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    const error = new Error('Invalid path');
    error.status = 400;
    throw error;
  }
  return segments.join('/');
}

async function resolveInside(rel) {
  const target = path.resolve(ROOT, rel);
  if (!insideRoot(target)) {
    const error = new Error('Invalid path');
    error.status = 400;
    throw error;
  }
  let real;
  try {
    real = await fsp.realpath(target);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const error = new Error('Not found');
      error.status = 404;
      throw error;
    }
    throw err;
  }
  const rootReal = await fsp.realpath(ROOT);
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (real !== rootReal && !real.startsWith(rootWithSep)) {
    const error = new Error('Invalid path');
    error.status = 400;
    throw error;
  }
  return { target, real };
}

function parseDuLine(line) {
  const tab = line.indexOf('\t');
  if (tab === -1) return null;
  const bytes = Number(line.slice(0, tab));
  if (!Number.isFinite(bytes)) return null;
  return { bytes, dirPath: line.slice(tab + 1) };
}

async function duSubtreeBytes(dirReal) {
  const { stdout } = await execFileAsync('du', ['-sb', dirReal], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: DU_TIMEOUT_MS
  });
  const parsed = parseDuLine(stdout.trim().split('\n')[0] || '');
  return parsed ? parsed.bytes : 0;
}

async function duImmediateChildBytes(dirReal) {
  const { stdout } = await execFileAsync(
    'du',
    ['-b', '--max-depth=1', '-x', dirReal],
    { maxBuffer: 64 * 1024 * 1024, timeout: DU_TIMEOUT_MS }
  );
  const children = new Map();
  let selfBytes = null;
  const dirNorm = path.resolve(dirReal);
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const parsed = parseDuLine(line);
    if (!parsed) continue;
    if (path.resolve(parsed.dirPath) === dirNorm) {
      selfBytes = parsed.bytes;
      continue;
    }
    children.set(path.basename(parsed.dirPath), parsed.bytes);
  }
  return { selfBytes, children };
}

let globalStatsCache = { at: 0, totalBytes: null, totalFiles: null };

function noteGlobalBytes(totalBytes) {
  if (totalBytes == null) return;
  globalStatsCache = { at: Date.now(), totalBytes, totalFiles: null };
}

async function globalPatchStats() {
  const now = Date.now();
  if (
    globalStatsCache.at &&
    now - globalStatsCache.at < GLOBAL_STATS_TTL_MS &&
    globalStatsCache.totalBytes != null
  ) {
    return {
      totalBytes: globalStatsCache.totalBytes,
      totalFiles: globalStatsCache.totalFiles
    };
  }
  const rootReal = await fsp.realpath(ROOT);
  const totalBytes = await duSubtreeBytes(rootReal);
  noteGlobalBytes(totalBytes);
  return { totalBytes, totalFiles: null };
}

async function listDirectory(rel, options) {
  const skipDu = options && options.skipDu;
  const { target, real } = await resolveInside(rel);
  const stat = await fsp.stat(target);
  if (!stat.isDirectory()) {
    const error = new Error('Not a directory');
    error.status = 400;
    throw error;
  }
  const names = await fsp.readdir(target);
  const entries = [];
  for (const name of names) {
    const childRel = rel ? rel + '/' + name : name;
    let childStat;
    try {
      childStat = await fsp.stat(path.join(target, name));
    } catch (err) {
      continue;
    }
    const type = childStat.isDirectory() ? 'dir' : childStat.isFile() ? 'file' : 'other';
    if (type === 'other') continue;
    entries.push({
      name,
      path: childRel,
      type,
      size: type === 'file' ? childStat.size : null,
      subtreeSize: null,
      mtime: childStat.mtime.toISOString()
    });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  if (skipDu) {
    return {
      path: rel,
      entries,
      patchStats: {
        totalBytes: globalStatsCache.totalBytes,
        totalFiles: null,
        currentSubtreeBytes: null
      }
    };
  }

  let selfBytes = null;
  let childSizes = new Map();
  try {
    const du = await duImmediateChildBytes(real);
    selfBytes = du.selfBytes;
    childSizes = du.children;
  } catch (err) {
    console.error('du failed for ' + real + ':', err.message);
  }

  if (rel === '' && selfBytes != null) noteGlobalBytes(selfBytes);

  for (const entry of entries) {
    if (entry.type !== 'dir') continue;
    if (childSizes.has(entry.name)) entry.subtreeSize = childSizes.get(entry.name);
  }

  const globalMeasured = await globalPatchStats();

  return {
    path: rel,
    entries,
    patchStats: {
      totalBytes: globalMeasured.totalBytes,
      totalFiles: globalMeasured.totalFiles,
      currentSubtreeBytes: selfBytes
    }
  };
}

async function catalog() {
  const rootReal = await fsp.realpath(ROOT);
  const seen = new Set();
  const directories = [];
  let totalFiles = 0;

  async function walk(dir, rel) {
    let real;
    try {
      real = await fsp.realpath(dir);
    } catch (err) {
      return 0;
    }
    const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (real !== rootReal && !real.startsWith(rootWithSep)) return 0;
    if (seen.has(real)) return 0;
    seen.add(real);

    let names;
    try {
      names = await fsp.readdir(real);
    } catch (err) {
      return 0;
    }
    const files = [];
    const subdirs = [];
    let subtreeBytes = 0;
    for (const name of names) {
      const full = path.join(real, name);
      const childRel = rel ? rel + '/' + name : name;
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch (err) {
        continue;
      }
      if (stat.isDirectory()) subdirs.push({ name, full, childRel });
      else if (stat.isFile()) {
        files.push({ name, size: stat.size, mtime: stat.mtime.toISOString() });
        subtreeBytes += stat.size;
        totalFiles += 1;
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    subdirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const sub of subdirs) subtreeBytes += await walk(sub.full, sub.childRel);
    directories.push({ path: rel, files, subtreeBytes });
    return subtreeBytes;
  }

  const totalBytes = await walk(ROOT, '');
  directories.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  return { root: ROOT, patchStats: { totalBytes, totalFiles }, directories };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(payload);
}

function sendText(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'));

function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename);
}

async function sendFile(req, res, rel) {
  const { target } = await resolveInside(rel);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) {
    const error = new Error('Not a file');
    error.status = 404;
    throw error;
  }
  const filename = path.basename(target);
  if (stat.size === 0) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': 0,
      'Access-Control-Allow-Origin': '*'
    });
    res.end();
    return;
  }
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(filename),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff'
  };

  let start = 0;
  let end = stat.size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
      res.end();
      return;
    }
    if (match[1] !== '') start = Number(match[1]);
    if (match[2] !== '') end = Number(match[2]);
    if (match[1] === '' && match[2] !== '') {
      const suffix = Number(match[2]);
      start = Math.max(stat.size - suffix, 0);
      end = stat.size - 1;
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
      res.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
  } else {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
  }

  const stream = fs.createReadStream(target, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}

function fileRelFromUrl(pathname) {
  const prefix = '/files/';
  if (!pathname.startsWith(prefix)) return null;
  return decodeRel(pathname.slice(prefix.length));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/health') {
      sendJson(res, 200, { ok: true, root: ROOT });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(INDEX_HTML);
      return;
    }

    if (pathname === '/api/list') {
      const rel = decodeRel(url.searchParams.get('path') || '');
      const skipDu = url.searchParams.get('stats') === '0';
      const listing = await listDirectory(rel, { skipDu });
      sendJson(res, 200, {
        root: ROOT,
        path: listing.path,
        entries: listing.entries,
        patchStats: listing.patchStats
      });
      return;
    }

    if (pathname === '/api/catalog') {
      const body = await catalog();
      sendJson(res, 200, body);
      return;
    }

    if (pathname.startsWith('/files/')) {
      const rel = fileRelFromUrl(pathname);
      if (req.method === 'HEAD') {
        const { target } = await resolveInside(rel);
        const stat = await fsp.stat(target);
        if (!stat.isFile()) {
          sendText(res, 404, 'Not a file');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': contentDisposition(path.basename(target))
        });
        res.end();
        return;
      }
      await sendFile(req, res, rel);
      return;
    }

    sendText(res, 404, 'Not found');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, status, { error: status >= 500 ? 'Internal error' : err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log('Patch browser listening on http://' + HOST + ':' + PORT);
  console.log('Serving ' + ROOT);
});
