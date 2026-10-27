/**
 * 投稿文を書く。型のローテーション（pickType）→ Claude に書かせる（writePost）→ 検査（checkText）。
 * 検査に落ちたら理由を添えて最大 2 回書き直させ、それでも落ちたら ok:false（その枠は呼ぶ側が飛ばす）。
 */
const persona = require('./persona');

const TYPES = ['question', 'aruaru', 'invite', 'season', 'small', 'hook'];
const MAX_ATTEMPTS = 3;
const MAX_CHARS = 500;
const MIN_CHARS = 120; // 短すぎる案は書き直させる（2026-10-27 社長「文章短すぎ！」）
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
  return pool[Math.floor(rng() * pool.length)];
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

function userPrompt({ type, recent, dateKey, reasons }) {
  const lines = [
    `今日: ${dateKey}（${WEEKDAYS[jstWeekday(dateKey)]}曜日）`,
    `型: ${type} … ${persona.TYPE_GUIDE[type] || ''}`,
  ];
  if (recent && recent.length) {
    lines.push('直近の投稿（言い回し・話題・書き出しを変える。同じ文は書かない）:');
    recent.forEach((r, i) => lines.push(`${i + 1}. ${String(r).replace(/\n/g, ' ')}`));
  }
  if (reasons && reasons.length) {
    lines.push(`前の案は次の理由で使えませんでした。直して書き直してください: ${reasons.join(' / ')}`);
  }
  lines.push('本文だけを返してください。');
  return lines.join('\n');
}

/**
 * @returns {Promise<{ok:true,text,type,attempts}|{ok:false,reason,type}>}
 */
async function writePost({ type, recent = [], dateKey, env = {}, anthropic }) {
  const banned = parseBanned(env);
  const model = env.THREADS_MODEL || DEFAULT_MODEL;
  const reasons = [];
  let lastReason = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await anthropic.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'medium' },
      system: persona.SYSTEM,
      messages: [{ role: 'user', content: userPrompt({ type, recent, dateKey, reasons }) }],
    });
    const raw = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const text = cleanOutput(raw);
    // 途中で切れた案（stop_reason=max_tokens）は空でなくても使わない
    const c = res.stop_reason === 'max_tokens' ? { ok: false, reason: '本文が途中で切れた（max_tokens）。短く書き直す' } : checkText(text, { banned, recent, minChars: MIN_CHARS });
    if (c.ok) return { ok: true, text, type, attempts: attempt };
    lastReason = c.reason;
    reasons.push(c.reason);
    console.warn(`[threads] WRITE_REJECTED attempt=${attempt} reason=${c.reason}`);
  }
  return { ok: false, reason: lastReason, type };
}

module.exports = { pickType, checkText, writePost, similarity, parseBanned, TYPES, MAX_CHARS, MIN_CHARS, DEFAULT_MODEL, DEFAULT_BANNED, MAX_TOKENS };
