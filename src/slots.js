/**
 * 1日の投稿枠（時刻）。毎日ランダムに引いて、自動投稿っぽく見せない。
 *   1本目: 7:00〜13:30 / 2本目: 17:30〜23:00（分は 00・30 を避ける。2本は 3 時間以上あける）
 *   週に 1 回くらい（確率 1/7）は 1 本だけ。
 * 時刻はすべて JST（Cloud Run は UTC なので +9 時間ずらして getUTC* で読む）。
 */
const WINDOWS = [
  { from: 7 * 60, to: 13 * 60 + 30 },
  { from: 17 * 60 + 30, to: 23 * 60 },
];
const MIN_GAP_MIN = 180;
const ONE_POST_PROB = 1 / 7;
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
function drawSlots(dateKey, rng = Math.random) {
  if (rng() < ONE_POST_PROB) {
    const win = WINDOWS[rng() < 0.5 ? 0 : 1];
    return { slots: [toHm(pickInWindow(win, rng))] };
  }
  const a = pickInWindow(WINDOWS[0], rng);
  let b = pickInWindow(WINDOWS[1], rng);
  if (b - a < MIN_GAP_MIN) b = Math.min(WINDOWS[1].to, a + MIN_GAP_MIN + (b % 60 === 0 || b % 60 === 30 ? 1 : 0));
  return { slots: [toHm(a), toHm(b)].sort() };
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
  for (let i = 0; i < day.slots.length; i++) {
    if (done.has(i)) continue;
    const slotMin = toMin(day.slots[i]);
    if (nowMin < slotMin) continue;
    return { index: i, status: nowMin - slotMin > graceMin ? 'late' : 'due' };
  }
  return null;
}

module.exports = { drawSlots, dueSlot, jstDateKey, jstHm, WINDOWS, DEFAULT_GRACE_MIN };
