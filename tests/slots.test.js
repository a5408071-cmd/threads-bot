const { drawSlots, dueSlot, jstDateKey, jstHm } = require('../src/slots');

function seeded(seq) { let i = 0; return () => seq[i++ % seq.length]; }
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

test('4 本（2026-10-28 社長「毎日4投稿しよう」）: 朝 7:00〜10:00・昼 11:30〜14:30・夕 16:00〜19:00・夜 20:00〜23:30、分は 00 と 30 以外、昇順で 90 分以上あく', () => {
  let fours = 0;
  for (let k = 0; k < 300; k++) {
    const { slots } = drawSlots('2026-10-28', () => ((k * 0.37) + 0.13) % 1);
    expect(slots).toEqual([...slots].sort());
    for (const s of slots) expect([0, 30]).not.toContain(Number(s.split(':')[1]));
    for (let i = 1; i < slots.length; i++) expect(toMin(slots[i]) - toMin(slots[i - 1])).toBeGreaterThanOrEqual(90);
    if (slots.length < 4) continue;
    fours++;
    expect(toMin(slots[0])).toBeGreaterThanOrEqual(7 * 60); expect(toMin(slots[0])).toBeLessThanOrEqual(10 * 60);
    expect(toMin(slots[1])).toBeGreaterThanOrEqual(11 * 60 + 30); expect(toMin(slots[1])).toBeLessThanOrEqual(14 * 60 + 30);
    expect(toMin(slots[2])).toBeGreaterThanOrEqual(16 * 60); expect(toMin(slots[2])).toBeLessThanOrEqual(19 * 60);
    expect(toMin(slots[3])).toBeGreaterThanOrEqual(20 * 60); expect(toMin(slots[3])).toBeLessThanOrEqual(23 * 60 + 30);
  }
  expect(fours).toBeGreaterThan(200);
});

test('1/7 の日は 1 本少ない（3 本）、それ以外は 4 本', () => {
  expect(drawSlots('2026-10-28', seeded([0.05, 0.5, 0.5, 0.5, 0.5, 0.5])).slots).toHaveLength(3);
  expect(drawSlots('2026-10-28', seeded([0.9, 0.5, 0.5, 0.5, 0.5, 0.5])).slots).toHaveLength(4);
});

test('乱数を渡さなくても動く（Math.random）', () => {
  const { slots } = drawSlots('2026-10-28');
  expect(slots.length === 3 || slots.length === 4).toBe(true);
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
