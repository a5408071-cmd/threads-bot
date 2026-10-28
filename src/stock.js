/**
 * ストック写真（Pixabay。無料・商用可・クレジット不要）。2026-10-28 社長「写真そんなに在庫ないなー」→ 案1。
 * （最初は Pexels の予定だったが「新規の API キー発行を停止中」で取れず、同条件の Pixabay に＝2026-10-28）
 *   ゴルフ以外の投稿（日常・季節・時事）と、社長の写真が無いときのゴルフ投稿に、話題に合う本物の写真を 1 枚付ける。
 *   流れ: 文を先に書く → AI が付けた「写真: <英語の検索語>」で検索 → 横長の 1 枚を選ぶ（使ったものは 180 日あける）→ 画像を実際に取って確かめる
 *        → Meta には自分の /media/stock/<id>.jpg?sig=… を渡す（Pixabay はホットリンク禁止なので自分で出す。別インスタンスが受けても id から取り直せる）。
 *   鍵は PIXABAY_API_KEY（Secret Manager pixabay-api-key）。無料枠 100 回/分（1 日 4 本なら余裕）。
 * 失敗はすべて null（写真なしで投稿する）。
 */
const crypto = require('crypto');

const STOCK_COOLDOWN_DAYS = 180;
const API_URL = 'https://pixabay.com/api/';
const PER_PAGE = 20;
const CACHE_TTL_MS = 60 * 60 * 1000;

function stockSig(id, env = process.env) {
  const key = env.CRON_KEY || '';
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(`stock:${id}`).digest('hex').slice(0, 32);
}

function createStock({ http, store, env = process.env, now = () => new Date(), rng = Math.random } = {}) {
  const client = http || require('axios');
  const cache = new Map(); // id → { bytes, at }

  const api = async (params) => {
    const r = await client.get(API_URL, { params: { key: env.PIXABAY_API_KEY, image_type: 'photo', safesearch: 'true', ...params }, timeout: 15000 });
    return (r.data && r.data.hits) || [];
  };

  async function download(url) {
    const r = await client.get(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 20 * 1024 * 1024 });
    const ct = String((r.headers && r.headers['content-type']) || '');
    if (!/^image\//.test(ct)) throw new Error(`content-type ${ct || '?'}`);
    return Buffer.from(r.data);
  }

  const urlOf = (id) => `${String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/media/stock/${id}.jpg?sig=${stockSig(id, env)}`;

  /** @returns {Promise<{id,url,name,page,photographer}|null>} */
  async function search(query) {
    const q = String(query || '').trim();
    if (!env.PIXABAY_API_KEY || !q || !env.PUBLIC_BASE_URL || !env.CRON_KEY) return null;
    let hits;
    try {
      hits = await api({ q, orientation: 'horizontal', per_page: PER_PAGE, lang: 'en' });
    } catch (e) {
      console.warn(`[threads] STOCK_SEARCH_FAILED q="${q}" ${e.message}`);
      return null;
    }
    const candidates = [];
    for (const h of hits) {
      if (!h || !h.id || !(h.largeImageURL || h.webformatURL)) continue;
      if (h.imageWidth && h.imageHeight && h.imageWidth < h.imageHeight) continue; // 横長だけ
      const id = `pixabay:${h.id}`;
      if (await store.photoUsedRecently(id, STOCK_COOLDOWN_DAYS)) continue;
      candidates.push({ raw: h.id, id, name: `Pixabay: ${h.user || '?'}`, page: h.pageURL || '', photographer: h.user || '', src: h.largeImageURL || h.webformatURL });
    }
    if (!candidates.length) { console.log(`[threads] STOCK_NONE q="${q}" total=${hits.length}`); return null; }
    const pick = candidates[Math.floor(rng() * candidates.length)];
    try {
      const bytes = await download(pick.src);
      cache.set(String(pick.raw), { bytes, at: now().getTime() });
      if (cache.size > 20) cache.delete(cache.keys().next().value);
    } catch (e) {
      console.warn(`[threads] STOCK_FETCH_FAILED id=${pick.id} ${e.message}`);
      return null;
    }
    return { id: pick.id, url: urlOf(pick.raw), name: pick.name, page: pick.page, photographer: pick.photographer };
  }

  /** /media/stock/<id>.jpg の中身。署名が合わなければ null。キャッシュに無ければ id で Pixabay に聞き直して取る */
  async function serve(id, sig) {
    const want = stockSig(id, env);
    if (!want || !sig || sig !== want) return null;
    const c = cache.get(String(id));
    if (c && now().getTime() - c.at < CACHE_TTL_MS) return c.bytes;
    try {
      const hits = await api({ id: String(id) });
      const h = hits[0];
      if (!h) return null;
      const bytes = await download(h.largeImageURL || h.webformatURL);
      cache.set(String(id), { bytes, at: now().getTime() });
      return bytes;
    } catch (e) {
      console.warn(`[threads] STOCK_SERVE_FAILED id=${id} ${e.message}`);
      return null;
    }
  }

  return { search, serve };
}

module.exports = { createStock, stockSig, STOCK_COOLDOWN_DAYS };
