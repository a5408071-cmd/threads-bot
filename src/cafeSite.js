/**
 * セルフカフェ公式アカウント用: selfcafe.jp の店舗ページから「本当の事実」と写真を取る（2026-10-28 社長「セルフカフェの…ポストして 画像はHPの画像を使う」）。
 *   店の一覧: https://selfcafe.jp/shop/ の /shop/<県>/<slug>/ のリンク（2026-10-28 実測 75 店）
 *   店舗ページ: <dl> の 店舗名／営業時間／定休日／席数／住所／アクセス方法、有料サービス（li.shop-paidservice_item。is-disabled＝無い）、
 *              ギャラリー（div.shop-header_img の img。jpg/png だけ使う＝Threads が webp を受けないため）
 *   解析は iso-bot の src/cafeStoreFacts.js と同じ考え方（無い店でも有料サービスが 4 つ全部並ぶので is-disabled を必ず見る）。
 */
const SHOP_LIST_URL = 'https://selfcafe.jp/shop/';
const PAID_LABELS = ['個室ブース', '会議室', '会員専用エリア', 'コピー機'];
const ROW_KEYS = ['店舗名', '決済方法', '営業時間', '定休日', '席数', '住所', '駐車場', 'アクセス', 'アクセス方法', '有料サービス', 'Coffee'];
const CACHE_MS = 6 * 60 * 60 * 1000;

function parseStoreList(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/href="(https:\/\/selfcafe\.jp\/shop\/[a-z]+\/[^/"]+\/)"/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function toTokens(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, '|')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .split('|').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function parseRows(tokens) {
  const rows = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const key = tokens[i];
    if (!ROW_KEYS.includes(key) || rows[key] !== undefined) continue;
    const vals = [];
    for (let j = i + 1; j < tokens.length && vals.length < 6; j += 1) {
      if (ROW_KEYS.includes(tokens[j])) break;
      vals.push(tokens[j]);
    }
    rows[key] = vals.join(' ').trim();
  }
  return rows;
}

function parsePaid(html) {
  const out = {};
  for (const m of String(html || '').matchAll(/<li class="shop-paidservice_item([^"]*)"[\s\S]*?<\/li>/g)) {
    const label = m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const name = PAID_LABELS.find((l) => label.includes(l));
    if (name) out[name] = !/is-disabled/.test(m[1]);
  }
  return out;
}

function areaOf(address) {
  const a = String(address || '').replace(/〒?\d{3}-?\d{4}/, '').trim().replace(/^(北海道|東京都|京都府|大阪府|[^\s]{2,3}県)/, '').trim();
  const m = a.match(/^([^\s]{1,5}?市)?([^\s市]{1,5}?区)/);
  if (m) return `${m[1] || ''}${m[2]}`;
  const c = a.match(/^([^\s\d０-９－-]{1,8}市)(?![^\s]*区)/);
  return c ? c[1] : null;
}

function stationOf(access) {
  const s = String(access || '');
  const q = s.match(/「([^」]+)」\s*駅/);
  if (q) return `${q[1]}駅`;
  const m = s.replace(/(名古屋市営)?地下鉄[^\s駅]*?線|JR[^\s駅]*?線|[^\s駅]{1,8}線|JR|名鉄|近鉄|阪急|阪神|京阪|南海|東急|小田急|西武|東武|京王|都営|大阪メトロ|東京メトロ/g, ' ').match(/([^\s「」・、,（(]{1,10}?)\s*駅/);
  return m && m[1] ? `${m[1]}駅` : null;
}

function parseImages(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/class="shop-header_img"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/g)) {
    if (/\.(jpe?g|png)(\?|$)/i.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function parseStorePage(html, url) {
  const rows = parseRows(toTokens(html));
  return {
    url,
    name: rows['店舗名'] || null,
    hours: rows['営業時間'] || null,
    holiday: rows['定休日'] || null,
    seats: rows['席数'] || null,
    address: rows['住所'] || null,
    area: areaOf(rows['住所']),
    access: rows['アクセス方法'] || null,
    station: stationOf(rows['アクセス方法']),
    paid: parsePaid(html),
    images: parseImages(html),
  };
}

/** AI に渡す「この店の事実」。ここに無い設備・数字は書かせない */
function factsText(f) {
  const paid = PAID_LABELS.map((l) => `${l} ${f.paid[l] === true ? 'あり' : f.paid[l] === false ? 'なし' : '不明'}`).join('・');
  return [
    '今回紹介する店の事実（公式サイト selfcafe.jp の店舗ページから。ここに無い設備・数字・サービスは書かない）:',
    `- 店名: ${f.name || '?'}／エリア: ${f.area || '不明'}／最寄駅: ${f.station || '不明'}${f.access ? `（${f.access}）` : ''}`,
    `- 営業時間: ${f.hours || '不明'}／定休日: ${f.holiday || '不明'}／席数: ${f.seats || '不明'}`,
    `- 有料サービス: ${paid}（「なし」のものは書かない・勧めない）`,
  ].join('\n');
}

function createCafeSite({ http, rng = Math.random, now = () => Date.now() } = {}) {
  const client = http || require('axios');
  const cache = new Map();
  const getText = async (url) => {
    const hit = cache.get(url);
    if (hit && now() - hit.at < CACHE_MS) return hit.text;
    const r = await client.get(url, { responseType: 'text', timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (threads-bot)' } });
    const text = String(r.data || '');
    cache.set(url, { at: now(), text });
    return text;
  };

  async function listStores() {
    return parseStoreList(await getText(SHOP_LIST_URL));
  }

  async function storeFacts(url) {
    return parseStorePage(await getText(url), url);
  }

  /** 最近紹介していない店を 1 つ選び、事実と写真 1 枚（中身付き）を返す */
  async function pickStore({ recentUrls = [] } = {}) {
    const all = await listStores();
    if (!all.length) throw new Error('selfcafe.jp の店舗一覧が読めない');
    const fresh = all.filter((u) => !recentUrls.includes(u));
    const pool = fresh.length ? fresh : all;
    const url = pool[Math.floor(rng() * pool.length)];
    const facts = await storeFacts(url);
    let photo = null;
    const imgs = facts.images.slice();
    const start = imgs.length ? Math.floor(rng() * imgs.length) : 0;
    for (const src of imgs.slice(start).concat(imgs.slice(0, start))) {
      try {
        const r = await client.get(src, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 8 * 1024 * 1024 });
        const ct = String((r.headers && r.headers['content-type']) || '');
        if (!/^image\/(jpeg|png)/.test(ct)) continue;
        photo = { id: `hp:${src}`, url: src, name: `HP: ${facts.name || url}`, mediaType: ct.split(';')[0], bytes: Buffer.from(r.data) };
        break;
      } catch (e) {
        console.warn(`[threads] CAFE_PHOTO_FAILED ${src} ${e.message}`);
      }
    }
    return { url, facts, photo };
  }

  return { listStores, storeFacts, pickStore };
}

module.exports = { createCafeSite, parseStoreList, parseStorePage, factsText, SHOP_LIST_URL };
