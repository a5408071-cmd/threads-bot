/**
 * 投稿文を書く。型のローテーション（pickType）→ Claude に書かせる（writePost）→ 検査（checkText）。
 * 検査に落ちたら理由を添えて最大 2 回書き直させ、それでも落ちたら ok:false（その枠は呼ぶ側が飛ばす）。
 */
const persona = require('./persona');

const TYPES = ['question', 'aruaru', 'invite', 'season', 'small', 'hook', 'work', 'fitness', 'daily', 'news', 'countdown', 'koyomi', 'tips'];
const NON_GOLF = ['work', 'fitness', 'daily', 'news']; // ゴルフ以外（2026-10-28 社長「ゴルフ以外も」「経営者らしく」「マラソン・ジム」）。重みを 2 倍にして半分くらい
// ウェブ検索で事実を確かめてから書く型（2026-10-29 社長「試験の残り何日」「暦」「継続のコツ へえーってなる」を追加）
const SEARCH_TYPES = ['news', 'countdown', 'koyomi', 'tips', 'quote']; // quote（偉人の名言）は公式アカウントだけの型
const COUNTDOWN_MAX_DAYS = 400;
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };
const MAX_CONTINUES = 3; // pause_turn（検索の続き）の上限
const TAG_MAX = 50;
const MAX_ATTEMPTS = 3;
const MAX_CHARS = 500;
const MIN_CHARS = 120; // 写真ありの最低字数（2026-10-27 社長「文章短すぎ！」）
const MIN_CHARS_TEXT_ONLY = 80; // 写真なしは短めでシンプルに（2026-10-28 社長「2つに1回は画像なしで文字だけシンプルに」）
const LENGTH_WITH_PHOTO = '150〜300字・3〜6文';
const LENGTH_TEXT_ONLY = '100〜180字・2〜4文。写真が無い回なのでシンプルに、言いたいことを1つに絞る';
const SIMILARITY_LIMIT = 0.6;
const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 8000; // thinking の分も数えられるので小さいと本文が途中で切れる（iso-bot の中部経済新聞で 3000〜8000 で切れた実績）
// 環境変数が空でも必ず止める語（会社名・本名・店名）。設定し忘れひとつで会社とのつながりが出ないように
const DEFAULT_BANNED = ['ウッドデザインパーク', 'wooddesignpark', 'wood-designpark', 'WDP', 'セルフカフェ', 'selfcafe', '鈴木大基', 'カキダオレ'];
const URL_RE = /(https?:\/\/|www\.)/i;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function jstWeekday(dateKeyOrDate) {
  const d = dateKeyOrDate instanceof Date ? new Date(dateKeyOrDate.getTime() + 9 * 3600 * 1000) : new Date(`${dateKeyOrDate}T00:00:00Z`);
  return d.getUTCDay();
}

/** 直近 2 本の型を避けて 1 つ選ぶ。金土日は invite の重みを 2 倍 */
/**
 * 直近 2 本の型を避けて 1 つ選ぶ。weights（型→重み。週次の分析で更新）があればそれで、無ければ既定（金土日は誘い型 3 倍、ゴルフ以外 2 倍）
 */
function pickType(recentTypes = [], date = new Date(), rng = Math.random, weights = null) {
  const avoid = new Set((recentTypes || []).slice(0, 2));
  let pool = [];
  if (weights && typeof weights === 'object') {
    for (const t of TYPES) {
      const w = Math.max(0, Math.round(Number(weights[t]) || 0));
      if (avoid.has(t)) continue;
      for (let i = 0; i < w; i++) pool.push(t);
    }
    if (!pool.length) for (const t of TYPES) { const w = Math.max(0, Math.round(Number(weights[t]) || 0)); for (let i = 0; i < w; i++) pool.push(t); }
  }
  if (!pool.length) {
    pool = TYPES.filter((t) => !avoid.has(t));
    if (!pool.length) pool = TYPES.slice();
    const wd = jstWeekday(date);
    if ([5, 6, 0].includes(wd) && pool.includes('invite')) pool = [...pool, 'invite', 'invite']; // 金土日は誘い型を 3 倍に
    for (const t of NON_GOLF) if (pool.includes(t)) pool = [...pool, t];
  }
  return pool[Math.floor(rng() * pool.length)];
}

/** 本文の最後の「タグ: 〇〇」を切り出す。# . & は落とす。無ければ型の既定 */
function splitTag(text, type, P = persona) {
  const lines = String(text || '').split('\n').filter((l, i, a) => l.trim() || a.slice(i).some((x) => x.trim())); // 末尾の空行は窓に数えない
  let tag = null; let photoQuery = null; let targetDate = null;
  // 末尾 4 行のうち「タグ: 〇〇」「写真: <検索語>」を取り出す（どちらも 1 行ずつ）
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 5; i--) {
    if (!lines[i].trim()) continue; // 空行は窓に数えない
    seen++;
    const d = lines[i].match(/^\s*(?:日付|date)\s*[:：]\s*(\d{4}-\d{2}-\d{2})\s*$/i);
    if (d && targetDate == null) { targetDate = d[1]; lines.splice(i, 1); continue; }
    const m = lines[i].match(/^\s*(?:タグ|tag|topic)\s*[:：]\s*(.+?)\s*$/i);
    if (m && tag == null) { tag = m[1]; lines.splice(i, 1); continue; }
    const p = lines[i].match(/^\s*(?:写真|photo|image)\s*[:：]\s*(.+?)\s*$/i);
    if (p && photoQuery == null) { photoQuery = p[1].replace(/[#＃"「」]/g, '').trim().slice(0, 80); lines.splice(i, 1); }
  }
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const clean = tag ? tag.replace(/[#＃.&\s]/g, '').slice(0, TAG_MAX) : '';
  return { body, tag: clean || (P.DEFAULT_TAG || {})[type] || (P.FALLBACK_TAG || 'ゴルフ'), photoQuery, targetDate };
}

/**
 * 残り日数は AI に数えさせない: 本文の {N} を「日付:」の日までの日数（dateKey＝JST の今日から）に置き換える。
 * 数字で「残り80日」と書いた・{N} なのに日付が無い／過去・遠すぎる は書き直し。
 */
const N_RE = /[{｛]\s*[NＮnｎ]\s*[}｝]/g;
const BRACE_RE = /[{｛][^}｝]*[}｝]/;
function fillCountdown(body, targetDate, dateKey, type = 'countdown') {
  // 数字で数えた残り日数は countdown 型だけ止める（他の型の「週末まであと2日」は通す）
  if (type === 'countdown' && /(残り|あと)\s*[0-9０-９〇一二三四五六七八九十百]+\s*(日|週|か月|ヶ月|カ月|ヵ月)/.test(body)) return { ok: false, reason: '残り日数を数字で書いている（数字は書かずに {N} と書き、タグの前に「日付: YYYY-MM-DD」を 1 行）' };
  let text = body;
  if (body.search(N_RE) >= 0) {
    if (!targetDate) return { ok: false, reason: '{N} があるのに「日付: YYYY-MM-DD」の行が無い' };
    const days = Math.round((Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${dateKey}T00:00:00Z`)) / 86400000);
    if (!(days >= 1 && days <= COUNTDOWN_MAX_DAYS)) return { ok: false, reason: `「日付: ${targetDate}」が今日（${dateKey}）より後の ${COUNTDOWN_MAX_DAYS} 日以内ではない` };
    text = body.replace(N_RE, String(days));
  }
  // {N日} などの崩れた置き場所が残ったまま公開しない（全部の型）
  if (BRACE_RE.test(text)) return { ok: false, reason: '本文に { } が残っている（残り日数は {N} だけで書く）' };
  return { ok: true, text };
}

function norm(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ''); } // 全角・半角の違い（ＷＤＰ・ｾﾙﾌ）も当てる

function bigrams(s) {
  const t = norm(s);
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** 2-gram の Jaccard 類似度 */
function similarity(a, b) {
  const x = bigrams(a); const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}

function parseBanned(env = {}) {
  const extra = String(env.THREADS_BANNED_WORDS || '').split(/[;,\n]/).map((s) => s.trim()).filter(Boolean);
  return [...new Set([...DEFAULT_BANNED, ...extra])];
}

/** @returns {{ok:true}|{ok:false, reason:string}} */
function checkText(text, { banned = [], recent = [], minChars = 0 } = {}) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: '本文が空' };
  if (t.length > MAX_CHARS) return { ok: false, reason: `${MAX_CHARS}字超（${t.length}字）` };
  if (minChars && t.length < minChars) return { ok: false, reason: `短すぎる（${t.length}字。${minChars}字以上・3〜6文で）` }; // 自動投稿だけ（社長の一言＝/api/post には掛けない）
  if (URL_RE.test(t)) return { ok: false, reason: 'URLが入っている' };
  if (/(^|\s)[#＃]\S/.test(t)) return { ok: false, reason: '本文に #ハッシュタグ が入っている（タグは「タグ: 〇〇」の行で 1 つだけ）' };
  const n = norm(t);
  for (const w of banned) {
    if (w && n.includes(norm(w))) return { ok: false, reason: `NG語: ${w}` };
  }
  for (const r of recent) {
    if (similarity(t, r) >= SIMILARITY_LIMIT) return { ok: false, reason: '直近の投稿と似すぎ' };
  }
  return { ok: true };
}

/** 返りの前後の引用符・「投稿:」の見出しを剥がす */
function cleanOutput(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^(投稿文?|本文)\s*[:：]\s*/i, '').trim();
  // 本文全体を引用符で包んでいるときだけ剥がす（「…」で始まる文の先頭を削らない。2026-10-27 の見本で発生）
  const pairs = [['「', '」'], ['『', '』'], ['"', '"'], ['“', '”']];
  for (const [open, close] of pairs) {
    if (t.startsWith(open) && t.endsWith(close) && t.indexOf(close) === t.length - close.length) { t = t.slice(open.length, -close.length).trim(); break; }
  }
  return t;
}

function userPrompt({ type, recent, dateKey, reasons, photo = null, stockPhoto = false, P = persona, facts = null }) {
  const lines = [
    `今日: ${dateKey}（${WEEKDAYS[jstWeekday(dateKey)]}曜日）`,
    `型: ${type} … ${P.TYPE_GUIDE[type] || ''}`,
  ];
  if (type === 'news') lines.push('まずウェブ検索で今日・今週の明るい話題（スポーツ・季節の行事・グルメ・流行）を確かめてから書く。政治・事件・事故・災害・訃報・不祥事は選ばない。');
  if (type === 'countdown') lines.push('まずウェブ検索で、今日から見て近づいている試験・行事（日商簿記・宅建・行政書士・FP・中小企業診断士・社労士・大学入学共通テスト・年末年始 など）と、いま話題になっているものを確かめ、1 つ選んで正式な日付を確かめる。直近の投稿と同じ試験・行事は避ける。残り日数を書くときは数字を書かずに {N} と書き（例: 共通テストまで残り{N}日）、タグの行の前に「日付: YYYY-MM-DD」（その試験・行事の当日）を 1 行書く。日数は投稿側で計算して入れる。日付が確かめられなければ日数は書かない。');
  if (type === 'koyomi') lines.push('まずウェブ検索で、今日・今週の暦（二十四節気・七十二候・雑節・旧暦の月の名前・記念日・年中行事）を確かめ、1 つ選んで由来や意味の「へえー」となる話を短く添える。日付と名前は検索で確かめたものだけ書く。');
  if (type === 'quote') lines.push('まずウェブ検索で、名言が本当にその人の言葉か（出典）を確かめる。確かめられない・諸説ある言葉は使わず別の名言にする。名言は検索で見つけた原文（日本語の言葉はその人の言い方、外国の言葉は広く知られた訳）のとおりに「」で引き、言い換え・要約しない。いつ・どこで言ったかは確かめられたときだけ書く。直近の投稿と同じ人・同じ言葉は避ける。');
  if (type === 'tips') lines.push('必要ならウェブ検索で確かめる。研究や本の話を出すときは、よく知られていて検索で確かめられたものだけにし、細かい数字や人名に自信が無ければぼかす（「〜という研究があるらしい」）。');
  if (recent && recent.length) {
    lines.push('直近の投稿（言い回し・話題・書き出しを変える。同じ文は書かない）:');
    recent.forEach((r, i) => lines.push(`${i + 1}. ${String(r).replace(/\n/g, ' ')}`));
  }
  if (reasons && reasons.length) {
    lines.push(`前の案は次の理由で使えませんでした。直して書き直してください: ${reasons.join(' / ')}`);
  }
  lines.push(`長さ: ${photo ? LENGTH_WITH_PHOTO : LENGTH_TEXT_ONLY}`);
  lines.push('直近の投稿と同じ締め方（誘い・募集・一杯）や同じ自己紹介を繰り返さない。');
  if (stockPhoto) lines.push('この投稿には、あとから写真サイト（Pixabay）で探した本物の写真を 1 枚付けます。本文の内容に合う写真を探す英語の検索語（2〜4 語。例: roasted sweet potato autumn / autumn golf course morning / highball glass bar）を、タグの行の前に「写真: <文の主役を表す検索語> | <同じ主役の別の言い方>」の 1 行で書いてください（2 つを | で区切る。1 つ目で見つからなければ 2 つ目。どちらも文の**主役**を表す語にする。例: hawaii beach sunrise | waikiki ocean palm trees ／ morning run city sunrise | runner sunrise road）。写真サイトは海外のものが中心なので、2 つ目は雰囲気寄り（例: morning run city sunrise / rooftop bar night / modern office desk coffee）にする。キラキラして前向きな雰囲気の写真になる語を選ぶ（生活感のある料理・台所は避ける）。本文は写真の説明にはしない。');
  lines.push('本文だけを返してください。');
  return lines.join('\n');
}

/**
 * @returns {Promise<{ok:true,text,type,attempts}|{ok:false,reason,type}>}
 */
/** 写真を添えるときの user content（画像ブロック＋指示） */
function userContent({ type, recent, dateKey, reasons, photo, stockPhoto, P = persona, facts = null }) {
  let text = userPrompt({ type, recent, dateKey, reasons, photo, stockPhoto, P });
  if (facts) text = `${facts}

${text}`;
  if (!photo || !photo.bytes) return text;
  return [
    { type: 'image', source: { type: 'base64', media_type: photo.mediaType || 'image/jpeg', data: Buffer.from(photo.bytes).toString('base64') } },
    { type: 'text', text: `${text}\n\nこの写真を添えて投稿します。写っているもの（景色・季節感・雰囲気・飲み物など）に合う文にしてください。ただし、いつ・どこで撮ったかは断定しない（「先週」「昨日」「〇〇カントリー」のように書かない。「こういう時間帯のコースが好き」のような言い方にする）。写真の説明文にはせず、あくまで人に話しかける投稿にする。` },
  ];
}

async function writePost({ type, recent = [], dateKey, env = {}, anthropic, photo = null, stockPhoto = false, persona: P = persona, facts = null, banned: bannedOverride = null, check: extraCheck = null }) {
  const banned = bannedOverride || parseBanned(env);
  const model = env.THREADS_MODEL || DEFAULT_MODEL;
  const reasons = [];
  let lastReason = '';
  const useSearch = SEARCH_TYPES.includes(type);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages = [{ role: 'user', content: userContent({ type, recent, dateKey, reasons, photo, stockPhoto, P, facts }) }];
    const req = { model, max_tokens: MAX_TOKENS, output_config: { effort: 'medium' }, system: P.SYSTEM, messages };
    if (useSearch) req.tools = [WEB_SEARCH_TOOL]; // 時事・試験日・暦・研究の話は検索で確かめる（作り話を防ぐ）
    let res = await anthropic.messages.create(req);
    // 検索の途中で止まった（pause_turn）ら、返ってきた content を assistant として足して続きを頼む
    for (let k = 0; k < MAX_CONTINUES && res.stop_reason === 'pause_turn'; k++) {
      messages.push({ role: 'assistant', content: res.content });
      res = await anthropic.messages.create({ ...req, messages });
    }
    const raw = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const { body, tag, photoQuery, targetDate } = splitTag(cleanOutput(raw), type, P);
    const cd = fillCountdown(body, targetDate, dateKey, type);
    const text = cd.ok ? cd.text : body;
    // 途中で切れた案（stop_reason=max_tokens）は空でなくても使わない
    let c = res.stop_reason === 'max_tokens' ? { ok: false, reason: '本文が途中で切れた（max_tokens）。短く書き直す' } : (!cd.ok ? cd : checkText(text, { banned, recent, minChars: photo ? MIN_CHARS : MIN_CHARS_TEXT_ONLY }));
    if (c.ok && extraCheck) c = extraCheck(text) || { ok: true }; // 呼ぶ側の追加の検査（公式のふだんの回で店名・駅名を出さない など）
    if (c.ok) return { ok: true, text, type, attempts: attempt, tag, ...(stockPhoto && photoQuery ? { photoQuery } : {}) };
    lastReason = c.reason;
    reasons.push(c.reason);
    console.warn(`[threads] WRITE_REJECTED attempt=${attempt} reason=${c.reason}`);
  }
  return { ok: false, reason: lastReason, type };
}

const FIT_MODEL = 'claude-haiku-5-5'; // 写真が文に合うかの yes/no（安いモデルで十分）

/** ストック写真が本文に合うか（yes/no）。曖昧・失敗は false（合わない扱い＝写真なしで出す方が安全） */
async function photoFits({ text, bytes, mediaType = 'image/jpeg', env = {}, anthropic }) {
  try {
    const res = await anthropic.messages.create({
      model: env.THREADS_FIT_MODEL || FIT_MODEL,
      max_tokens: 1500, // Haiku 5.5 も考える工程が出力枠に入る（50 だと答えが空になった＝2026-10-28 実測）
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(bytes).toString('base64') } },
        { type: 'text', text: `次の投稿文に添える写真として、この写真を使ってよいですか？ 投稿は「前向きでキラキラした30代経営者」のアカウントです。条件は 2 つ: (1) 文の主役（ハワイの話なら海や街、ランの話なら走る風景、仕事の話ならオフィスや街の朝）と写真の中身が合っている（脇役の一語だけに合わせた写真は no）。(2) 明るく、前向きで、見ていて気持ちいい写真である（暗い・地味・接写すぎて何か分からない・生活感のある台所や料理のアップ・人の顔が大きい・文字や広告入り は no）。両方満たせば yes、どちらか欠ければ no。\n\n投稿文:\n${text}\n\n答えは yes か no の 1 語だけ（日本語なら はい／いいえ）。` },
      ] }],
    });
    const out = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim().toLowerCase();
    const fits = /^(yes|はい|合う|合います|ok|使える|使えます)/.test(out.replace(/^[\s「"'*]+/, ''));
    console.log(`[threads] PHOTO_FIT answer="${out.slice(0, 40)}" fits=${fits}`);
    return fits;
  } catch (e) {
    console.warn(`[threads] PHOTO_FIT_FAILED ${e.message}`);
    return false;
  }
}

module.exports = { pickType, checkText, writePost, photoFits, similarity, parseBanned, fillCountdown, TYPES, SEARCH_TYPES, MAX_CHARS, MIN_CHARS, DEFAULT_MODEL, DEFAULT_BANNED, MAX_TOKENS, FIT_MODEL };
