/**
 * 掲示板（みんなの参加ボード）のリンクを、数日に 1 回、自分の投稿の返信欄に添える。
 * 2026-11-03 社長「よかったら掲示板書き込み待ってるキャラで行こう」→ リンクの出し方は「プロフィール欄＋数日に1回、投稿の返信欄に添える」で合意。
 * 本文には URL を書かない（Threads は本文のリンクで伸びにくい。persona の禁止事項にもある）。返信は AI を通さず定型文を順番に使う。
 *   対象の型: honolulu・board・fitness（ゴルフや時事の投稿には付けない）
 *   間隔: THREADS_BOARD_LINK_EVERY_DAYS（既定 3 日）。0 で毎回
 *   行き先: THREADS_BOARD_URL（既定 ホノルル2026 の掲示板。空文字で止める）
 *   記録: threads_config/boardLink { lastAt, mediaId, count }
 */
const LINK_TYPES = ['honolulu', 'board', 'fitness'];
const DEFAULT_URL = 'https://nakamaboard.com/honolulu-2026';
const DEFAULT_EVERY_DAYS = 3;
const TEMPLATES = [
  '掲示板はこちら👇 ニックネームだけで書けます。\n{url}',
  '同じ大会に出る人の掲示板です。意気込み、待ってます！\n{url}',
  '一人参加の人も、初参加の人も。気軽に書き込んでください🌺\n{url}',
  '書き込みを読むのが毎日の楽しみです。よかったらぜひ！\n{url}',
];

function createBoardLink({ store, threads, env = process.env, now = () => new Date() }) {
  const url = env.THREADS_BOARD_URL === undefined ? DEFAULT_URL : String(env.THREADS_BOARD_URL || '').trim();
  const everyDays = env.THREADS_BOARD_LINK_EVERY_DAYS === undefined || env.THREADS_BOARD_LINK_EVERY_DAYS === '' ? DEFAULT_EVERY_DAYS : Math.max(0, Number(env.THREADS_BOARD_LINK_EVERY_DAYS) || 0);

  /** 投稿が出た直後に呼ぶ。付けたら {ok:true, text}、付けなかったら {ok:false, skipped} */
  async function maybeReply({ token, mediaId, type }) {
    if (!url) return { ok: false, skipped: 'off' };
    if (!LINK_TYPES.includes(type)) return { ok: false, skipped: 'type' };
    let c = null;
    try { c = await store.getConfig('boardLink'); } catch (e) { console.warn(`[threads] BOARD_LINK_READ_FAILED ${e.message}`); }
    const t = now();
    const lastMs = c && c.lastAt ? new Date(c.lastAt).getTime() : 0;
    if (lastMs && t.getTime() - lastMs < everyDays * 86400000) return { ok: false, skipped: 'recent', lastAt: c.lastAt };
    const count = (c && Number(c.count)) || 0;
    const text = TEMPLATES[count % TEMPLATES.length].replace('{url}', url);
    const r = await threads.publishReply({ token: token.token, userId: token.userId, text, replyToId: mediaId });
    if (!r.ok) { console.warn(`[threads] BOARD_LINK_FAILED media=${mediaId} ${r.error}`); return { ok: false, error: r.error, stage: r.stage }; }
    await store.setConfig('boardLink', { lastAt: t.toISOString(), mediaId, replyId: r.mediaId || null, count: count + 1 });
    console.log(`[threads] BOARD_LINK media=${mediaId} reply=${r.mediaId} n=${count + 1}`);
    return { ok: true, mediaId, replyId: r.mediaId || null, permalink: r.permalink || null, text };
  }

  return { maybeReply };
}

module.exports = { createBoardLink, TEMPLATES, LINK_TYPES, DEFAULT_URL, DEFAULT_EVERY_DAYS };
