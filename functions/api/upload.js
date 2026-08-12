/**
 * POST /api/upload — 唯一會用到 Workers 的地方。
 *
 * 瀏覽器已經算好內容雜湊、也已經 gzip 過，這裡只做三件事：
 *   1. 驗證上傳密碼
 *   2. 檢查參數與大小
 *   3. 寫進 R2
 * 之後所有的「讀取」都直接走 R2 公開網址，完全不經過 Workers。
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 壓縮後 2 MB
const ID_PATTERN = /^[0-9a-z]{6,16}$/;

/** 依保存期限決定 key 前綴，R2 lifecycle 規則會照前綴自動刪除 */
const TTL_PREFIX = {
  w: 'w', // 7 天
  m: 'm', // 30 天
  p: 'p', // 永久
};

/** 內容是雜湊定址的，可以放心讓 CDN 快取久一點，順便省下 R2 的讀取次數 */
const CACHE_CONTROL = {
  w: 'public, max-age=3600',
  m: 'public, max-age=21600',
  p: 'public, max-age=31536000, immutable',
};

function text(status, message) {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 不因為長度或前綴差異提早回傳，避免用回應時間試出密碼 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
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

  const encoding = request.headers.get('x-hd-enc') === 'gzip' ? 'gzip' : undefined;

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return text(413, '檔案太大了。');

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return text(400, '沒有收到內容。');
  if (body.byteLength > MAX_BODY_BYTES) return text(413, '檔案太大了。');

  const key = `${prefix}/${id}`;
  const url = `${env.PUBLIC_BASE.replace(/\/+$/, '')}/${key}`;

  // 相同內容會得到相同的 key。先確認一下，重複上傳就不必再寫一次
  // （R2 的寫入比讀取貴一個數量級，順便也不會多佔儲存空間）。
  const existing = await env.BUCKET.head(key);
  if (existing) {
    return Response.json({ id, key, url, deduped: true }, {
      headers: { 'cache-control': 'no-store' },
    });
  }

  await env.BUCKET.put(key, body, {
    httpMetadata: {
      contentType: 'text/html; charset=utf-8',
      contentEncoding: encoding,
      cacheControl: CACHE_CONTROL[ttl],
    },
  });

  return Response.json({ id, key, url, deduped: false }, {
    headers: { 'cache-control': 'no-store' },
  });
}
