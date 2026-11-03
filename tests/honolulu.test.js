/**
 * 趣味アカウントの方向転換（2026-11-03 社長「ゴルフの方で方向転換 初めてのホノルルを全力で楽しみたい為にサイトを公開した
 *   よかったら掲示板書き込み待ってるキャラで行こう 定期的に発信 プロフもそれ用に変更したい」「ホノルル多めに移行」）
 */
const W = require('../src/writer');
const persona = require('../src/persona');
const { createGrowth, DEFAULT_WEIGHTS, POLICY } = require('../src/growth');
const { memoryStore } = require('../src/store');

const LONG = 'ホノルルまであと少し。初めてのフルマラソンなので、緊張とワクワクが毎日いったりきたりしています。朝走ると気持ちが落ち着くので、今日も走ってきました。同じ大会に出る人、どんな気持ちで準備していますか？本番が楽しみです！';
function fakeAnthropic(texts) {
  let i = 0;
  return { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: texts[i++] }], stop_reason: 'end_turn' })) } };
}

describe('人格: 初ホノルルを全力で楽しむ人が主役', () => {
  test('型に honolulu（初フルの緊張とワクワク）と board（掲示板のキャラ）がある', () => {
    expect(W.TYPES).toEqual(expect.arrayContaining(['honolulu', 'board']));
    expect(persona.TYPE_GUIDE.honolulu).toMatch('緊張');
    expect(persona.TYPE_GUIDE.board).toMatch('掲示板');
  });
  test('system に 人生初のフル・掲示板を作った・ニックネームだけで書ける・リンクはプロフィール が入り、掲示板の中身を作らない禁止がある', async () => {
    const a = fakeAnthropic([LONG]);
    await W.writePost({ rand: () => 0.5, type: 'board', recent: [], dateKey: '2026-11-04', env: {}, anthropic: a });
    const sys = String(a.messages.create.mock.calls[0][0].system);
    for (const w of ['人生初', '掲示板', 'ニックネーム', 'プロフィール', '書き込みの内容や人数']) expect(sys).toContain(w);
    expect(sys).not.toMatch(/目的: ゴルフ仲間・飲み仲間/);
  });
  test('既定タグ: honolulu と board は ホノルルマラソン', async () => {
    const a = fakeAnthropic([LONG, LONG]);
    expect((await W.writePost({ rand: () => 0.5, type: 'honolulu', recent: [], dateKey: '2026-11-04', env: {}, anthropic: a })).tag).toBe('ホノルルマラソン');
    expect((await W.writePost({ rand: () => 0.5, type: 'board', recent: [], dateKey: '2026-11-04', env: {}, anthropic: a })).tag).toBe('ホノルルマラソン');
  });
  test('honolulu 型は2択で締める。board 型は締めを誘い（書き込んでね）にするので2択は付けない', () => {
    expect(W.userPrompt({ type: 'honolulu', recent: [], dateKey: '2026-11-04', reasons: [], P: persona })).toMatch('2択');
    expect(W.userPrompt({ type: 'board', recent: [], dateKey: '2026-11-04', reasons: [], P: persona })).not.toMatch('2択');
  });
});

describe('配分: ホノルル多め、ゴルフはたまに', () => {
  const count = (n = 3000) => {
    const c = {};
    for (let i = 0; i < n; i++) { const t = W.pickType([], new Date('2026-11-04T03:00:00Z'), Math.random); c[t] = (c[t] || 0) + 1; }
    return c;
  };
  test('既定の配分で honolulu・board・fitness が 6 割前後、ゴルフ（question/aruaru/invite/small）は 2 割未満', () => {
    const c = count();
    const hon = (c.honolulu || 0) + (c.board || 0) + (c.fitness || 0);
    const golf = (c.question || 0) + (c.aruaru || 0) + (c.invite || 0) + (c.small || 0);
    expect(hon / 3000).toBeGreaterThan(0.5); expect(hon / 3000).toBeLessThan(0.75);
    expect(golf / 3000).toBeLessThan(0.2); expect(golf).toBeGreaterThan(0);
  });
  test('writer と growth の既定の配分は同じもの', () => {
    expect(W.DEFAULT_WEIGHTS).toEqual(DEFAULT_WEIGHTS);
    expect(DEFAULT_WEIGHTS.honolulu).toBeGreaterThan(DEFAULT_WEIGHTS.question);
  });
});

describe('週次の分析と方針の切り替え', () => {
  const NOW = new Date('2026-11-09T07:05:00+09:00'); // 月曜
  function mk(ai) {
    const store = memoryStore({ now: () => NOW });
    const threads = { userInsights: jest.fn(async () => ({ followers: 5 })), postInsights: jest.fn(async () => ({ views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 })) };
    const notify = { owner: jest.fn(async () => ({ ok: true })) };
    const growth = createGrowth({ threads, store, notify, anthropic: ai, env: {}, now: () => NOW });
    return { growth, store, notify, anthropic: ai };
  }
  test('前の方針（ゴルフ中心）で保存した配分は持ち込まず、既定に戻る', async () => {
    const { growth, store } = mk(fakeAnthropic([]));
    await store.setConfig('strategy', { weights: { question: 5, honolulu: 0 } }); // policy 無し＝古い
    expect(await growth.weightsFor()).toEqual(DEFAULT_WEIGHTS);
    await store.setConfig('strategy', { policy: POLICY, weights: { question: 4 } });
    expect((await growth.weightsFor()).question).toBe(4);
  });
  test('週次: AI がゴルフ寄りの配分を返しても、ホノルル・掲示板・運動には下限があり、保存に policy が付く', async () => {
    const ai = fakeAnthropic([JSON.stringify({ weights: { question: 5, aruaru: 5, honolulu: 0, board: 0, fitness: 0 }, notes: [], report: 'r' })]);
    const { growth, store, anthropic } = mk(ai);
    const r = await growth.weekly({ token: 'tk', userId: 'u1' });
    expect(r.ok).toBe(true);
    const s = await store.getConfig('strategy');
    expect(s.policy).toBe(POLICY);
    expect(s.weights.honolulu).toBeGreaterThanOrEqual(4);
    expect(s.weights.board).toBeGreaterThanOrEqual(3);
    expect(s.weights.fitness).toBeGreaterThanOrEqual(2);
    expect(String(anthropic.messages.create.mock.calls[0][0].messages[0].content)).toMatch('honolulu');
  });
});
