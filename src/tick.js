/**
 * 10 分おきの見回り（Cloud Scheduler → /cron/tick）。設計書 §6。
 *   1. THREADS_ENABLED=false なら何もしない
 *   2. 今日の投稿枠が無ければ引く（毎日 0 時過ぎの最初の見回り）
 *   3. トークンの残り日数を見て、10 日を切っていれば延ばす。無ければ知らせる（12 時間に 1 回）
 *   4. 時刻を過ぎた未投稿の枠があれば、claim → 本文を書く → 投稿 → 記録（猶予 60 分を超えた枠は飛ばす）
 *   5. 分が 00〜09 のときだけ返信（コメント）を見に行く＝1 時間に 1 回
 * mode: live（本番）／dry（文を返すだけ）／test（文を社長 DM に送るだけ。claim も残さない）
 * 失敗を 0 件に見せない: errors に残し、呼ぶ側が 500 にする。
 */
const slots = require('./slots');
const { WEEKLY_DAY } = require('./growth');
const defaultWriter = require('./writer');

const RECENT_POSTS = 14;
const RECENT_TYPES = 2;
const PHOTO_EVERY = 4;
const STOCK_TYPES = ['daily', 'news', 'season', 'work', 'fitness']; // ゴルフ以外＝ストック写真（社長の写真はゴルフの型だけ）
const REFRESH_BEFORE_DAYS = 10;
const TOKEN_ALERT_HOURS = 12;

const daysLeft = (expiresAt, now) => Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 86400000);

async function runTick({ env = process.env, store, threads, writer = defaultWriter, notify, anthropic, now = () => new Date(), mode = 'live', replies = null, draw = null, photos = null, stock = null, growth = null, forcePhoto = false, forcePost = false, forceType = null }) {
  const t = now();
  const dateKey = slots.jstDateKey(t);
  const out = { ok: true, mode, dateKey, slots: null, due: null, posted: [], skipped: [], preview: null, token: null, replies: null, growth: null, autoPost: env.THREADS_AUTO_POST !== 'false', errors: [] };
  if (env.THREADS_ENABLED === 'false') return { ...out, disabled: true };

  const fail = (msg) => { out.errors.push(msg); out.ok = false; };
  const tell = async (text) => { try { await notify.owner(text); } catch (e) { console.error('[threads] NOTIFY_THROW', e.message); } };

  // 今日の枠
  const day = await store.ensureDay(dateKey, draw || (() => slots.drawSlots(dateKey)));
  out.slots = day.slots;

  // トークン
  let token = await store.getToken();
  const expiredOrBroken = token && token.token && !(daysLeft(token.expiresAt, t) >= 0); // 期限切れ・expiresAt 無し（NaN）も鍵が無いのと同じ扱い
  if (!token || !token.token || expiredOrBroken) {
    const why = expiredOrBroken ? '切れている' : '入っていない';
    fail(`Threads の鍵（トークン）が${why}`);
    if (expiredOrBroken) token = null;
    if (await store.alertDue('token-missing', TOKEN_ALERT_HOURS)) {
      await tell(`⚠ Threads の鍵が${why}ます。新しいアカウントでログインしたブラウザで threads-bot の /oauth/start を開いて接続し直してください（投稿は止まっています）`);
    }
  } else {
    const left = daysLeft(token.expiresAt, t);
    out.token = { daysLeft: left, refreshed: false, expiresAt: token.expiresAt };
    if (left < REFRESH_BEFORE_DAYS) {
      try {
        const r = await threads.refreshToken(token.token);
        token = { ...token, token: r.token, expiresAt: r.expiresAt };
        await store.setToken(token);
        out.token = { daysLeft: daysLeft(r.expiresAt, t), refreshed: true, expiresAt: r.expiresAt };
        console.log(`[threads] TOKEN_REFRESHED expires=${r.expiresAt}`);
      } catch (e) {
        fail(`鍵の更新に失敗: ${e.message}`);
        if (await store.alertDue('token-refresh', TOKEN_ALERT_HOURS)) {
          await tell(`⚠ Threads の鍵の更新に失敗しました（${e.message}）。残り ${left} 日。切れる前に /oauth/start を開いて取り直してください`);
        }
      }
    }
  }

  // 投稿枠
  const grace = Number(env.THREADS_SLOT_GRACE_MIN) || slots.DEFAULT_GRACE_MIN;
  const due = slots.dueSlot(day, t, { graceMin: grace });
  out.due = due;
  const canPost = Boolean(token && token.token);

  // 写真は PHOTO_EVERY（4）本に 1 本（直近 3 本に写真が無ければ付ける。2026-10-28 社長「写真そんなに在庫ないなー」→ 案1）。
  // ゴルフの型は社長の写真（Drive）、ゴルフ以外（日常・季節・時事）はストック写真（Pexels）。社長の写真が無ければゴルフもストックで代用。どれも取れなければ文字だけ
  const photoEvery = Number(env.THREADS_PHOTO_EVERY) || PHOTO_EVERY;
  const pickPersonal = async () => {
    if (!photos) return null;
    try { return await photos.pick(); } catch (e) { console.warn(`[threads] PHOTO_PICK_THROW ${e.message}`); return null; }
  };
  const pickStock = async (query, text) => {
    if (!stock || !query) return null;
    // AI に写真を見せて文に合うか確かめてから付ける（writer.photoFits が無ければ確かめない）
    const verify = writer.photoFits ? (p) => writer.photoFits({ text, bytes: p.bytes, mediaType: p.mediaType, env, anthropic }) : null;
    try { return await stock.search(query, { verify }); } catch (e) { console.warn(`[threads] STOCK_THROW ${e.message}`); return null; }
  };
  const compose = async () => {
    const recent = await store.recentPosts(RECENT_POSTS);
    let weights = null;
    if (growth) { try { weights = await growth.weightsFor(); } catch (e) { console.warn(`[threads] WEIGHTS_FAILED ${e.message}`); } }
    const type = forceType || writer.pickType(recent.slice(0, RECENT_TYPES).map((p) => p.type), t, Math.random, weights);
    const wantPhoto = forcePhoto || !recent.slice(0, photoEvery - 1).some((p) => p.photoId);
    const golf = !STOCK_TYPES.includes(type);
    let photo = wantPhoto && golf ? await pickPersonal() : null;
    const stockPhoto = wantPhoto && !photo; // 社長の写真が無い（またはゴルフ以外）→ 文を先に書いて検索語をもらう
    const w = await writer.writePost({ type, recent: recent.map((p) => p.text), dateKey, env, anthropic, photo, stockPhoto });
    if (w.ok && stockPhoto) {
      // 検索語は「a | b」で 2 つまで。a で見つからなければ b（日本独特の話題は海外のストックに無いことが多い）
      let s = null;
      for (const q of String(w.photoQuery || '').split('|').map((x) => x.trim()).filter(Boolean).slice(0, 2)) { s = await pickStock(q, w.text); if (s) break; }
      if (s) photo = { id: s.id, name: s.name, url: s.url, stock: true, page: s.page };
    }
    return { ...w, photo };
  };

  if (mode === 'dry' || mode === 'test') {
    // 文体の確認用。時刻や枠に関係なく 1 本書いて見せる（投稿も claim もしない）
    if (!canPost) return out;
    const w = await compose();
    if (!w.ok) { fail(`本文を作れなかった: ${w.reason}`); return out; }
    out.preview = { text: w.text, type: w.type, attempts: w.attempts, tag: w.tag || null, ...(w.photo ? { photo: w.photo.name, photoUrl: w.photo.url } : {}) };
    if (mode === 'test') await tell(`（テスト。投稿はしていません）\n型: ${w.type}\n\n${w.text}`);
    return out;
  }

  if (due && out.autoPost && canPost) {
    const idx = due.index;
    const hm = day.slots[idx];
    const n = idx + 1;
    if (due.status === 'late') {
      // claim 済みのまま猶予を超えた＝投稿の途中で止まった（打ち切り・デプロイ）。出ているかもしれないので「確認して」と書き分ける
      const wasClaimed = Array.isArray(day.claimed) && day.claimed.includes(idx);
      const reason = wasClaimed ? `投稿中に止まった可能性（${hm} の枠。Threads を確認）` : `猶予超え（${hm} の枠、${grace} 分）`;
      await store.markSkipped(dateKey, idx, reason);
      out.skipped.push({ index: idx, reason });
      await tell(wasClaimed
        ? `⚠ 今日の ${n} 本目（${hm}）は投稿の途中で止まった可能性があります。出ているか Threads を確認してください`
        : `⚠ 今日の ${n} 本目（${hm}）は時間が過ぎていたので出しませんでした`);
    } else if (await store.claimSlot(dateKey, idx)) {
      let w;
      try {
        w = await compose();
      } catch (e) {
        await store.markSkipped(dateKey, idx, `本文の生成でエラー: ${e.message}`);
        out.skipped.push({ index: idx, reason: `本文の生成でエラー: ${e.message}` });
        fail(`本文の生成でエラー: ${e.message}`);
        await tell(`⚠ 今日の ${n} 本目（${hm}）は本文を作れず出せませんでした（${e.message}）`);
        w = null;
      }
      if (w && !w.ok) {
        await store.markSkipped(dateKey, idx, w.reason);
        out.skipped.push({ index: idx, reason: w.reason });
        await tell(`⚠ 今日の ${n} 本目（${hm}）は出せませんでした（${w.reason}）`);
      } else if (w) {
        const r = await threads.publishPost({ token: token.token, userId: token.userId, text: w.text, ...(w.photo ? { imageUrl: w.photo.url } : {}), ...(w.tag ? { topicTag: w.tag } : {}) });
        if (!r.ok) {
          // 同じ枠を繰り返さない（release しない）。本当の失敗として返す
          await store.markSkipped(dateKey, idx, `投稿失敗: ${r.error}`);
          out.skipped.push({ index: idx, reason: `投稿失敗: ${r.error}` });
          fail(`投稿失敗（${r.stage}）: ${r.error}`);
          await tell(`⚠ 今日の ${n} 本目（${hm}）の投稿に失敗しました（${r.stage}: ${r.error}）`);
        } else {
          await store.markPosted(dateKey, idx, { mediaId: r.mediaId });
          await store.savePost({ mediaId: r.mediaId, text: w.text, type: w.type, source: 'auto', permalink: r.permalink, postedAt: t.toISOString(), ...(w.tag ? { tag: w.tag } : {}), ...(w.photo ? { photoId: w.photo.id, photoName: w.photo.name } : {}) });
          if (w.photo) { try { await store.markPhotoUsed(w.photo.id); } catch (e) { console.warn(`[threads] PHOTO_MARK_FAILED ${e.message}`); } }
          out.posted.push({ index: idx, mediaId: r.mediaId, permalink: r.permalink, type: w.type, ...(w.tag ? { tag: w.tag } : {}), ...(w.photo ? { photo: w.photo.name } : {}) });
          console.log(`[threads] POSTED slot=${idx} type=${w.type} media=${r.mediaId} chars=${w.text.length}`);
          if (env.THREADS_COPY_TO_OWNER === 'true') {
            await tell(`📝 Threads に投稿しました（${n} 本目・${w.type}${w.photo ? `・📷 ${w.photo.name}` : ''}${w.tag ? `・#${w.tag}` : ''}）\n\n${w.text}\n\n→ ${r.permalink || '(リンク取得できず)'}`);
          }
        }
      }
    } else {
      console.log(`[threads] SLOT_BUSY slot=${idx}`);
    }
  }

  // 今すぐ 1 本（/cron/tick?post=1。枠は消費しない。2026-10-27 社長「まず一本揚げてみて」）
  if (forcePost && mode === 'live' && canPost) {
    let w = null;
    try { w = await compose(); } catch (e) { fail(`本文の生成でエラー: ${e.message}`); }
    if (w && !w.ok) fail(`本文を作れなかった: ${w.reason}`);
    if (w && w.ok) {
      const r = await threads.publishPost({ token: token.token, userId: token.userId, text: w.text, ...(w.photo ? { imageUrl: w.photo.url } : {}), ...(w.tag ? { topicTag: w.tag } : {}) });
      if (!r.ok) {
        fail(`投稿失敗（${r.stage}）: ${r.error}`);
        await tell(`⚠ 今すぐの投稿に失敗しました（${r.stage}: ${r.error}）`);
      } else {
        await store.savePost({ mediaId: r.mediaId, text: w.text, type: w.type, source: 'auto', permalink: r.permalink, postedAt: t.toISOString(), ...(w.tag ? { tag: w.tag } : {}), manual: true, ...(w.photo ? { photoId: w.photo.id, photoName: w.photo.name } : {}) });
        if (w.photo) { try { await store.markPhotoUsed(w.photo.id); } catch (e) { console.warn(`[threads] PHOTO_MARK_FAILED ${e.message}`); } }
        out.posted.push({ index: null, manual: true, mediaId: r.mediaId, permalink: r.permalink, type: w.type, ...(w.tag ? { tag: w.tag } : {}), ...(w.photo ? { photo: w.photo.name } : {}) });
        console.log(`[threads] POSTED manual type=${w.type} media=${r.mediaId} chars=${w.text.length}`);
        await tell(`📝 Threads に投稿しました（手動・${w.type}${w.photo ? `・📷 ${w.photo.name}` : ''}${w.tag ? `・#${w.tag}` : ''}）\n\n${w.text}\n\n→ ${r.permalink || '(リンク取得できず)'}`);
      }
    }
  }

  // 成長の仕組み（毎朝 7:00〜7:09 の見回りで数字を記録、月曜は週次の分析と報告）
  if (growth && canPost && mode === 'live') {
    const hm = slots.jstHm(t);
    if (hm >= '07:00' && hm < '07:10') {
      out.growth = {};
      try { out.growth.daily = await growth.daily(token); } catch (e) { fail(`数字の記録でエラー: ${e.message}`); }
      const wd = new Date(t.getTime() + 9 * 3600 * 1000).getUTCDay();
      if (wd === WEEKLY_DAY) {
        try { out.growth.weekly = await growth.weekly(token); } catch (e) { fail(`週次の分析でエラー: ${e.message}`); }
      }
    }
  }

  // 返信（1 時間に 1 回）
  if (replies && canPost && slots.jstHm(t).slice(3) < '10') {
    try {
      out.replies = await replies.poll({ token: token.token, userId: token.userId });
    } catch (e) {
      fail(`返信の取得でエラー: ${e.message}`);
    }
  }

  return out;
}

module.exports = { runTick, daysLeft, RECENT_POSTS, REFRESH_BEFORE_DAYS };
