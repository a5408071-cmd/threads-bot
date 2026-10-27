/**
 * 投稿に付ける写真（2026-10-27 社長「毎回画像を AI っぽくないものを作成して乗せるのは難しい？」→ 本物の写真を Drive にためて選ぶ方式）。
 *   置き場所: イソ保管庫/共通/Threads写真/（THREADS_PHOTO_FOLDER_ID）。社長がスマホの写真を放り込む。
 *   読み方: Cloud Run のサービスアカウント（フォルダを閲覧者で共有済み）で Drive の一覧を取る。
 *   公開 URL: Meta は誰でも開ける URL しか取りに来ないので、iso-bot の /media/drive/<ID>.jpg?sig=…（GBP と同じ経路。署名は ISO_CRON_KEY＝iso-bot の CRON_KEY の HMAC）。
 *   中身: その URL から取って（iso-bot が長辺 2000px の JPEG に直して返す）Claude に見せ、写っているものに合う文を書かせる。
 *   使い回し: 同じ写真は COOLDOWN_DAYS（60 日）あける（Firestore threads_photos/<fileId>）。
 * 失敗はすべて null（写真なしで投稿する。投稿そのものは止めない）。
 */
const crypto = require('crypto');

const COOLDOWN_DAYS = 60;
const DEFAULT_RATE = 0.5;
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/** iso-bot の gbpReviews.mediaSig と同じ式 */
function mediaSig(fileId, env = process.env) {
  const key = env.ISO_CRON_KEY || '';
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(`drive:${fileId}`).digest('hex').slice(0, 32);
}

/** Drive の一覧（サービスアカウントの既定の資格情報。フォルダは閲覧者で共有しておく） */
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
  return { listImages };
}

function createPhotos({ drive, http, store, env = process.env, now = () => new Date(), rng = Math.random } = {}) {
  const client = http || require('axios');
  const d = drive || createDrive({ http: client });

  function shouldAttach() {
    const rate = env.THREADS_PHOTO_RATE === undefined || env.THREADS_PHOTO_RATE === '' ? DEFAULT_RATE : Number(env.THREADS_PHOTO_RATE);
    if (!(rate > 0)) return false;
    return rng() < rate;
  }

  /** @returns {Promise<{id,name,url,mediaType,bytes}|null>} */
  async function pick() {
    const folderId = env.THREADS_PHOTO_FOLDER_ID;
    const base = String(env.ISO_BOT_URL || '').replace(/\/+$/, '');
    if (!folderId || !base || !env.ISO_CRON_KEY) return null;
    let files;
    try {
      files = await d.listImages(folderId);
    } catch (e) {
      console.warn(`[threads] PHOTO_LIST_FAILED ${e.message}`);
      return null;
    }
    const fresh = [];
    for (const f of files) if (!(await store.photoUsedRecently(f.id, COOLDOWN_DAYS))) fresh.push(f);
    if (!fresh.length) { console.log(`[threads] PHOTO_NONE total=${files.length}`); return null; }
    const f = fresh[Math.floor(rng() * fresh.length)];
    const url = `${base}/media/drive/${f.id}.jpg?sig=${mediaSig(f.id, env)}`;
    try {
      const r = await client.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      const ct = String((r.headers && r.headers['content-type']) || 'image/jpeg');
      if (!/^image\//.test(ct)) throw new Error(`content-type ${ct}`);
      return { id: f.id, name: f.name, url, mediaType: ct.split(';')[0], bytes: Buffer.from(r.data) };
    } catch (e) {
      console.warn(`[threads] PHOTO_FETCH_FAILED id=${f.id} ${e.message}`);
      return null;
    }
  }

  return { shouldAttach, pick };
}

module.exports = { createPhotos, createDrive, mediaSig, COOLDOWN_DAYS, DEFAULT_RATE };
