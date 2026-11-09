const { createCafeLearning } = require('../src/cafeLearning');
const { memoryStore } = require('../src/store');

const NOW = new Date('2026-11-03T07:05:00+09:00'); // 火曜
const MON = new Date('2026-11-02T07:05:00+09:00');
const post = (i, over = {}) => ({ mediaId: `m${i}`, type: 'work', text: `本文${i}`, tag: 'テレワーク', postedAt: new Date(NOW.getTime() - (i + 1) * 3600000).toISOString(), insights: { views: 100 * i, likes: i, replies: 0 }, ...over });
const ai = (obj) => ({ messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] })) } });

async function mk({ now = NOW, answer, posts = 4 } = {}) {
  const store = memoryStore({ now: () => now, prefix: 'threads_cafe_' });
  for (let i = 1; i <= posts; i++) await store.savePost(post(i));
  await store.setMetric('2026-10-27', { followers: 250 });
  await store.setMetric('2026-11-02', { followers: 291 });
  const anthropic = ai(answer || { weights: { work: 4, study: 2, quote: 0 }, notes: ['問いかけで締めた回はコメントが付きやすい', '新店のタグは市区の名前（安城カフェ）にする'], report: '新店が強い。今週は問いかけを増やす' });
  const notify = { owner: jest.fn(async () => ({ ok: true })) };
  const l = createCafeLearning({ store, anthropic, notify, env: {}, now: () => now });
  return { l, store, anthropic, notify };
}

describe('公式の毎日の見直し（2026-11-02 社長「伸ばす投稿を日々ブラッシュアップしていきたい」）', () => {
  test('直近 7 日の数字（タグ・曜日入り）を AI に見せ、配分とメモを保存。メモは次の投稿の指示に入る', async () => {
    const { l, anthropic } = await mk();
    const r = await l.daily();
    expect(r).toMatchObject({ ok: true, reported: false });
    const prompt = anthropic.messages.create.mock.calls[0][0].messages[0].content;
    expect(prompt).toMatch(/テレワーク/);
    expect(prompt).toMatch(/店名・駅名.*書かない|URL/); // 変えてはいけない決まりを伝える
    expect(await l.weightsFor()).toMatchObject({ work: 4, study: 2, quote: 0 });
    const notes = await l.notesText();
    expect(notes).not.toMatch(/問いかけ/); // 問いかけ系のメモは投稿の指示に渡さない（2026-11-09 社長「毎回質問系で終わるのがうざい」）
    expect(notes).toMatch(/市区の名前/);
  });

  test('1 日 1 回だけ（2 回目は AI を呼ばない）', async () => {
    const { l, anthropic } = await mk();
    await l.daily();
    expect(await l.daily()).toMatchObject({ skipped: 'done' });
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  });

  test('数字の付いた投稿が 3 本未満なら見直さない（前のメモのまま）', async () => {
    const { l, anthropic } = await mk({ posts: 2 });
    expect(await l.daily()).toMatchObject({ skipped: 'few' });
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  test('社長への報告は月曜だけ（【公式】・フォロワーの増減つき）', async () => {
    const tue = await mk();
    await tue.l.daily();
    expect(tue.notify.owner).not.toHaveBeenCalled();
    const mon = await mk({ now: MON });
    expect(await mon.l.daily()).toMatchObject({ reported: true });
    const msg = mon.notify.owner.mock.calls[0][0];
    expect(msg).toMatch(/^【公式】/);
    expect(msg).toMatch(/291/);
    expect(msg).toMatch(/\+41/);
    expect(msg).toMatch(/問いかけを増やす/);
  });

  test('配分は公式の型だけ・0〜5 に丸め、全部 0 なら配分を保存しない。メモは 5 つまで', async () => {
    const { l } = await mk({ answer: { weights: { work: 99, golf: 3, study: -1 }, notes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], report: '' } });
    await l.daily();
    const w = await l.weightsFor();
    expect(w.work).toBe(5);
    expect(w.study).toBe(0);
    expect(w).not.toHaveProperty('golf');
    expect((await l.notesText()).match(/^- /gm)).toHaveLength(5);
    const z = await mk({ answer: { weights: { work: 0 }, notes: [], report: '' } });
    const zr = await z.l.daily();
    expect(zr.ok).toBe(true);
  });

  test('AI の答えが読めなければ失敗を返し、前のメモ・配分は消さない', async () => {
    const { store } = await mk();
    await store.setConfig('strategy', { weights: { work: 3 }, notes: ['前のメモ'] });
    const bad = createCafeLearning({ store, anthropic: { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: 'わかりません' }] })) } }, notify: { owner: jest.fn() }, env: {}, now: () => NOW });
    expect(await bad.daily()).toMatchObject({ ok: false });
    expect(await bad.notesText()).toMatch(/前のメモ/);
    expect((await bad.weightsFor()).work).toBe(3);
  });

  test('メモが無ければ notesText は空、配分が無ければ weightsFor は null', async () => {
    const store = memoryStore({ now: () => NOW, prefix: 'threads_cafe_' });
    const l = createCafeLearning({ store, anthropic: null, notify: null, env: {}, now: () => NOW });
    expect(await l.notesText()).toBe('');
    expect(await l.weightsFor()).toBeNull();
  });
});
