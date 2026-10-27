const { drawSlots, dueSlot, jstDateKey, jstHm } = require('../src/slots');

function seeded(seq) { let i = 0; return () => seq[i++ % seq.length]; }
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

test('2 本のときは 1 本目 7:00〜13:30、2 本目 17:30〜23:00、分は 00 と 30 以外、3 時間以上あく', () => {
  let twos = 0;
  for (let k = 0; k < 300; k++) {
    const { slots } = drawSlots('2026-10-28', () => ((k * 0.37) + 0.13) % 1);
    expect(slots).toEqual([...slots].sort());
    if (slots.length === 1) continue;
    twos++;
    const [a, b] = slots;
    expect(toMin(a)).toBeGreaterThanOrEqual(7 * 60);
    expect(toMin(a)).toBeLessThanOrEqual(13 * 60 + 30);
    expect(toMin(b)).toBeGreaterThanOrEqual(17 * 60 + 30);
    expect(toMin(b)).toBeLessThanOrEqual(23 * 60);
    expect([0, 30]).not.toContain(Number(a.split(':')[1]));
    expect([0, 30]).not.toContain(Number(b.split(':')[1]));
    expect(toMin(b) - toMin(a)).toBeGreaterThanOrEqual(180);
  }
  expect(twos).toBeGreaterThan(200);
});

test('1 本だけの日が 1/7 くらい（乱数の先頭が 1/7 未満のとき）', () => {
  const one = drawSlots('2026-10-28', seeded([0.05, 0.5, 0.5, 0.5, 0.5])).slots;
  expect(one).toHaveLength(1);
  expect(/^\d{2}:\d{2}$/.test(one[0])).toBe(true);
  expect(drawSlots('2026-10-28', seeded([0.9, 0.5, 0.5, 0.5, 0.5])).slots).toHaveLength(2);
});

test('乱数を渡さなくても動く（Math.random）', () => {
  const { slots } = drawSlots('2026-10-28');
  expect(slots.length === 1 || slots.length === 2).toBe(true);
});

test('dueSlot: 時刻前は null、過ぎたら due、投稿済みは飛ばす、猶予を超えた枠は late', () => {
  const day = { dateKey: '2026-10-28', slots: ['09:17', '20:41'], posted: [] };
  const at = (hm) => new Date(`2026-10-28T${hm}:00+09:00`);
  expect(dueSlot(day, at('09:00'))).toBeNull();
  expect(dueSlot(day, at('09:20'))).toEqual({ index: 0, status: 'due' });
  expect(dueSlot({ ...day, posted: [{ index: 0 }] }, at('09:20'))).toBeNull();
  expect(dueSlot(day, at('10:30'))).toEqual({ index: 0, status: 'late' });
  expect(dueSlot(day, at('10:30'), { graceMin: 120 })).toEqual({ index: 0, status: 'due' });
  expect(dueSlot({ ...day, posted: [{ index: 0 }] }, at('20:45'))).toEqual({ index: 1, status: 'due' });
  expect(dueSlot({ ...day, posted: [{ index: 0 }, { index: 1 }] }, at('23:00'))).toBeNull();
});

test('dueSlot: 別の日の day には触れない（日付が違えば null）', () => {
  const day = { dateKey: '2026-10-27', slots: ['09:17'], posted: [] };
  expect(dueSlot(day, new Date('2026-10-28T09:20:00+09:00'))).toBeNull();
});

test('jstDateKey と jstHm は UTC の夜でも JST の翌日', () => {
  expect(jstDateKey(new Date('2026-10-27T16:05:00Z'))).toBe('2026-10-28');
  expect(jstHm(new Date('2026-10-27T16:05:00Z'))).toBe('01:05');
});
