/**
 * セルフカフェ公式アカウント用: selfcafe.jp の店舗ページから「本当の事実」と写真を取る（2026-10-28 社長「セルフカフェの…ポストして 画像はHPの画像を使う」）。
 *   店の一覧: https://selfcafe.jp/shop/ の /shop/<県>/<slug>/ のリンク（2026-10-28 実測 75 店）
 *   店舗ページ: <dl> の 店舗名／営業時間／定休日／席数／住所／アクセス方法、有料サービス（li.shop-paidservice_item。is-disabled＝無い）、
 *              ギャラリー（div.shop-header_img の img。jpg/png だけ使う＝Threads が webp を受けないため）
 *   解析は iso-bot の src/cafeStoreFacts.js と同じ考え方（無い店でも有料サービスが 4 つ全部並ぶので is-disabled を必ず見る）。
 */
const SHOP_LIST_URL = 'https://selfcafe.jp/shop/';
// 店舗ページの公開日（WordPress の shop。2026-11-02 実測 75 店＝一覧と同じ）。既存店の紹介を新しい店から回すのに使う
const SHOP_API_URL = 'https://selfcafe.jp/wp-json/wp/v2/shop?per_page=100&_fields=link,date';
// 新着情報（2026-10-29 社長「特定の店舗は新店舗もしくは新しい取り組みがある場合のみ」）。種類は 新店舗情報／キャンペーン／お知らせ（2026-10-29 実測）
const NEWS_URL = 'https://selfcafe.jp/news/';
// メディア情報（テレビ・新聞・オンラインの掲載。2026-10-29 社長「HPのメディア情報あがったときは連動して」）は別の一覧。種類は「メディア掲載」として扱う
const MEDIA_URL = 'https://selfcafe.jp/media-information/';
const MEDIA_CATEGORY = 'メディア掲載';
const MEDIA_DAYS = 14; // 記事の日付からこの日数まで紹介する
const ANNOUNCE_CATEGORIES = { 新店舗情報: 'newstore', キャンペーン: 'campaign', [MEDIA_CATEGORY]: 'media' }; // お知らせ（支払い方法の変更など）は告知しない
const ARTICLE_MAX_AGE_DAYS = 30;
const NEWSTORE_AFTER_OPEN_DAYS = 7;
const CAMPAIGN_NO_DATE_DAYS = 14;
const ENTRY_TEXT_MAX = 1200;
const MULTI_PHOTO_MAX = 5; // OPEN 済みの新店の告知で使う写真の枚数の上限
const PAID_LABELS = ['個室ブース', '会議室', '会員専用エリア', 'コピー機'];
const ROW_KEYS = ['店舗名', '決済方法', '営業時間', '定休日', '席数', '住所', '駐車場', 'アクセス', 'アクセス方法', '有料サービス', 'Coffee'];
const CACHE_MS = 6 * 60 * 60 * 1000;
const NAMES_FAIL_CACHE_MS = 5 * 60 * 1000; // 店舗一覧が読めなかったあと、店名探しを休む時間

function parseStoreList(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/href="(https:\/\/selfcafe\.jp\/shop\/[a-z]+\/[^/"]+\/)"/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 店舗一覧から店名・住所付きの一覧（コメントの店名から店のページを引くため。2026-11-02 社長「特定の店舗の時は子ページのTOPを案内して」） */
function parseStoreNames(html) {
  const out = [];
  const re = /<a href="(https:\/\/selfcafe\.jp\/shop\/[a-z]+\/[^/"]+\/)">([\s\S]*?)<\/a>/g;
  for (const m of String(html || '').matchAll(re)) {
    const name = (m[2].match(/shop-listItem_name">([^<]*)</) || [])[1];
    const address = (m[2].match(/shop-listItem_address">([^<]*)</) || [])[1];
    if (!name || out.some((s) => s.url === m[1])) continue;
    out.push({ url: m[1], name: name.trim(), address: (address || '').trim() });
  }
  return out;
}

/**
 * 文中に出てくる店を 1 つ当てる（「セルフカフェ 藤が丘店」「藤が丘店」「藤が丘」）。長い名前から試すので「ナディアパーク栄店」は「栄店」より先に当たる。
 * 英字の付いた店名（新宿西口Shinjuku Future Gallery店）は英字を除いた「新宿西口」でも当てる。1 文字の店（栄・原）は「栄店」のように店を付けたときだけ（「原則」「栄える」で誤爆しないため）
 */
function matchStore(text, stores) {
  const s = String(text || '').replace(/[\s　]+/g, '');
  if (!s) return null;
  const cands = [];
  for (const st of stores || []) {
    const short = String(st.name || '').replace(/^セルフカフェ/, '').replace(/[\s　]+/g, '').replace(/店$/, '');
    const jp = short.replace(/[A-Za-z0-9&＆・\-－]+$/, '').replace(/^[A-Za-z0-9&＆・\-－]+/, '');
    for (const a of new Set([short, jp])) {
      if (!a) continue;
      cands.push({ st, key: a.length >= 2 ? a : `${a}店` });
    }
  }
  cands.sort((a, b) => b.key.length - a.key.length);
  const hit = cands.find((c) => s.includes(c.key));
  return hit ? hit.st : null;
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

const DAY = 86400000;
const squash = (t) => String(t || '').replace(/[\s　]+/g, '');
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
const decode = (t) => String(t || '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#0?38;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#8211;/g, '–');

/** 新着情報の一覧（新しい順） */
function parseNewsList(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<article class="news-listItem">([\s\S]*?)<\/article>/g)) {
    const a = m[1];
    const url = (a.match(/href="([^"]+)"/) || [])[1];
    const date = (a.match(/datetime="(\d{4}-\d{2}-\d{2})"/) || [])[1];
    const category = ((a.match(/news-listItem_category[^>]*>([^<]+)</) || [])[1] || '').trim();
    const title = decode(((a.match(/news-listItem_title[^>]*>([^<]+)</) || [])[1] || '').trim());
    if (url && date && title) out.push({ url, date, category, title });
  }
  return out;
}

/** メディア情報の一覧（新しい順）。#テレビ出演 などは tags に */
function parseMediaList(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<article class="blog-listItem">([\s\S]*?)<\/article>/g)) {
    const a = m[1];
    const url = (a.match(/href="([^"]+)"/) || [])[1];
    const date = (a.match(/datetime="(\d{4}-\d{2}-\d{2})"/) || [])[1];
    const title = decode(((a.match(/blog-listItem_title[^>]*>([^<]+)</) || [])[1] || '').trim());
    const cat = (a.match(/blog-listItem_category[^>]*>([\s\S]*?)<\/(?:p|a)>/) || [])[1] || '';
    const tags = [...cat.matchAll(/<span>#?([^<]+)<\/span>/g)].map((x) => x[1].trim()).filter(Boolean);
    if (url && date && title) out.push({ url, date, category: MEDIA_CATEGORY, title, tags });
  }
  return out;
}

/** メディア情報の記事: 本文と、掲載記事へのリンク（selfcafe.jp 以外の最初のリンク） */
function parseMediaEntry(html) {
  const body = (String(html || '').match(/<div class="entryBody[^"]*">([\s\S]*?)(?:<div class="entryNavi|<\/article>)/) || [])[1] || '';
  const linkUrl = [...body.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((x) => decode(x[1])).find((u) => !/^https?:\/\/([^/]+\.)?selfcafe\.jp\//.test(u)) || null;
  return { ...parseNewsEntry(html), linkUrl };
}

/** 記事の本文（文字だけ）と、本文中の店舗ページへのリンク */
function parseNewsEntry(html) {
  // 本文の中に入れ子の <div> があっても切れないよう、次の目印（前後の記事のナビ・</article>）まで取る
  const body = (String(html || '').match(/<div class="entryBody[^"]*">([\s\S]*?)(?:<div class="entryNavi|<\/article>)/) || [])[1] || '';
  const shopUrl = (body.match(/href="(https:\/\/selfcafe\.jp\/shop\/[a-z]+\/[^/"]+\/)"/) || [])[1] || null;
  const text = decode(body.replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|h\d|li)>/g, '\n').replace(/<[^>]+>/g, ''))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, ENTRY_TEXT_MAX);
  return { text, shopUrl };
}

/** 見出しの「M月D日」（OPEN 日・キャンペーンの終わり）を YYYY-MM-DD に。年は記事の日付から（月が戻れば翌年） */
function announcementDate(item) {
  const all = [...String(item.title || '').matchAll(/(\d{1,2})月(\d{1,2})日/g)];
  if (!all.length) return null;
  // 新店舗は「OPEN」の直前（無ければ最初）、キャンペーンは最後の日付（「10月1日〜10月12日まで」の終わり）
  const title = String(item.title || '');
  const openAt = title.search(/OPEN|オープン/i);
  const before = openAt >= 0 ? all.filter((x) => x.index < openAt) : [];
  const m = item.category === 'キャンペーン' ? all[all.length - 1] : (before.length ? before[before.length - 1] : all[0]);
  const [y, am] = item.date.split('-').map(Number);
  const mon = Number(m[1]); const day = Number(m[2]);
  const year = am - mon > 6 ? y + 1 : y; // 12 月の記事に「1 月」→ 翌年。数か月前の月はその年のまま（過ぎた日として扱う）
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 今日（JST の YYYY-MM-DD）告知してよい記事か */
function isAnnounceable(item, today) {
  const kind = ANNOUNCE_CATEGORIES[item.category];
  if (!kind) return false;
  if (dayDiff(today, item.date) > ARTICLE_MAX_AGE_DAYS) return false;
  if (kind === 'media') return dayDiff(today, item.date) <= MEDIA_DAYS;
  const d = announcementDate(item);
  if (kind === 'newstore') return d ? dayDiff(today, d) <= NEWSTORE_AFTER_OPEN_DAYS : dayDiff(today, item.date) <= CAMPAIGN_NO_DATE_DAYS;
  return d ? dayDiff(today, d) <= 0 : dayDiff(today, item.date) <= CAMPAIGN_NO_DATE_DAYS;
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
  // Meta が取りに来られなかった写真（code=1 sub=2207052）は使わない（2026-11-09 pb030371_hp.jpg が 11/8・11/9 と続けて失敗）。cafeTick が Firestore の記録から入れる
  let badPhotos = new Set();
  const setBadPhotos = (list) => { badPhotos = new Set(Array.isArray(list) ? list : []); };
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

  /**
   * コメントなどの文に店名があればその店（{url,name,address}）。無ければ null。
   * 一覧が読めなければ投げるが、直後の 5 分はもう読みに行かず null（サイトが落ちているときにコメントごとに 20 秒待たない）。一覧が 0 件なら作りが変わった合図なので warn
   */
  let namesFailedAt = 0;
  async function findStore(text) {
    if (now() - namesFailedAt < NAMES_FAIL_CACHE_MS) return null;
    let html;
    try { html = await getText(SHOP_LIST_URL); } catch (e) { namesFailedAt = now(); throw e; }
    const stores = parseStoreNames(html);
    if (!stores.length) console.warn('[threads] CAFE_STORE_NAMES_EMPTY 店舗一覧から店名が 1 つも読めない（ページの作りが変わった？）');
    return matchStore(text, stores);
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
    const photo = await fetchPhoto(facts.images, `HP: ${facts.name || url}`);
    return { url, facts, photo };
  }

  /** 画像を 1 枚（jpg/png だけ。実際に取って確かめる）。どれも取れなければ null */
  async function fetchPhoto(images, name) {
    let photo = null;
    const imgs = (images || []).slice();
    const start = imgs.length ? Math.floor(rng() * imgs.length) : 0;
    for (const src of imgs.slice(start).concat(imgs.slice(0, start))) {
      if (badPhotos.has(src)) continue;
      try {
        const r = await client.get(src, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 8 * 1024 * 1024 });
        const ct = String((r.headers && r.headers['content-type']) || '');
        if (!/^image\/(jpeg|png)/.test(ct)) continue;
        photo = { id: `hp:${src}`, url: src, name, mediaType: ct.split(';')[0], bytes: Buffer.from(r.data) };
        break;
      } catch (e) {
        console.warn(`[threads] CAFE_PHOTO_FAILED ${src} ${e.message}`);
      }
    }
    return photo;
  }

  /** OPEN 済みの新店の告知用: ギャラリーの先頭から取れる写真を最大 max 枚（jpg/png だけ） */
  async function fetchPhotos(images, name, max = MULTI_PHOTO_MAX) {
    const out = [];
    for (const src of (images || [])) {
      if (out.length >= max) break;
      if (badPhotos.has(src)) continue;
      try {
        const r = await client.get(src, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 8 * 1024 * 1024 });
        const ct = String((r.headers && r.headers['content-type']) || '');
        if (!/^image\/(jpeg|png)/.test(ct)) continue;
        out.push({ id: `hp:${src}`, url: src, name, mediaType: ct.split(';')[0], bytes: Buffer.from(r.data) });
      } catch (e) {
        console.warn(`[threads] CAFE_PHOTO_FAILED ${src} ${e.message}`);
      }
    }
    return out;
  }

  /** ふだんの回の写真: 最近使っていない店の HP の写真 1 枚（店名は投稿に書かない） */
  async function pickPhoto({ recentUrls = [] } = {}) {
    const { url, photo } = await pickStore({ recentUrls });
    return { url, photo };
  }

  /** 告知してよい新着記事（OPEN 日・終わりの日が近い順） */
  // include: 期間外でも告知する記事の URL（2026-10-29 社長「大垣の記事が反応いいので…高畑と安城と本陣もそれぞれ載せておいて」＝OPEN 後の店も）
  async function pendingAnnouncements(today, { include = [] } = {}) {
    let media = [];
    try { media = parseMediaList(await getText(MEDIA_URL)); } catch (e) { console.warn(`[threads] CAFE_MEDIA_LIST_FAILED ${e.message}`); } // 読めなくても新着の告知は止めない
    const items = [...parseNewsList(await getText(NEWS_URL)), ...media].filter((i) => isAnnounceable(i, today) || include.includes(i.url));
    return items.sort((a, b) => String(announcementDate(a) || a.date).localeCompare(String(announcementDate(b) || b.date)));
  }

  /** 記事の本文・店名・写真（店舗ページのギャラリー。開店前で無ければ null） */
  // multi: OPEN 済みの新店は写真を複数（カルーセル）にする（2026-10-29 社長）。取れたのが 1 枚以下なら photos は付けない
  async function announcement(item, { multi = false } = {}) {
    if (item.category === MEDIA_CATEGORY) {
      const m = parseMediaEntry(await getText(item.url));
      return { item, text: m.text, shopUrl: null, storeName: null, photo: null, kind: 'media', linkUrl: m.linkUrl }; // 写真は付けず、記事のリンクのカード（link_attachment）で見せる
    }
    const entry = parseNewsEntry(await getText(item.url));
    let storeName = (item.title.match(/「([^」]+)」/) || [])[1] || null;
    let photo = null;
    let photos = null;
    if (entry.shopUrl) {
      try {
        const facts = await storeFacts(entry.shopUrl);
        storeName = facts.name || storeName;
        const name = `HP: ${storeName || entry.shopUrl}`;
        if (multi) {
          const got = await fetchPhotos(facts.images, name);
          if (got.length >= 2) { photos = got; photo = got[0]; } else photo = got[0] || null;
        } else {
          photo = await fetchPhoto(facts.images, name);
        }
      } catch (e) { console.warn(`[threads] CAFE_ANNOUNCE_SHOP_FAILED ${entry.shopUrl} ${e.message}`); }
    }
    return { item, text: entry.text, shopUrl: entry.shopUrl, storeName, photo, ...(photos ? { photos } : {}), kind: ANNOUNCE_CATEGORIES[item.category] };
  }

  /** 店舗ページの公開日が新しい順に並べる。読めなければ一覧の順のまま */
  async function newestFirst(urls) {
    let rows;
    try {
      const r = await client.get(SHOP_API_URL, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (threads-bot)' } });
      rows = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    } catch (e) { console.warn(`[threads] CAFE_SHOP_DATES_FAILED ${e.message}`); return urls; }
    const date = new Map((Array.isArray(rows) ? rows : []).map((x) => [x.link, String(x.date || '')]));
    return urls.map((u, i) => ({ u, i, d: date.get(u) || '' })).sort((a, b) => b.d.localeCompare(a.d) || a.i - b.i).map((x) => x.u);
  }

  /** 新着情報で OPEN 日がまだ先の店の名前（空白を除く）。読めなければ空 */
  async function notYetOpen(today) {
    if (!today) return new Set();
    try {
      return new Set(parseNewsList(await getText(NEWS_URL))
        .filter((i) => ANNOUNCE_CATEGORIES[i.category] === 'newstore' && (announcementDate(i) || '') > today)
        .map((i) => (i.title.match(/「([^」]+)」/) || [])[1]).filter(Boolean).map(squash));
    } catch (e) { console.warn(`[threads] CAFE_NEWS_LIST_FAILED ${e.message}`); return new Set(); }
  }

  /** 既存店の紹介（2026-11-02 社長「既存店も順次」→「なるべく新しい順に 認知低いところを先に」）: 店舗ページの公開日が新しい順に、まだ紹介していない店（done・skip 以外）を 1 つ。
   * 開店前の店（新着情報の OPEN 日が today より後）は出さない。全店済みなら最初から（cycleDone） */
  async function nextShop({ done = [], skip = [], today = null, priority = [] } = {}) {
    const all = await newestFirst(await listStores());
    if (!all.length) throw new Error('selfcafe.jp の店舗一覧が読めない');
    const future = await notYetOpen(today);
    // 優先リスト（社長の指定。2026-11-04「売り上げがいまいちな北方を先に」「丸の内ももう一度」）: 紹介済み・skip に関係なく先に出す
    for (const u of (Array.isArray(priority) ? priority : [])) {
      let f;
      try { f = await storeFacts(u); } catch (e) { console.warn(`[threads] CAFE_SHOP_PRIORITY_FAILED ${u} ${e.message}`); continue; }
      if (future.has(squash(f.name))) continue;
      const got = await fetchPhotos(f.images, `HP: ${f.name || u}`);
      return { url: u, facts: f, storeName: f.name || null, photo: got[0] || null, ...(got.length >= 2 ? { photos: got } : {}), cycleDone: false, priority: true };
    }
    const usable = all.filter((u) => !skip.includes(u));
    const pool = usable.length ? usable : all;
    const fresh = pool.filter((u) => !done.includes(u));
    const cycleDone = !fresh.length;
    // ページが読めない店は飛ばして次へ（1 店の不調で一周が止まらないように）。全店だめなら投げる
    let url = null;
    let facts = null;
    let lastErr = null;
    for (const u of (cycleDone ? pool : fresh)) {
      let f;
      try { f = await storeFacts(u); } catch (e) { lastErr = e; console.warn(`[threads] CAFE_SHOP_PAGE_FAILED ${u} ${e.message}`); continue; }
      if (future.has(squash(f.name))) { console.log(`[threads] CAFE_SHOP_NOT_OPEN ${u}`); continue; }
      facts = f; url = u; break;
    }
    if (!url && !lastErr) return null; // 残りが開店前の店だけ: その日は既存店を休む（開けば翌日から）
    if (!url) throw lastErr;
    const storeName = facts.name || null;
    const got = await fetchPhotos(facts.images, `HP: ${storeName || url}`);
    return { url, facts, storeName, photo: got[0] || null, ...(got.length >= 2 ? { photos: got } : {}), cycleDone };
  }

  return { setBadPhotos, listStores, findStore, storeFacts, pickStore, pickPhoto, pendingAnnouncements, announcement, nextShop };
}

module.exports = { createCafeSite, parseStoreList, parseStoreNames, matchStore, parseStorePage, factsText, parseNewsList, parseNewsEntry, parseMediaList, parseMediaEntry, MEDIA_URL, announcementDate, isAnnounceable, SHOP_LIST_URL, NEWS_URL, ANNOUNCE_CATEGORIES };
