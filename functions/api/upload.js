/**
 * POST /api/upload — Workers API
 *
 * 支援上傳：
 *   1. 單一 HTML 檔案 (x-hd-type: file)
 *   2. 靜態網站資料夾 (x-hd-type: folder)
 */

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 壓縮後 25 MB
const MAX_FILES = 1000;
const ID_PATTERN = /^[0-9a-z]{6,16}$/;

const TTL_PREFIX = {
  w: 'w', // 7 天
  m: 'm', // 30 天
  p: 'p', // 永久
};

const CACHE_CONTROL = {
  w: 'public, max-age=3600',
  m: 'public, max-age=21600',
  p: 'public, max-age=31536000, immutable',
};

const MIME_MAP = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

const COMPRESSIBLE_TYPES = new Set([
  'text/html; charset=utf-8',
  'text/css; charset=utf-8',
  'text/javascript; charset=utf-8',
  'application/json; charset=utf-8',
  'image/svg+xml',
  'application/xml',
  'text/plain; charset=utf-8',
]);

function getMimeType(filename, defaultMime) {
  if (defaultMime && defaultMime !== 'application/octet-stream') return defaultMime;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function sanitizePath(pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return null;
  const cleaned = pathStr.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = cleaned.split('/');
  for (const p of parts) {
    if (p === '..' || p === '.') return null;
  }
  return parts.join('/');
}

function text(status, message) {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function decompressGzip(arrayBuffer) {
  try {
    const stream = new Response(arrayBuffer).body.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  } catch {
    return arrayBuffer;
  }
}

async function compressGzip(uint8Array) {
  try {
    const stream = new Blob([uint8Array]).stream().pipeThrough(new CompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  } catch {
    return uint8Array;
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return text(405, '只接受 POST。');

  if (!env.UPLOAD_KEY) return text(500, '伺服器尚未設定 UPLOAD_KEY。');
  if (!env.PUBLIC_BASE) return text(500, '伺服器尚未設定 PUBLIC_BASE。');

  if (!safeEqual(request.headers.get('x-hd-key') || '', env.UPLOAD_KEY)) {
    return text(401, '密碼不正確。');
  }

  const id = (request.headers.get('x-hd-id') || '').toLowerCase();
  if (!ID_PATTERN.test(id)) return text(400, '代號格式不正確。');

  const ttl = request.headers.get('x-hd-ttl') || 'm';
  const prefix = TTL_PREFIX[ttl];
  if (!prefix) return text(400, '保存期限不正確。');

  const isFolder = request.headers.get('x-hd-type') === 'folder';
  const entryPath = sanitizePath(request.headers.get('x-hd-entry') || 'index.html') || 'index.html';
  const isGzip = request.headers.get('x-hd-enc') === 'gzip';

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return text(400, '沒有收到內容。');
  if (body.byteLength > MAX_BODY_BYTES) return text(413, '檔案太大了。');

  const publicBase = env.PUBLIC_BASE.replace(/\/+$/, '');

  if (!isFolder) {
    // ── 單一 HTML 檔案處理 ───────────────────────────────────────
    const key = `${prefix}/${id}`;
    const url = `${publicBase}/${key}`;

    const existing = await env.BUCKET.head(key);
    if (existing) {
      return Response.json({ id, key, url, deduped: true }, {
        headers: { 'cache-control': 'no-store' },
      });
    }

    await env.BUCKET.put(key, body, {
      httpMetadata: {
        contentType: 'text/html; charset=utf-8',
        contentEncoding: isGzip ? 'gzip' : undefined,
        cacheControl: CACHE_CONTROL[ttl],
      },
    });

    return Response.json({ id, key, url, deduped: false }, {
      headers: { 'cache-control': 'no-store' },
    });
  }

  // ── 資料夾上傳處理 ─────────────────────────────────────────
  const rawBuffer = isGzip ? await decompressGzip(body) : body;
  if (rawBuffer.byteLength < 4) return text(400, '封包格式不正確。');

  const dataView = new DataView(rawBuffer);
  const manifestLen = dataView.getUint32(0, false);
  if (manifestLen <= 0 || manifestLen > rawBuffer.byteLength - 4) {
    return text(400, '封包清單長度不正確。');
  }

  let manifest;
  try {
    const manifestBytes = new Uint8Array(rawBuffer, 4, manifestLen);
    const manifestStr = new TextDecoder().decode(manifestBytes);
    manifest = JSON.parse(manifestStr);
  } catch {
    return text(400, '封包清單解析失敗。');
  }

  if (!Array.isArray(manifest) || manifest.length === 0) {
    return text(400, '資料夾內沒有檔案。');
  }
  if (manifest.length > MAX_FILES) {
    return text(400, `檔案數量超過 ${MAX_FILES} 個上限。`);
  }

  // 入口 Key
  const mainKey = `${prefix}/${id}/${entryPath}`;
  const mainUrl = `${publicBase}/${mainKey}`;

  // 去重檢查
  const existing = await env.BUCKET.head(mainKey);
  if (existing) {
    return Response.json({ id, key: mainKey, url: mainUrl, deduped: true, fileCount: manifest.length }, {
      headers: { 'cache-control': 'no-store' },
    });
  }

  let payloadOffset = 4 + manifestLen;
  const uploads = [];

  for (const item of manifest) {
    const relPath = sanitizePath(item.path);
    if (!relPath) continue;

    const size = Number(item.size) || 0;
    if (payloadOffset + size > rawBuffer.byteLength) {
      return text(400, '封包資料長度不符。');
    }

    const fileBytes = new Uint8Array(rawBuffer, payloadOffset, size);
    payloadOffset += size;

    const itemKey = `${prefix}/${id}/${relPath}`;
    const contentType = getMimeType(relPath, item.type);
    const isCompressible = COMPRESSIBLE_TYPES.has(contentType);

    uploads.push((async () => {
      let putBody = fileBytes;
      let contentEncoding;

      if (isCompressible) {
        const compressed = await compressGzip(fileBytes);
        if (compressed.byteLength < fileBytes.byteLength) {
          putBody = compressed;
          contentEncoding = 'gzip';
        }
      }

      await env.BUCKET.put(itemKey, putBody, {
        httpMetadata: {
          contentType,
          contentEncoding,
          cacheControl: CACHE_CONTROL[ttl],
        },
      });
    })());
  }

  await Promise.all(uploads);

  return Response.json({ id, key: mainKey, url: mainUrl, deduped: false, fileCount: manifest.length }, {
    headers: { 'cache-control': 'no-store' },
  });
}

