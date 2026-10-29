/**
 * セルフカフェ公式アカウントの見回り（/cron/tick の中で趣味用のあとに走る。2026-10-28 社長「セルフカフェのいいところを毎日ポスト 画像はHPの画像」）。
 *   1 日 5 本（7〜9時・10:30〜12:30・13:30〜15:30・16:30〜18:30・19:30〜21:30）。ふだんは店名を出さない全店共通の話、新着の告知だけ店名入り（下の compose）。
 *   店舗ページの事実と写真（HP のギャラリー）で本文を書いて投稿する。写真は selfcafe.jp の URL をそのまま Meta に渡す。
 *   鍵がまだ無い（公式アカウントを接続していない）ときは黙って何もしない（趣味用の見回りを赤くしない）。
 *   社長 DM への写し・知らせは先頭に【公式】を付ける。
 */
const slots = require('./slots');
const personaCafe = require('./personaCafe');
const { daysLeft, REFRESH_BEFORE_DAYS } = require('./tick');

// 1 日 5 本（2026-10-29 社長「毎日5投稿いける」）。窓どうしを 90 分あけて、間隔の下限（slots の MIN_GAP_MIN）を必ず守れるようにしてある
const CAFE_WINDOWS = [
  { from: 7 * 60, to: 9 * 60 },
  { from: 10 * 60 + 30, to: 12 * 60 + 30 },
  { from: 13 * 60 + 30, to: 15 * 60 + 30 },
  { from: 16 * 60 + 30, to: 18 * 60 + 30 },
  { from: 19 * 60 + 30, to: 21 * 60 + 30 },
];
const RECENT_POSTS = 14;
const LABEL = '【公式】';
const CAFE_BANNED = ['鈴木大基', 'ウッドデザインパーク', 'wooddesignpark', 'wood-designpark'];
const TOKEN_ALERT_HOURS = 12;
const QUOTES_KEEP = 300; // 覚えておく名言の数
const QUOTES_IN_PROMPT = 80; // AI に見せる数（新しい方から）
const ANNOUNCE_DAYS = 3; // 同じ記事を何日続けて告知するか（CAFE_ANNOUNCE_DAYS で上書き）
const ANNOUNCE_PER_DAY = 2; // 1 日に告知する本数の上限（5 本のうち。CAFE_ANNOUNCE_PER_DAY）
// ふだんの回で店名・駅名を書いたら書き直し（写真の看板から拾うことがあるため。プロンプトだけに頼らない）
const STORE_NAME_RE = /セルフカフェ\s*[^\s、。！？!?「」]{1,12}店/;
const STATION_RE = /「[^」]+」駅|[一-龥ァ-ヶ][一-龥ぁ-んァ-ヶー]{0,7}駅/g; // 藤が丘駅・南柏駅・「栄」駅
const GENERIC_STATION_RE = /(最寄り?|主要|ターミナル|各|近く|大きな|乗換|乗り換え)駅$|[のはをにでとやも]/; // 一般語と、助詞をまたいだ取りすぎは除く
// 名言の回は「今日の名言は〇〇編」で始める（2026-10-29 社長「名言急に言い出すと変なので 今日は○○の編みたいな感じで始めようか」）
function quoteCheck(text) {
  if (!/^.{0,3}今日の名言は.{1,30}編/.test(String(text || '').trim())) return { ok: false, reason: '名言の回は 1 行目を「今日の名言は、〇〇（人の名前）編です。」で始める' };
  return noStoreCheck(text);
}

function noStoreCheck(text) {
  const s = String(text || '');
  const m = s.match(STORE_NAME_RE) || [...s.matchAll(STATION_RE)].find((x) => x[0].startsWith('「') || !GENERIC_STATION_RE.test(x[0]));
  return m ? { ok: false, reason: `ふだんの回なのに店名・駅名（${m[0]}）が入っている。特定の店・駅・地名は書かず全店共通の話にする` } : { ok: true };
}
const GENERAL_FACTS = '今回は特定の店を紹介しない回です。店名・駅名・地名・エリア名は書かない。個室ブース・会議室・会員専用エリア・コピー機は店によって無いので書かない。全店共通の事実（ドリンク 1 杯で時間無制限・Wi-Fi・電源・無人・月額のサブスク）の範囲で書く。写真から店名や場所を書かない。';

function pickCafeType(recentTypes, rng = Math.random) {
  const avoid = new Set((recentTypes || []).slice(0, 2));
  let pool = personaCafe.TYPES.filter((t) => !avoid.has(t));
  if (!pool.length) pool = personaCafe.TYPES.slice();
  pool = [...pool, ...pool.filter((t) => t === 'work' || t === 'study')]; // 仕事・勉強での使い方を 2 倍
  return pool[Math.floor(rng() * pool.length)];
}

async function runCafeTick({ env = process.env, store, threads, writer, notify, anthropic, site, now = () => new Date(), mode = 'live', replies = null, forcePost = false, forceType = null, draw = null }) {
  const t = now();
  const dateKey = slots.jstDateKey(t);
  const out = { ok: true, account: 'cafe', mode, dateKey, slots: null, due: null, posted: [], skipped: [], preview: null, token: null, replies: null, errors: [] };
  if (env.CAFE_ENABLED === 'false') return { ...out, disabled: true };
  const fail = (msg) => { out.errors.push(`${LABEL}${msg}`); out.ok = false; };
  const tell = async (text) => { try { await notify.owner(`${LABEL}${text}`); } catch (e) { console.error('[threads] CAFE_NOTIFY_THROW', e.message); } };

  let token = await store.getToken();
  const noToken = !token || !token.token;
  if (noToken && mode === 'live') return { ...out, noToken: true }; // まだ接続していない
  const left = noToken ? null : daysLeft(token.expiresAt, t);
  if (!noToken && !(left >= 0)) {
    fail('Threads の鍵が切れています');
    if (await store.alertDue('token-missing', TOKEN_ALERT_HOURS)) await tell('⚠ Threads の鍵が切れています。公式アカウントでログインしたブラウザで /oauth/start?account=cafe を開いて接続し直してください');
    return out;
  }
  if (!noToken) out.token = { daysLeft: left, refreshed: false, expiresAt: token.expiresAt };
  if (!noToken && left < REFRESH_BEFORE_DAYS) {
    try {
      const r = await threads.refreshToken(token.token);
      token = { ...token, token: r.token, expiresAt: r.expiresAt };
      await store.setToken(token);
      out.token = { daysLeft: daysLeft(r.expiresAt, t), refreshed: true, expiresAt: r.expiresAt };
    } catch (e) {
      fail(`鍵の更新に失敗: ${e.message}`);
      if (await store.alertDue('token-refresh', TOKEN_ALERT_HOURS)) await tell(`⚠ 鍵の更新に失敗しました（${e.message}）。残り ${left} 日`);
    }
  }

  const day = await store.ensureDay(dateKey, draw || (() => slots.drawSlots(dateKey, Math.random, { windows: CAFE_WINDOWS, oneLess: false })));
  out.slots = day.slots;
  const grace = Number(env.THREADS_SLOT_GRACE_MIN) || slots.DEFAULT_GRACE_MIN;
  const due = slots.dueSlot(day, t, { graceMin: grace });
  out.due = due;

  // 店名を出すのは公式サイトの新着（新店舗・キャンペーン）を告知する回だけ。1 日 1 本まで、同じ記事は 1 回（2026-10-29 社長）
  // 2026-10-29 社長「新店舗の情報は3日は続けて 文章は都度変更で」: 同じ記事を 1 日 1 回・ANNOUNCE_DAYS 日、告知は 1 日 ANNOUNCE_PER_DAY 本まで
  const announceDays = Number(env.CAFE_ANNOUNCE_DAYS) || ANNOUNCE_DAYS;
  const perDay = Number(env.CAFE_ANNOUNCE_PER_DAY) || ANNOUNCE_PER_DAY;
  const readAnnounced = async () => {
    const urls = ((await store.getConfig('announced')) || {}).urls || {};
    const out = {};
    for (const [u, v] of Object.entries(urls)) out[u] = !v ? { days: [], texts: [] } : typeof v === 'string' ? { days: [v], texts: [] } : Array.isArray(v) ? { days: v, texts: [] } : { days: v.days || [], texts: v.texts || [] }; // 旧形式（日付 1 つ・日付の並び）も読む
    return out;
  };
  const pickAnnouncement = async ({ force = false } = {}) => {
    if (env.CAFE_ANNOUNCE === 'false') return null;
    const done = await readAnnounced();
    const today = Object.values(done).filter((v) => v.days.includes(dateKey)).length;
    if (!force && today >= perDay) return null;
    const rec = (u) => done[u] || { days: [], texts: [] };
    const items = (await site.pendingAnnouncements(dateKey))
      .filter((i) => rec(i.url).days.length < announceDays && (force || !rec(i.url).days.includes(dateKey)))
      .map((i, k) => ({ i, k, started: rec(i.url).days.length > 0 }))
      .sort((x, y) => (Number(y.started) - Number(x.started)) || (x.k - y.k)) // 続き（2〜3 日目）を先に
      .map((x) => x.i);
    if (!items.length) return null;
    const a = await site.announcement(items[0]);
    return a && { ...a, round: rec(items[0].url).days.length + 1, previous: rec(items[0].url).texts };
  };
  const markAnnounced = async (url, text) => {
    const cur = await readAnnounced();
    const r = cur[url] || { days: [], texts: [] };
    cur[url] = { days: r.days.includes(dateKey) ? r.days : [...r.days, dateKey], texts: [...r.texts, text].slice(-announceDays) };
    await store.setConfig('announced', { urls: cur });
  };

  const compose = async () => {
    const recent = await store.recentPosts(RECENT_POSTS);
    const wantAnnounce = !forceType || personaCafe.ANNOUNCE_TYPES.includes(forceType);
    let a = null;
    if (wantAnnounce) {
      try { a = await pickAnnouncement({ force: Boolean(forceType) }); } catch (e) { console.warn(`[threads] CAFE_ANNOUNCE_FAILED ${e.message}`); }
    }
    if (forceType && personaCafe.ANNOUNCE_TYPES.includes(forceType) && !a) return { ok: false, reason: '告知できる新店舗・キャンペーンの記事が無い', type: forceType };
    if (a) {
      const type = a.kind || (a.item.category === 'キャンペーン' ? 'campaign' : 'newstore');
      const facts = [
        `今回は公式サイト（selfcafe.jp）の「${a.item.category}」の記事を告知する回です。ここにある事実だけを使う（無い設備・数字・料金・条件は書かない）。`,
        `- 見出し: ${a.item.title}`,
        `- 記事の日付: ${a.item.date}`,
        `- 本文:\n${a.text}`,
        `この記事の告知は ${a.round || 1} 回目（全 ${announceDays} 回）。${(a.round || 1) > 1 ? ((a.previous || []).length ? '前回までの告知文と、書き出し・切り口・取り上げる事実の順番・使い方の例・締めを変える（同じ文・同じ言い回しは使わない）:' : '前回の告知とは書き出し・切り口・使い方の例を変える（前回の文は残っていない）。') : '1 回目なので、何がいつどこで始まるかを分かりやすく。'}`,
        ...(a.previous || []).map((p, k) => `  前回${k + 1}: ${String(p).replace(/\n/g, ' ')}`),
      ].join('\n');
      const w = await writer.writePost({ type, recent: [...(a.previous || []), ...recent.map((p) => p.text)], dateKey, env, anthropic, photo: a.photo, persona: personaCafe, facts, banned: CAFE_BANNED });
      return { ...w, photo: a.photo, storeUrl: a.shopUrl, storeName: a.storeName, announceUrl: a.item.url };
    }
    const type = forceType || pickCafeType(recent.map((p) => p.type));
    const picked = await site.pickPhoto({ recentUrls: recent.map((p) => p.storeUrl).filter(Boolean) });
    let facts = GENERAL_FACTS;
    if (type === 'quote') {
      // 使った名言は二度と使わない（2026-10-29 見本で孔子・老子が続いた）
      const used = ((await store.getConfig('quotes')) || {}).used || [];
      facts += `\n名言は日本・海外の偉人、経営者・科学者・発明家・作家・スポーツ選手など幅広く選ぶ（孔子・老子のような定番ばかりにしない）。${used.length ? `\nこれまでに使った名言（同じ言葉は使わない。同じ人も直近 10 個に入っていれば避ける）:\n${used.slice(-QUOTES_IN_PROMPT).map((q) => `- ${q}`).join('\n')}` : ''}`;
    }
    const w = await writer.writePost({ type, recent: recent.map((p) => p.text), dateKey, env, anthropic, photo: picked.photo, persona: personaCafe, facts, banned: CAFE_BANNED, check: type === 'quote' ? quoteCheck : noStoreCheck });
    return { ...w, photo: picked.photo, storeUrl: picked.url, storeName: null };
  };

  const publish = async (w) => threads.publishPost({ token: token.token, userId: token.userId, text: w.text, ...(w.photo ? { imageUrl: w.photo.url } : {}), ...(w.tag ? { topicTag: w.tag } : {}) });
  const record = async (w, r, extra = {}) => {
    // 公開できたら先に告知済みにする（後の保存で落ちても同じ記事を二度出さない）
    if (w.announceUrl) { try { await markAnnounced(w.announceUrl, w.text); } catch (e) { fail(`告知済みの記録に失敗: ${e.message}`); } }
    if (w.type === 'quote') {
      const q = (String(w.text).match(/「[^」]{2,80}」。?[^。\n]{0,40}/) || [])[0];
      if (q) {
        try {
          const used = ((await store.getConfig('quotes')) || {}).used || [];
          await store.setConfig('quotes', { used: [...used, q].slice(-QUOTES_KEEP) });
        } catch (e) { fail(`名言の記録に失敗: ${e.message}`); }
      }
    }
    await store.savePost({ mediaId: r.mediaId, text: w.text, type: w.type, source: 'auto', permalink: r.permalink, postedAt: t.toISOString(), storeUrl: w.storeUrl, storeName: w.storeName, ...(w.tag ? { tag: w.tag } : {}), ...(w.photo ? { photoId: w.photo.id, photoName: w.photo.name } : {}), ...extra });
    out.posted.push({ mediaId: r.mediaId, permalink: r.permalink, type: w.type, store: w.storeName || '全店', ...(w.tag ? { tag: w.tag } : {}), ...extra });
    if (env.THREADS_COPY_TO_OWNER === 'true' || extra.manual) {
      await tell(`📝 投稿しました（${w.storeName || '全店'}・${w.type}${w.photo ? '・📷 HP' : ''}${w.tag ? `・#${w.tag}` : ''}）\n\n${w.text}\n\n→ ${r.permalink || '(リンク取得できず)'}`);
    }
  };

  if (mode === 'dry' || mode === 'test') {
    const w = await compose();
    if (!w.ok) { fail(`本文を作れなかった: ${w.reason}`); return out; }
    out.preview = { text: w.text, type: w.type, tag: w.tag || null, store: w.storeName || '全店', storeUrl: w.storeUrl, photoUrl: w.photo ? w.photo.url : null };
    if (mode === 'test') await tell(`（テスト。投稿はしていません）\n${w.storeName || '全店'}・型: ${w.type}\n\n${w.text}`);
    return out;
  }

  if (due && env.CAFE_AUTO_POST !== 'false') {
    const idx = due.index;
    const hm = day.slots[idx];
    if (due.status === 'late') {
      await store.markSkipped(dateKey, idx, `猶予超え（${hm}）`);
      out.skipped.push({ index: idx, reason: `猶予超え（${hm}）` });
    } else if (await store.claimSlot(dateKey, idx)) {
      let w = null;
      try { w = await compose(); } catch (e) { fail(`本文の生成でエラー: ${e.message}`); }
      if (!w || !w.ok) {
        const reason = w ? w.reason : '生成エラー';
        await store.markSkipped(dateKey, idx, reason);
        out.skipped.push({ index: idx, reason });
        await tell(`⚠ ${idx + 1} 本目（${hm}）は出せませんでした（${reason}）`);
      } else {
        const r = await publish(w);
        if (!r.ok) {
          await store.markSkipped(dateKey, idx, `投稿失敗: ${r.error}`);
          out.skipped.push({ index: idx, reason: `投稿失敗: ${r.error}` });
          fail(`投稿失敗（${r.stage}）: ${r.error}`);
          await tell(`⚠ ${idx + 1} 本目（${hm}）の投稿に失敗しました（${r.stage}: ${r.error}）`);
        } else {
          await store.markPosted(dateKey, idx, { mediaId: r.mediaId });
          await record(w, r, { index: idx });
          console.log(`[threads] CAFE_POSTED slot=${idx} type=${w.type} store=${w.storeName}`);
        }
      }
    }
  }

  if (forcePost && mode === 'live') {
    let w = null;
    try { w = await compose(); } catch (e) { fail(`本文の生成でエラー: ${e.message}`); }
    if (w && !w.ok) fail(`本文を作れなかった: ${w.reason}`);
    if (w && w.ok) {
      const r = await publish(w);
      if (!r.ok) fail(`投稿失敗（${r.stage}）: ${r.error}`);
      else await record(w, r, { manual: true });
    }
  }

  if (replies && !noToken && slots.jstHm(t).slice(3) < '10') {
    try { out.replies = await replies.poll({ token: token.token, userId: token.userId }); } catch (e) { fail(`返信の取得でエラー: ${e.message}`); }
  }
  return out;
}

module.exports = { runCafeTick, pickCafeType, noStoreCheck, quoteCheck, CAFE_WINDOWS, LABEL, CAFE_BANNED };
