/**
 * ストック写真（Pexels。無料・商用可・クレジット不要）。2026-10-28 社長「写真そんなに在庫ないなー」→ 案1。
 *   ゴルフ以外の投稿（日常・季節・時事）と、社長の写真が無いときのゴルフ投稿に、話題に合う本物の写真を 1 枚付ける。
 *   流れ: 文を先に書く → AI が付けた「写真: <英語の検索語>」で Pexels を検索 → 横長の 1 枚を選ぶ（使ったものは 180 日あける）→ 画像 URL を実際に開いて確かめる → Meta にはその URL を渡す。
 *   鍵は PEXELS_API_KEY（Secret Manager pexels-api-key）。200 回/時・2 万回/月の無料枠（1 日 4 本なら余裕）。
 * 失敗はすべて null（写真なしで投稿する）。
 */
const STOCK_COOLDOWN_DAYS = 180;
const SEARCH_URL = 'https://api.pexels.com/v1/search';
const PER_PAGE = 15;

function createStock({ http, store, env = process.env, now = () => new Date(), rng = Math.random } = {}) {
  const client = http || require('axios');

  /** @returns {Promise<{id,url,name,page,photographer}|null>} */
  async function search(query) {
    const key = env.PEXELS_API_KEY;
    const q = String(query || '').trim();
    if (!key || !q) return null;
    let photos;
    try {
      const r = await client.get(SEARCH_URL, { headers: { Authorization: key }, params: { query: q, orientation: 'landscape', per_page: PER_PAGE, size: 'large' }, timeout: 15000 });
      photos = (r.data && r.data.photos) || [];
    } catch (e) {
      console.warn(`[threads] STOCK_SEARCH_FAILED q="${q}" ${e.message}`);
      return null;
    }
    const candidates = [];
    for (const p of photos) {
      if (!p || !p.id || !p.src) continue;
      if (p.width && p.height && p.width < p.height) continue; // 横長だけ
      const id = `pexels:${p.id}`;
      if (await store.photoUsedRecently(id, STOCK_COOLDOWN_DAYS)) continue;
      candidates.push({ id, url: p.src.large2x || p.src.large || p.src.original, name: `Pexels: ${p.photographer || '?'}`, page: p.url || '', photographer: p.photographer || '' });
    }
    if (!candidates.length) { console.log(`[threads] STOCK_NONE q="${q}" total=${photos.length}`); return null; }
    const pick = candidates[Math.floor(rng() * candidates.length)];
    // Meta が取りに来る前に、こちらで開けるか確かめる（2026-10-08 GBP で存在しない URL を渡して全店 500 になった教訓）
    try {
      const r = await client.get(pick.url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 20 * 1024 * 1024 });
      const ct = String((r.headers && r.headers['content-type']) || '');
      if (!/^image\//.test(ct)) throw new Error(`content-type ${ct || '?'}`);
    } catch (e) {
      console.warn(`[threads] STOCK_FETCH_FAILED id=${pick.id} ${e.message}`);
      return null;
    }
    return pick;
  }

  return { search };
}

module.exports = { createStock, STOCK_COOLDOWN_DAYS };
