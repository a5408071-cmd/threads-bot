/**
 * 投稿に付ける写真（2026-10-27 社長「毎回画像を AI っぽくないものを作成して乗せるのは難しい？」→ 本物の写真を Drive にためて選ぶ方式）。
 *   置き場所: イソ保管庫/共通/Threads写真/（THREADS_PHOTO_FOLDER_ID）。社長がスマホの写真を放り込む。
 *   読み方: Cloud Run のサービスアカウント（フォルダを閲覧者で共有済み）で Drive の一覧と中身を取る。
 *   変換: iPhone の写真は HEIC なので heic-convert で JPEG にし、sharp で長辺 2000px に縮める（iso-bot の /media/drive は HEIC を読めず 502 だった＝2026-10-27 実測）。
 *   公開 URL: Meta は誰でも開ける URL しか取りに来ないので、自分の /media/photo/<ID>.jpg?sig=…（署名は CRON_KEY の HMAC）で変換済みの JPEG を返す。
 *   使い回し: 同じ写真は COOLDOWN_DAYS（60 日）あける（Firestore threads_photos/<fileId>）。
 * 失敗はすべて null（写真なしで投稿する。投稿そのものは止めない）。
 */
const crypto = require('crypto');

const COOLDOWN_DAYS = 60;
const DEFAULT_RATE = 0.5;
const MAX_EDGE = 2000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/** /media/photo/<ID>.jpg の署名（他の Drive ファイルを外から取られないように） */
function mediaSig(fileId, env = process.env) {
  const key = env.CRON_KEY || '';
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(`photo:${fileId}`).digest('hex').slice(0, 32);
}

function isHeic(mimeType, name) {
  return /heic|heif/i.test(String(mimeType || '')) || /\.(heic|heif)$/i.test(String(name || ''));
}

/** HEIC なら JPEG に、どれも長辺 2000px の JPEG（quality 85）に */
async function defaultConvert(bytes, mimeType, name) {
  let buf = Buffer.from(bytes);
  if (isHeic(mimeType, name)) {
    const heicConvert = require('heic-convert');
    buf = Buffer.from(await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.9 }));
  }
  const sharp = require('sharp');
  return sharp(buf).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

/** Drive の一覧と中身（サービスアカウントの既定の資格情報。フォルダは閲覧者で共有しておく） */
function createDrive({ http } = {}) {
  const client = http || require('axios');
  let auth = null;
  async function token() {
    if (!auth) {
      const { GoogleAuth } = require('google-auth-library');
      auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    }
    const c = await auth.getClient();
    const t = await c.getAccessToken();
    return typeof t === 'string' ? t : t.token;
  }
  async function listImages(folderId) {
    const files = [];
    let pageToken;
    const tk = await token();
    do {
      const r = await client.get(DRIVE_FILES, {
        headers: { Authorization: `Bearer ${tk}` },
        params: { q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`, fields: 'nextPageToken,files(id,name,mimeType,createdTime)', pageSize: 200, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true },
      });
      for (const f of (r.data && r.data.files) || []) files.push({ id: f.id, name: f.name, mimeType: f.mimeType });
      pageToken = r.data && r.data.nextPageToken;
    } while (pageToken);
    return files;
  }
  async function download(fileId) {
    const tk = await token();
    const meta = await client.get(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, { headers: { Authorization: `Bearer ${tk}` }, params: { fields: 'id,name,mimeType', supportsAllDrives: true } });
    const r = await client.get(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, { headers: { Authorization: `Bearer ${tk}` }, params: { alt: 'media', supportsAllDrives: true }, responseType: 'arraybuffer', timeout: 60000, maxContentLength: 50 * 1024 * 1024 });
    return { bytes: Buffer.from(r.data), mimeType: (meta.data && meta.data.mimeType) || 'application/octet-stream', name: meta.data && meta.data.name };
  }
  return { listImages, download };
}

function createPhotos({ drive, http, convert = defaultConvert, store, env = process.env, now = () => new Date(), rng = Math.random } = {}) {
  const d = drive || createDrive({ http });
  const cache = new Map(); // fileId → { bytes, at }（Meta が取りに来るまでの短い間）

  function shouldAttach() {
    const rate = env.THREADS_PHOTO_RATE === undefined || env.THREADS_PHOTO_RATE === '' ? DEFAULT_RATE : Number(env.THREADS_PHOTO_RATE);
    if (!(rate > 0)) return false;
    return rng() < rate;
  }

  /** Drive から取って JPEG に（1 時間はキャッシュ） */
  async function jpegOf(fileId, name) {
    const c = cache.get(fileId);
    if (c && now().getTime() - c.at < CACHE_TTL_MS) return c.bytes;
    const raw = await d.download(fileId);
    const bytes = await convert(raw.bytes, raw.mimeType, raw.name || name);
    cache.set(fileId, { bytes, at: now().getTime() });
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return bytes;
  }

  const urlOf = (fileId) => `${String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/media/photo/${fileId}.jpg?sig=${mediaSig(fileId, env)}`;

  /** @returns {Promise<{id,name,url,mediaType,bytes}|null>} */
  async function pick() {
    const folderId = env.THREADS_PHOTO_FOLDER_ID;
    if (!folderId || !env.PUBLIC_BASE_URL || !env.CRON_KEY) return null;
    let files;
    try {
      files = await d.listImages(folderId);
    } catch (e) {
      console.warn(`[threads] PHOTO_LIST_FAILED ${e.message}`);
      return null;
    }
    if (!files.length) { console.log('[threads] PHOTO_NONE total=0'); return null; }
    const fresh = [];
    for (const f of files) if (!(await store.photoUsedRecently(f.id, COOLDOWN_DAYS))) fresh.push(f);
    let f;
    if (fresh.length) {
      f = fresh[Math.floor(rng() * fresh.length)];
    } else {
      // 在庫切れ: 一番前に使ったものを使い回す（1 日 4 本×2 本に 1 本で在庫が尽きやすい。2026-10-28）
      let oldest = null;
      for (const x of files) {
        const at = await store.photoLastUsed(x.id);
        if (!oldest || String(at || '') < String(oldest.at || '')) oldest = { file: x, at };
      }
      f = oldest.file;
      console.log(`[threads] PHOTO_REUSE id=${f.id} total=${files.length}`);
    }
    try {
      const bytes = await jpegOf(f.id, f.name);
      return { id: f.id, name: f.name, url: urlOf(f.id), mediaType: 'image/jpeg', bytes };
    } catch (e) {
      console.warn(`[threads] PHOTO_FETCH_FAILED id=${f.id} ${e.message}`);
      return null;
    }
  }

  /** /media/photo/<ID>.jpg の中身。署名が合わなければ null。選んでいない写真でも署名が合えば出す（別インスタンスが受けても出せる） */
  async function serve(fileId, sig) {
    const want = mediaSig(fileId, env);
    if (!want || !sig || sig !== want) return null;
    try {
      return await jpegOf(fileId);
    } catch (e) {
      console.warn(`[threads] PHOTO_SERVE_FAILED id=${fileId} ${e.message}`);
      return null;
    }
  }

  return { shouldAttach, pick, serve };
}

module.exports = { createPhotos, createDrive, mediaSig, isHeic, defaultConvert, COOLDOWN_DAYS, DEFAULT_RATE };
