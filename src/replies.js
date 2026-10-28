/**
 * 返信（コメント）の取得と、社長 DM への知らせ・自動の返事。設計書 §5、2026-10-28 社長「イソが自動で」。
 * 直近 7 日の自分の投稿ごとに /{media-id}/replies を読み、threads_replies に無いものを新着として扱う。
 *   THREADS_AUTO_REPLY=true（かつ anthropic あり）: 新着ごとに AI が人物像で短い返事を書いて投稿（reply_to_id）。営業・荒らし・意味不明は「SKIP」で返事しない。
 *   それ以外: 1 通にまとめて知らせるだけ。
 * 初回（repliesInitialized が無い）は記録だけ。自分の返信は除く。知らせに失敗したら既読にしない。1 投稿の失敗は errors に残して他は続ける。
 */
const persona = require('./persona');

const LOOKBACK_DAYS = 7;
const TEXT_MAX = 100;
const REPLY_MAX = 200;
const REPLY_MODEL = 'claude-opus-5-5';

function createReplies({ threads, store, notify, now = () => new Date(), anthropic = null, env = process.env, persona: P = persona, label = '' }) {
  const cut = (s, n = TEXT_MAX) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const autoReply = () => env.THREADS_AUTO_REPLY === 'true' && Boolean(anthropic);

  /** コメントへの返事を AI に書かせる。SKIP なら null */
  async function draftReply({ comment, post }) {
    const res = await anthropic.messages.create({
      model: env.THREADS_MODEL || REPLY_MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: P.SYSTEM,
      messages: [{ role: 'user', content: [
        '自分の投稿に次のコメントが付きました。本人として、短い返事（1〜2 文、80 字以内。絵文字は 0〜1 個）を書いてください。',
        '相手の名前は書かない。感謝・共感・軽い問い返し・誘いへの前向きな返事。自分の投稿の繰り返しや宣伝はしない。',
        '営業・勧誘・スパム・荒らし・意味の分からないコメント・返事が不要な一言（スタンプだけ等）なら「SKIP」とだけ答える。',
        '',
        `自分の投稿: ${cut(post && post.text, 300)}`,
        `コメント（@${comment.username || '?'}）: ${cut(comment.text, 300)}`,
        '',
        '返事の本文だけを返す（「返事:」などの見出し・引用符なし）。',
      ].join('\n') }],
    });
    const raw = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const text = raw.replace(/^(返事|返信)\s*[:：]\s*/, '').replace(/^[「"]/, '').replace(/[」"]$/, '').trim();
    if (!text || /^skip$/i.test(text) || /^SKIP/.test(raw)) return null;
    return text.slice(0, REPLY_MAX);
  }

  async function poll({ token, userId }) {
    const out = { checked: 0, newReplies: 0, notified: 0, replied: 0, initialized: false, errors: [] };
    const sinceIso = new Date(now().getTime() - LOOKBACK_DAYS * 86400000).toISOString();
    const posts = await threads.listMyPosts({ token, sinceIso });
    const mine = new Map();
    try { for (const p of await store.recentPosts(60)) mine.set(p.mediaId, p); } catch (e) { /* 本文が無くても続ける */ }
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
        if (r.is_reply_owned_by_me || (r.from && String(r.from.id) === String(userId))) continue; // 自分の返信
        if (await store.seenReply(r.id)) continue;
        fresh.push({ ...r, post: { ...p, text: (mine.get(p.id) || {}).text || '' } });
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

    // 自動の返事
    const answers = new Map(); // replyId → { text, permalink } | null
    if (autoReply()) {
      for (const r of fresh) {
        let text = null;
        try { text = await draftReply({ comment: r, post: r.post }); } catch (e) { out.errors.push(`返事の生成に失敗（${r.id}）: ${e.message}`); }
        if (!text) { answers.set(r.id, null); continue; }
        const pub = await threads.publishReply({ token, userId, text, replyToId: r.id });
        if (pub.ok) { answers.set(r.id, { text, permalink: pub.permalink }); out.replied++; console.log(`[threads] AUTO_REPLIED to=${r.id}`); }
        else { answers.set(r.id, null); out.errors.push(`返事の投稿に失敗（${r.id}）: ${pub.error}`); }
      }
    }

    const lines = [`${label}💬 Threads にコメント ${fresh.length} 件${autoReply() ? `（返事 ${out.replied} 件）` : ''}`];
    for (const r of fresh) {
      lines.push(`・@${r.username || '?'}「${cut(r.text)}」`);
      if (autoReply()) {
        const a = answers.get(r.id);
        lines.push(a ? `  ↩ ${cut(a.text, 120)}` : '  ↩ （返事なし）');
      }
      lines.push(`  → ${r.post.permalink || r.permalink || ''}`);
    }
    const sent = await notify.owner(lines.join('\n'));
    if (!sent || !sent.ok) {
      out.errors.push(`コメントの知らせに失敗: ${(sent && sent.error) || '不明'}`);
      // 返事を投稿した分は二重に返さないよう既読にする
      for (const r of fresh) if (answers.get(r.id)) await store.markReplySeen(r.id, { postId: r.post.id, username: r.username, text: cut(r.text), notified: false, replied: true });
      return out;
    }
    for (const r of fresh) await store.markReplySeen(r.id, { postId: r.post.id, username: r.username, text: cut(r.text), notified: true, replied: Boolean(answers.get(r.id)) });
    out.notified = fresh.length;
    console.log(`[threads] REPLIES_NOTIFIED n=${fresh.length} replied=${out.replied}`);
    return out;
  }

  return { poll, draftReply };
}

module.exports = { createReplies, LOOKBACK_DAYS, TEXT_MAX, REPLY_MAX };
