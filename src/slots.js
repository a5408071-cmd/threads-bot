/**
 * 1日の投稿枠（時刻）。毎日ランダムに引いて、自動投稿っぽく見せない。
 *   1本目: 7:00〜13:30 / 2本目: 17:30〜23:00（分は 00・30 を避ける。2本は 3 時間以上あける）
 *   週に 1 回くらい（確率 1/7）は 1 本だけ。
 * 時刻はすべて JST（Cloud Run は UTC なので +9 時間ずらして getUTC* で読む）。
 */
// 1 日 4 本（2026-10-28 社長「毎日4投稿しよう」）: 朝・昼・夕・夜
const WINDOWS = [
  { from: 7 * 60, to: 10 * 60 },
  { from: 11 * 60 + 30, to: 14 * 60 + 30 },
  { from: 16 * 60, to: 19 * 60 },
  { from: 20 * 60, to: 23 * 60 + 30 },
];
const MIN_GAP_MIN = 90;
const ONE_LESS_PROB = 1 / 7; // 週に 1 回くらい 1 本少ない日（人間っぽいムラ）
const DEFAULT_GRACE_MIN = 60;

function jst(now) { return new Date(now.getTime() + 9 * 3600 * 1000); }
const pad = (n) => String(n).padStart(2, '0');

function jstDateKey(now = new Date()) {
  const j = jst(now);
  return `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}`;
}
function jstHm(now = new Date()) {
  const j = jst(now);
  return `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
}
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const toHm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** 窓の中の分を引く。00・30 分は避ける */
function pickInWindow(win, rng) {
  for (let i = 0; i < 20; i++) {
    const v = win.from + Math.floor(rng() * (win.to - win.from + 1));
    if (v % 60 !== 0 && v % 60 !== 30) return v;
  }
  return win.from + 7; // 乱数が偏っても止まらないように
}

/** @returns {{slots: string[]}} 'HH:MM' の昇順 */
function drawSlots(dateKey, rng = Math.random, { windows: base = WINDOWS, oneLess = true } = {}) {
  let windows = base;
  if (oneLess && base.length > 1 && rng() < ONE_LESS_PROB) {
    const drop = Math.floor(rng() * base.length);
    windows = base.filter((_, i) => i !== drop);
  }
  const out = [];
  for (const win of windows) {
    let v = pickInWindow(win, rng);
    const prev = out[out.length - 1];
    if (prev != null && v - prev < MIN_GAP_MIN) {
      v = Math.min(win.to, prev + MIN_GAP_MIN);
      if (v % 60 === 0 || v % 60 === 30) v = Math.min(win.to, v + 1);
    }
    out.push(v);
  }
  return { slots: out.map(toHm) };
}

/**
 * 時刻を過ぎた未投稿の枠（最初の 1 つ）。
 * @returns {{index:number, status:'due'|'late'}|null} 猶予（graceMin）を超えていれば late
 */
function dueSlot(day, now = new Date(), { graceMin = DEFAULT_GRACE_MIN } = {}) {
  if (!day || !Array.isArray(day.slots)) return null;
  if (day.dateKey && day.dateKey !== jstDateKey(now)) return null;
  const nowMin = toMin(jstHm(now));
  const done = new Set((day.posted || []).map((p) => p.index));
  // 時刻の早い順に見る（/admin/add-slots で後から足した枠は index が大きくても時刻が早いことがある）
  const order = day.slots.map((s, i) => i).sort((a, b) => toMin(day.slots[a]) - toMin(day.slots[b]) || a - b);
  for (const i of order) {
    if (done.has(i)) continue;
    const slotMin = toMin(day.slots[i]);
    if (nowMin < slotMin) continue;
    return { index: i, status: nowMin - slotMin > graceMin ? 'late' : 'due' };
  }
  return null;
}

module.exports = { drawSlots, dueSlot, jstDateKey, jstHm, WINDOWS, DEFAULT_GRACE_MIN };
