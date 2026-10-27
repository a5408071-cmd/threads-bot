const { pickType, checkText, writePost, TYPES } = require('../src/writer');

function fakeAnthropic(texts) {
  let i = 0;
  return { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: texts[i++] }], stop_reason: 'end_turn' })) } };
}

test('pickType は直近 2 本の型を避ける', () => {
  for (let i = 0; i < 50; i++) {
    const t = pickType(['question', 'aruaru'], new Date('2026-10-28T03:00:00Z'), Math.random);
    expect(TYPES).toContain(t);
    expect(['question', 'aruaru']).not.toContain(t);
  }
});

test('pickType は金曜・土曜・日曜は invite が出やすい（1000 回で 2 割超）', () => {
  let n = 0;
  for (let i = 0; i < 1000; i++) if (pickType([], new Date('2026-10-30T03:00:00Z'), Math.random) === 'invite') n++; // 10/30 は金曜
  expect(n).toBeGreaterThan(200);
});

test('checkText: 500 字超・URL・NG 語・似すぎ・空は落ちる', () => {
  expect(checkText('あ'.repeat(501)).ok).toBe(false);
  expect(checkText('詳しくは https://example.com').ok).toBe(false);
  expect(checkText('詳しくは www.example.com まで').ok).toBe(false);
  expect(checkText('ウッドデザインパークのゴルフ会', { banned: ['ウッドデザインパーク'] })).toEqual({ ok: false, reason: 'NG語: ウッドデザインパーク' });
  expect(checkText('wood designpark のゴルフ会', { banned: ['Wood DesignPark'] }).ok).toBe(false); // 大文字小文字・空白は無視
  const same = '名古屋で平日ゴルフ行ける人、いませんか！？三重・岐阜は平日ガラガラで安くて最高なのに、周りが土日派ばっかりで寂しいです笑';
  expect(checkText(same + 'よろしく', { recent: [same] })).toEqual({ ok: false, reason: '直近の投稿と似すぎ' });
  expect(checkText('   ').ok).toBe(false);
  expect(checkText('今日のベストショットは？', { recent: [same] })).toEqual({ ok: true });
});

test('writePost: NG 語は 2 回書き直しても落ちたら ok:false', async () => {
  const a = fakeAnthropic(['ウッドの話', 'ウッドの話2', 'ウッドの話3']);
  const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: { THREADS_BANNED_WORDS: 'ウッド;鈴木' }, anthropic: a });
  expect(r).toMatchObject({ ok: false, type: 'question' });
  expect(r.reason).toMatch(/NG語/);
  expect(a.messages.create).toHaveBeenCalledTimes(3);
});

test('writePost: 1 回目が落ちて 2 回目が通れば attempts 2、書き直しの指示に落ちた理由が入る', async () => {
  const a = fakeAnthropic(['https://x.y を見て', '名古屋で平日ゴルフ行ける人いませんか？']);
  const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
  expect(r).toEqual({ ok: true, text: '名古屋で平日ゴルフ行ける人いませんか？', type: 'question', attempts: 2 });
  expect(JSON.stringify(a.messages.create.mock.calls[1][0])).toMatch(/URL/);
});

test('writePost の system に人物像と禁止事項、user に日付・型・直近の投稿が入る', async () => {
  const a = fakeAnthropic(['今日のベストショットは？']);
  await writePost({ type: 'hook', recent: ['前の投稿です'], dateKey: '2026-10-28', env: {}, anthropic: a });
  const call = a.messages.create.mock.calls[0][0];
  const sys = String(call.system);
  expect(sys).toMatch(/名古屋/); expect(sys).toMatch(/90/); expect(sys).toMatch(/ゴルフ場の名前/); expect(sys).toMatch(/作り話/);
  expect(call.model).toBe('claude-opus-5-5');
  const user = JSON.stringify(call.messages);
  expect(user).toMatch(/2026-10-28/); expect(user).toMatch(/水/); expect(user).toMatch(/前の投稿です/);
});

test('writePost は前後の引用符や「投稿:」の見出しを剥がす', async () => {
  const a = fakeAnthropic(['投稿:\n「今日のベストショットは？」']);
  const r = await writePost({ type: 'hook', recent: [], dateKey: '2026-10-28', env: { THREADS_MODEL: 'x' }, anthropic: a });
  expect(r.text).toBe('今日のベストショットは？');
  expect(a.messages.create.mock.calls[0][0].model).toBe('x');
});
