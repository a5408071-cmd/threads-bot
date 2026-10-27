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
const defaultWriter = require('./writer');

const RECENT_POSTS = 14;
const RECENT_TYPES = 2;
const REFRESH_BEFORE_DAYS = 10;
const TOKEN_ALERT_HOURS = 12;

const daysLeft = (expiresAt, now) => Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 86400000);

async function runTick({ env = process.env, store, threads, writer = defaultWriter, notify, anthropic, now = () => new Date(), mode = 'live', replies = null, draw = null, photos = null, forcePhoto = false }) {
  const t = now();
  const dateKey = slots.jstDateKey(t);
  const out = { ok: true, mode, dateKey, slots: null, due: null, posted: [], skipped: [], preview: null, token: null, replies: null, autoPost: env.THREADS_AUTO_POST !== 'false', errors: [] };
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

  // 写真（本物の写真を Drive からランダムに。取れなければ写真なしで続ける）
  const pickPhoto = async () => {
    if (!photos || (!forcePhoto && !photos.shouldAttach())) return null;
    try { return await photos.pick(); } catch (e) { console.warn(`[threads] PHOTO_PICK_THROW ${e.message}`); return null; }
  };
  const compose = async () => {
    const recent = await store.recentPosts(RECENT_POSTS);
    const type = writer.pickType(recent.slice(0, RECENT_TYPES).map((p) => p.type), t);
    const photo = await pickPhoto();
    const w = await writer.writePost({ type, recent: recent.map((p) => p.text), dateKey, env, anthropic, photo });
    return { ...w, photo };
  };

  if (mode === 'dry' || mode === 'test') {
    // 文体の確認用。時刻や枠に関係なく 1 本書いて見せる（投稿も claim もしない）
    if (!canPost) return out;
    const w = await compose();
    if (!w.ok) { fail(`本文を作れなかった: ${w.reason}`); return out; }
    out.preview = { text: w.text, type: w.type, attempts: w.attempts, ...(w.photo ? { photo: w.photo.name, photoUrl: w.photo.url } : {}) };
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
        const r = await threads.publishPost({ token: token.token, userId: token.userId, text: w.text, ...(w.photo ? { imageUrl: w.photo.url } : {}) });
        if (!r.ok) {
          // 同じ枠を繰り返さない（release しない）。本当の失敗として返す
          await store.markSkipped(dateKey, idx, `投稿失敗: ${r.error}`);
          out.skipped.push({ index: idx, reason: `投稿失敗: ${r.error}` });
          fail(`投稿失敗（${r.stage}）: ${r.error}`);
          await tell(`⚠ 今日の ${n} 本目（${hm}）の投稿に失敗しました（${r.stage}: ${r.error}）`);
        } else {
          await store.markPosted(dateKey, idx, { mediaId: r.mediaId });
          await store.savePost({ mediaId: r.mediaId, text: w.text, type: w.type, source: 'auto', permalink: r.permalink, postedAt: t.toISOString(), ...(w.photo ? { photoId: w.photo.id, photoName: w.photo.name } : {}) });
          if (w.photo) { try { await store.markPhotoUsed(w.photo.id); } catch (e) { console.warn(`[threads] PHOTO_MARK_FAILED ${e.message}`); } }
          out.posted.push({ index: idx, mediaId: r.mediaId, permalink: r.permalink, type: w.type, ...(w.photo ? { photo: w.photo.name } : {}) });
          console.log(`[threads] POSTED slot=${idx} type=${w.type} media=${r.mediaId} chars=${w.text.length}`);
          if (env.THREADS_COPY_TO_OWNER === 'true') {
            await tell(`📝 Threads に投稿しました（${n} 本目・${w.type}${w.photo ? `・📷 ${w.photo.name}` : ''}）\n\n${w.text}\n\n→ ${r.permalink || '(リンク取得できず)'}`);
          }
        }
      }
    } else {
      console.log(`[threads] SLOT_BUSY slot=${idx}`);
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
