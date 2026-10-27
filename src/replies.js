/**
 * 返信（コメント）の取得と社長 DM への知らせ。設計書 §5。
 * 直近 7 日の自分の投稿ごとに /{media-id}/replies を読み、threads_replies に無いものを新着として 1 通にまとめて知らせる。
 * 初回（repliesInitialized が無い）は記録だけ（過去のコメントを一度にドンと知らせない）。
 * 自分の返信は除く。知らせに失敗したら既読にしない（次回また知らせる）。1 投稿の失敗は errors に残して他は続ける。
 * Webhook は App Review が要るので使わない（テスターの自分のアカウントならこれで読める見込み。読めなければこの機能ごと落とす＝設計書 §5）。
 */
const LOOKBACK_DAYS = 7;
const TEXT_MAX = 100;

function createReplies({ threads, store, notify, now = () => new Date() }) {
  const cut = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t; };

  async function poll({ token, userId }) {
    const out = { checked: 0, newReplies: 0, notified: 0, initialized: false, errors: [] };
    const sinceIso = new Date(now().getTime() - LOOKBACK_DAYS * 86400000).toISOString();
    const posts = await threads.listMyPosts({ token, sinceIso });
    const fresh = [];
    for (const p of posts) {
      out.checked++;
      let list;
      try {
        list = await threads.listReplies({ token, mediaId: p.id });
      } catch (e) {
        out.errors.push(`投稿 ${p.id} の返信が読めない: ${e.message}`);
        continue;
      }
      for (const r of list) {
        if (!r || !r.id) continue;
        if (r.is_reply_owned_by_me || (r.from && String(r.from.id) === String(userId))) continue; // 自分の返信（API の is_reply_owned_by_me）
        if (await store.seenReply(r.id)) continue;
        fresh.push({ ...r, post: p });
      }
    }
    out.newReplies = fresh.length;

    const initialized = await store.getConfig('repliesInitialized');
    if (!initialized) {
      for (const r of fresh) await store.markReplySeen(r.id, { postId: r.post.id, username: r.username, text: cut(r.text), notified: false });
      await store.setConfig('repliesInitialized', { at: now().toISOString(), seeded: fresh.length });
      out.initialized = true;
      console.log(`[threads] REPLIES_INIT seeded=${fresh.length}`);
      return out;
    }
    if (!fresh.length) return out;

    const lines = [`💬 Threads にコメント ${fresh.length} 件`];
    for (const r of fresh) {
      lines.push(`・@${r.username || '?'}「${cut(r.text)}」`);
      lines.push(`  → ${r.post.permalink || r.permalink || ''}`);
    }
    const sent = await notify.owner(lines.join('\n'));
    if (!sent || !sent.ok) {
      out.errors.push(`コメントの知らせに失敗: ${(sent && sent.error) || '不明'}`);
      return out;
    }
    for (const r of fresh) await store.markReplySeen(r.id, { postId: r.post.id, username: r.username, text: cut(r.text), notified: true });
    out.notified = fresh.length;
    console.log(`[threads] REPLIES_NOTIFIED n=${fresh.length}`);
    return out;
  }

  return { poll };
}

module.exports = { createReplies, LOOKBACK_DAYS, TEXT_MAX };
