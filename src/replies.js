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

function createReplies({ threads, store, notify, now = () => new Date(), anthropic = null, env = process.env, persona: P = persona, label = '', guideLinks = null }) {
  const cut = (s, n = TEXT_MAX) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const autoReply = () => env.THREADS_AUTO_REPLY === 'true' && Boolean(anthropic);

  /** 公式: 案内先の一覧（キー→{url,label}）。投稿が店の記事ならその店のページを store として足す */
  function linksFor(post) {
    if (!guideLinks) return null;
    const links = { ...guideLinks };
    if (post && post.storeUrl) links.store = { url: post.storeUrl, label: `${post.storeName || 'この店'}のページ` };
    return links;
  }

  /** [LINK:キー] を URL に置き換え、一覧に無い URL・キーは消す。リンクは末尾に 1 行で（最初の 1 つだけ） */
  function applyLinks(text, links) {
    const allowed = new Set(Object.values(links).map((l) => l.url));
    let url = null;
    let body = text.replace(/\[LINK:([a-z_]+)\]/gi, (m, key) => {
      const own = (k) => (Object.prototype.hasOwnProperty.call(links, k) ? links[k] : null);
      const l = own(key) || (key === 'store' ? own('top') : null);
      if (l && !url) url = l.url;
      return '';
    });
    // URL は ASCII の範囲だけ（「…/faq/をご覧ください」の日本語を食わない）。末尾の句読点・括弧は URL に含めない
    body = body.replace(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]+/g, (m) => {
      const u = m.replace(/[.,!?;:']+$/, '');
      if (allowed.has(u) && !url) url = u;
      return m.slice(u.length);
    });
    body = body.replace(/[ \t　]+$/gm, '').replace(/\n{2,}/g, '\n').trim();
    return { body, url };
  }

  /** コメントへの返事を AI に書かせる。SKIP なら null */
  async function draftReply({ comment, post }) {
    const links = linksFor(post);
    const guide = links ? [
      '',
      '質問（料金・営業時間・場所・使い方・サブスク・予約など）や、事実が分からず答えにくいコメントには、分かる範囲でひと言答え、最後に「[LINK:キー]」を 1 つだけ付けて HP へ案内する（数字・営業時間・設備は書かずリンクに任せる）。',
      '答えにくいコメント（不満・トラブル・個別の事情）も SKIP にせず、ていねいに受け止めて HP（お問い合わせ）へ案内する。ただの感想・あいさつにはリンクを付けない。URL は書かない。',
      '案内先（キー: 中身）:',
      ...Object.entries(links).map(([k, l]) => `  LINK:${k}: ${l.label}`),
    ] : [];
    const res = await anthropic.messages.create({
      model: env.THREADS_MODEL || REPLY_MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: P.SYSTEM,
      messages: [{ role: 'user', content: [
        '自分の投稿に次のコメントが付きました。本人として、短い返事（1〜2 文、80 字以内。絵文字は 0〜1 個）を書いてください。',
        '相手の名前は書かない。感謝・共感・軽い問い返し・誘いへの前向きな返事。自分の投稿の繰り返しや宣伝はしない。',
        '営業・勧誘・スパム・荒らし・意味の分からないコメント・返事が不要な一言（スタンプだけ等）なら「SKIP」とだけ答える。',
        ...guide,
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
    if (!links) return text.slice(0, REPLY_MAX);
    const { body, url } = applyLinks(text, links);
    if (!body) return null;
    return url ? `${body.slice(0, REPLY_MAX)}\n${url}` : body.slice(0, REPLY_MAX);
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
        { const m = mine.get(p.id) || {}; fresh.push({ ...r, post: { ...p, text: m.text || '', storeUrl: m.storeUrl, storeName: m.storeName } }); }
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
