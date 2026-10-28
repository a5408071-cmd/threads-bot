/**
 * 投稿文を書く。型のローテーション（pickType）→ Claude に書かせる（writePost）→ 検査（checkText）。
 * 検査に落ちたら理由を添えて最大 2 回書き直させ、それでも落ちたら ok:false（その枠は呼ぶ側が飛ばす）。
 */
const persona = require('./persona');

const TYPES = ['question', 'aruaru', 'invite', 'season', 'small', 'hook', 'daily', 'news'];
const NON_GOLF = ['daily', 'news']; // ゴルフ以外（2026-10-28 社長「ゴルフ以外の季節とか時事とか関係ない話も」）。重みを 2 倍にして 3 回に 1 回くらい
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
function pickType(recentTypes = [], date = new Date(), rng = Math.random) {
  const avoid = new Set((recentTypes || []).slice(0, 2));
  let pool = TYPES.filter((t) => !avoid.has(t));
  if (!pool.length) pool = TYPES.slice();
  const wd = jstWeekday(date);
  if ([5, 6, 0].includes(wd) && pool.includes('invite')) pool = [...pool, 'invite'];
  for (const t of NON_GOLF) if (pool.includes(t)) pool = [...pool, t];
  return pool[Math.floor(rng() * pool.length)];
}

/** 本文の最後の「タグ: 〇〇」を切り出す。# . & は落とす。無ければ型の既定 */
function splitTag(text, type) {
  const lines = String(text || '').split('\n');
  let tag = null;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
    const m = lines[i].match(/^\s*(?:タグ|tag|topic)\s*[:：]\s*(.+?)\s*$/i);
    if (m) { tag = m[1]; lines.splice(i, 1); break; }
  }
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const clean = tag ? tag.replace(/[#＃.&\s]/g, '').slice(0, TAG_MAX) : '';
  return { body, tag: clean || persona.DEFAULT_TAG[type] || 'ゴルフ' };
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

function userPrompt({ type, recent, dateKey, reasons, photo = null }) {
  const lines = [
    `今日: ${dateKey}（${WEEKDAYS[jstWeekday(dateKey)]}曜日）`,
    `型: ${type} … ${persona.TYPE_GUIDE[type] || ''}`,
  ];
  if (type === 'news') lines.push('まずウェブ検索で今日・今週の明るい話題（スポーツ・季節の行事・グルメ・流行）を確かめてから書く。政治・事件・事故・災害・訃報・不祥事は選ばない。');
  if (recent && recent.length) {
    lines.push('直近の投稿（言い回し・話題・書き出しを変える。同じ文は書かない）:');
    recent.forEach((r, i) => lines.push(`${i + 1}. ${String(r).replace(/\n/g, ' ')}`));
  }
  if (reasons && reasons.length) {
    lines.push(`前の案は次の理由で使えませんでした。直して書き直してください: ${reasons.join(' / ')}`);
  }
  lines.push(`長さ: ${photo ? LENGTH_WITH_PHOTO : LENGTH_TEXT_ONLY}`);
  lines.push('直近の投稿と同じ締め方（誘い・募集・一杯）や同じ自己紹介を繰り返さない。');
  lines.push('本文だけを返してください。');
  return lines.join('\n');
}

/**
 * @returns {Promise<{ok:true,text,type,attempts}|{ok:false,reason,type}>}
 */
/** 写真を添えるときの user content（画像ブロック＋指示） */
function userContent({ type, recent, dateKey, reasons, photo }) {
  const text = userPrompt({ type, recent, dateKey, reasons, photo });
  if (!photo || !photo.bytes) return text;
  return [
    { type: 'image', source: { type: 'base64', media_type: photo.mediaType || 'image/jpeg', data: Buffer.from(photo.bytes).toString('base64') } },
    { type: 'text', text: `${text}\n\nこの写真を添えて投稿します。写っているもの（景色・季節感・雰囲気・飲み物など）に合う文にしてください。ただし、いつ・どこで撮ったかは断定しない（「先週」「昨日」「〇〇カントリー」のように書かない。「こういう時間帯のコースが好き」のような言い方にする）。写真の説明文にはせず、あくまで人に話しかける投稿にする。` },
  ];
}

async function writePost({ type, recent = [], dateKey, env = {}, anthropic, photo = null }) {
  const banned = parseBanned(env);
  const model = env.THREADS_MODEL || DEFAULT_MODEL;
  const reasons = [];
  let lastReason = '';
  const isNews = type === 'news';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages = [{ role: 'user', content: userContent({ type, recent, dateKey, reasons, photo }) }];
    const req = { model, max_tokens: MAX_TOKENS, output_config: { effort: 'medium' }, system: persona.SYSTEM, messages };
    if (isNews) req.tools = [WEB_SEARCH_TOOL]; // 時事は検索で確かめる（作り話を防ぐ）
    let res = await anthropic.messages.create(req);
    // 検索の途中で止まった（pause_turn）ら、返ってきた content を assistant として足して続きを頼む
    for (let k = 0; k < MAX_CONTINUES && res.stop_reason === 'pause_turn'; k++) {
      messages.push({ role: 'assistant', content: res.content });
      res = await anthropic.messages.create({ ...req, messages });
    }
    const raw = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const { body, tag } = splitTag(cleanOutput(raw), type);
    const text = body;
    // 途中で切れた案（stop_reason=max_tokens）は空でなくても使わない
    const c = res.stop_reason === 'max_tokens' ? { ok: false, reason: '本文が途中で切れた（max_tokens）。短く書き直す' } : checkText(text, { banned, recent, minChars: photo ? MIN_CHARS : MIN_CHARS_TEXT_ONLY });
    if (c.ok) return { ok: true, text, type, attempts: attempt, tag };
    lastReason = c.reason;
    reasons.push(c.reason);
    console.warn(`[threads] WRITE_REJECTED attempt=${attempt} reason=${c.reason}`);
  }
  return { ok: false, reason: lastReason, type };
}

module.exports = { pickType, checkText, writePost, similarity, parseBanned, TYPES, MAX_CHARS, MIN_CHARS, DEFAULT_MODEL, DEFAULT_BANNED, MAX_TOKENS };
