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
  // 間隔。壊れた値（数でない・負）は既定に戻す（0 に倒すと毎回付いてしまう＝2026-11-03 レビュー）
  const n = Number(env.THREADS_BOARD_LINK_EVERY_DAYS);
  const everyDays = env.THREADS_BOARD_LINK_EVERY_DAYS === undefined || env.THREADS_BOARD_LINK_EVERY_DAYS === '' || !Number.isFinite(n) || n < 0 ? DEFAULT_EVERY_DAYS : n;
  let busy = false; // 同じプロセスで返信中（印を書く前の一瞬）にもう 1 本来たときの守り

  /**
   * 投稿が出た直後に呼ぶ。付けたら {ok:true, text}、付けなかったら {ok:false, skipped}。
   * 順番は「記録を読む → 先に印（lastAt）を書く → 返信 → 記録を仕上げる」。返信に失敗したら印を元に戻す。
   * 記録が読めないときは付けない（読めない間に投稿のたびに付くのを防ぐ）
   */
  async function maybeReply({ token, mediaId, type }) {
    if (!url) return { ok: false, skipped: 'off' };
    if (!LINK_TYPES.includes(type)) return { ok: false, skipped: 'type' };
    if (busy) return { ok: false, skipped: 'recent' };
    let c = null;
    try { c = await store.getConfig('boardLink'); } catch (e) { console.warn(`[threads] BOARD_LINK_READ_FAILED ${e.message}`); return { ok: false, skipped: 'config', error: e.message }; }
    const t = now();
    const lastMs = c && c.lastAt ? new Date(c.lastAt).getTime() : 0;
    if (lastMs && t.getTime() - lastMs < everyDays * 86400000) return { ok: false, skipped: 'recent', lastAt: c.lastAt };
    const count = (c && Number(c.count)) || 0;
    const text = TEMPLATES[count % TEMPLATES.length].replace('{url}', () => url);
    busy = true;
    try {
      try { await store.setConfig('boardLink', { ...(c || {}), lastAt: t.toISOString(), mediaId, pending: true, count }); } catch (e) { console.warn(`[threads] BOARD_LINK_CLAIM_FAILED ${e.message}`); return { ok: false, skipped: 'config', error: e.message }; }
      const r = await threads.publishReply({ token: token.token, userId: token.userId, text, replyToId: mediaId });
      if (!r.ok) {
        console.warn(`[threads] BOARD_LINK_FAILED media=${mediaId} ${r.error}`);
        try { await store.setConfig('boardLink', c || { count }); } catch (e) { console.warn(`[threads] BOARD_LINK_RESTORE_FAILED ${e.message}`); } // 印を戻す（次の投稿でまた付けられる）
        return { ok: false, error: r.error, stage: r.stage };
      }
      try { await store.setConfig('boardLink', { lastAt: t.toISOString(), mediaId, replyId: r.mediaId || null, count: count + 1 }); } catch (e) { console.warn(`[threads] BOARD_LINK_SAVE_FAILED ${e.message}`); } // 印は残っているので二重にはならない
      console.log(`[threads] BOARD_LINK media=${mediaId} reply=${r.mediaId} n=${count + 1}`);
      return { ok: true, mediaId, replyId: r.mediaId || null, permalink: r.permalink || null, text };
    } finally { busy = false; }
  }

  return { maybeReply };
}

/**
 * 掲示板をすすめる投稿（board 型・本文に「掲示板」）は本文の最後に掲示板のリンクを付ける
 * （2026-11-06 社長「これ系の投稿の時は掲示板のリンク置くようにして」。プロフィールのリンクは貼れていない＝11/03 のエラー）。
 * 「リンクはプロフィールに…」と書いていたら「下に」に直す。付けた投稿には返信のリンク（maybeReply）は付けない
 */
const POST_MAX = 500;
const PROFILE_RE = /リンクはプロフィール(?:欄)?に(?:置いてます|置いています|あります|貼ってます|貼っています)/g;
function inlineBoardUrl(w, env = process.env) {
  const url = env.THREADS_BOARD_URL === undefined ? DEFAULT_URL : String(env.THREADS_BOARD_URL || '').trim();
  if (!w || !w.ok || !url) return w;
  if (w.type !== 'board' && !/掲示板/.test(w.text || '')) return w;
  const text = `${String(w.text).replace(PROFILE_RE, 'リンクは下に貼っておきます').trimEnd()}\n\n▶ 掲示板 ${url}`;
  if ([...text].length > POST_MAX) return w; // Threads は 500 字まで。入らなければ今まで通り返信で添える
  return { ...w, text, linkUrl: url, boardInline: true };
}

module.exports = { createBoardLink, inlineBoardUrl, TEMPLATES, LINK_TYPES, DEFAULT_URL, DEFAULT_EVERY_DAYS };
