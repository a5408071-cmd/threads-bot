/**
 * 予約投稿（2026-11-02 社長「これを参考に明日投稿して」）。
 * /api/post に at（JST「YYYY-MM-DDTHH:mm」）を付けると threads_scheduled/<id> に預け、10分おきの見回り（/cron/tick）が時刻を過ぎたものを出す。
 * replyText があれば本投稿への返信として続けて出す（リンクは本文に入れず返信に置く＝外へ飛ばす投稿は表示されにくいため）。
 * 二重投稿を防ぐため、出す前にトランザクションで claimedAt を取る（見回りが重なっても片方だけ）。本投稿の後は postedAt・mediaId を先に残し、
 * 返信が失敗したら次の見回りで返信だけやり直す。
 */
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const STALE_MS = 15 * 60 * 1000;

/** JST の「YYYY-MM-DDTHH:mm」を時刻（ms）に。形が違う・存在しない日付（2/30 など）は NaN */
function atMs(at) {
  if (!AT_RE.test(String(at || ''))) return NaN;
  const ms = Date.parse(`${at}:00+09:00`);
  if (Number.isNaN(ms)) return NaN;
  const back = new Date(ms + 9 * 3600000).toISOString().slice(0, 16);
  return back === at ? ms : NaN;
}

async function add(store, { at, text, topicTag = null, linkUrl = null, replyText = null, source = 'scheduled' }) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return store.addScheduled({ id, at, text, topicTag, linkUrl, replyText, source, claimedAt: null, postedAt: null, mediaId: null, doneAt: null });
}

const list = (store) => store.listScheduled();

async function runDue({ store, threads, now = () => new Date() }) {
  const out = { posted: [], errors: [] };
  const due = (await store.listScheduled()).filter((x) => !x.doneAt && atMs(x.at) <= now().getTime());
  if (!due.length) return out;
  const token = await store.getToken();
  if (!token || !token.token) { out.errors.push('予約投稿: Threads の鍵が入っていません'); return out; }
  for (const x of due) {
    try {
      if (!(await store.claimScheduled(x.id, now().toISOString(), STALE_MS))) continue;
      let mediaId = x.mediaId;
      if (!mediaId) {
        const r = await threads.publishPost({ token: token.token, userId: token.userId, text: x.text, ...(x.topicTag ? { topicTag: x.topicTag } : {}), ...(x.linkUrl ? { linkAttachment: x.linkUrl } : {}) });
        if (!r.ok) { await store.updateScheduled(x.id, { claimedAt: null }); out.errors.push(`予約投稿 ${x.at} の投稿に失敗: ${r.error}`); continue; }
        mediaId = r.mediaId;
        const postedAt = now().toISOString();
        await store.updateScheduled(x.id, { mediaId, permalink: r.permalink || null, postedAt }); // 返信より先に残す（返信で落ちても本投稿を出し直さない）
        await store.savePost({ mediaId, text: x.text, type: 'manual', source: x.source, permalink: r.permalink || null, postedAt });
        out.posted.push({ at: x.at, permalink: r.permalink || null });
      }
      if (x.replyText) {
        const rr = await threads.publishPost({ token: token.token, userId: token.userId, text: x.replyText, replyToId: mediaId });
        if (!rr.ok) { await store.updateScheduled(x.id, { claimedAt: null }); out.errors.push(`予約投稿 ${x.at} の返信に失敗（次の見回りで返信だけやり直す）: ${rr.error}`); continue; }
        await store.updateScheduled(x.id, { replyId: rr.mediaId });
      }
      await store.updateScheduled(x.id, { doneAt: now().toISOString() });
    } catch (e) {
      out.errors.push(`予約投稿 ${x.at}: ${e.message}`);
    }
  }
  return out;
}

module.exports = { add, list, runDue, AT_RE, atMs };
