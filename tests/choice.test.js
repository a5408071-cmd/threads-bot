const writer = require('../src/writer');
const persona = require('../src/persona');
const cafe = require('../src/personaCafe');

// ゴルフの投稿は2択の問いかけ中心（2026-11-03 社長。反応があったのは「景色重視派？スコア重視派？」の型だけだった）
const W = { question: 2, aruaru: 1, invite: 1, season: 1, small: 1, hook: 1, work: 2, fitness: 2, daily: 1, news: 1, koyomi: 1, tips: 1 };

test('pickType: ゴルフの投稿（誘いを除く）の半分くらいが問いかけ。2本前が問いかけでも選べる（直前が問いかけなら避ける）', () => {
  const GOLF = ['question', 'aruaru', 'season', 'small', 'hook'];
  let q = 0; let golf = 0; const N = 2000;
  for (let i = 0; i < N; i++) { const x = writer.pickType(['work', 'question'], new Date('2026-11-04T00:00:00Z'), () => (i + 0.5) / N, W); if (GOLF.includes(x)) golf++; if (x === 'question') q++; }
  expect(q / golf).toBeGreaterThan(0.4); expect(q / golf).toBeLessThan(0.6);
  for (let i = 0; i < 200; i++) expect(writer.pickType(['question', 'work'], new Date('2026-11-04T00:00:00Z'), () => (i + 0.5) / 200, W)).not.toBe('question');
});

test('ゴルフの型（あるある等）は締めを2択の問いかけに。公式アカウントには付けない', () => {
  const p = writer.userPrompt({ type: 'aruaru', recent: [], dateKey: '2026-11-04', reasons: [], P: persona });
  expect(p).toMatch('2択');
  expect(writer.userPrompt({ type: 'question', recent: [], dateKey: '2026-11-04', reasons: [], P: persona })).toMatch('2択');
  expect(writer.userPrompt({ type: 'work', recent: [], dateKey: '2026-11-04', reasons: [], P: persona })).not.toMatch('2択');
  const t = Object.keys(cafe.TYPE_GUIDE)[0];
  expect(writer.userPrompt({ type: t, recent: [], dateKey: '2026-11-04', reasons: [], P: cafe })).not.toMatch('2択');
});

test('pickType: 週次の分析で question の重みが 0 なら問いかけを増やさない', () => {
  for (let i = 0; i < 200; i++) expect(writer.pickType(['work', 'fitness'], new Date('2026-11-04T00:00:00Z'), () => (i + 0.5) / 200, { ...W, question: 0 })).not.toBe('question');
});

test('pickType: 重みに question が無い・丸めて 0 の回も問いかけを増やさない', () => {
  const { question, ...noQ } = W;
  for (let i = 0; i < 200; i++) {
    expect(writer.pickType(['work', 'fitness'], new Date('2026-11-04T00:00:00Z'), () => (i + 0.5) / 200, noQ)).not.toBe('question');
    expect(writer.pickType(['work', 'fitness'], new Date('2026-11-04T00:00:00Z'), () => (i + 0.5) / 200, { ...W, question: 0.3 })).not.toBe('question');
  }
});
