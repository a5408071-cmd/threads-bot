// 2026-11-09 社長「文章が長い」「毎回質問系で終わるのがうざい」「そんなに利用シーンのこと出さなくていい」
const { noQuestionCheck } = require('../src/cafeTick');
const writer = require('../src/writer');
const personaCafe = require('../src/personaCafe');

describe('公式: 短く・問いかけで締めない・利用シーンを並べない', () => {
  test('最後が？で終わる案は落とす（絵文字・括弧の後ろも）', () => {
    expect(noQuestionCheck('Wi-Fiも電源もあります。\nあなたはどっち派ですか？').ok).toBe(false);
    expect(noQuestionCheck('ちょっと寄ってみませんか？☕').ok).toBe(false);
    expect(noQuestionCheck('今日も一息どうですか?').ok).toBe(false);
  });
  test('言い切りで終わる案・途中の？は通す', () => {
    expect(noQuestionCheck('ドリンク1杯で時間を気にせず過ごせます。ぜひ。').ok).toBe(true);
    expect(noQuestionCheck('「どこで作業しよう？」と迷ったら。\n時間無制限でゆっくりどうぞ☕').ok).toBe(true);
  });
  test('公式の長さは趣味用より短い（一番長い回でも 220 字台まで）', () => {
    const b = writer.pickLength({ photo: true, type: 'work', rand: () => 0.99, bandSet: personaCafe.LENGTH_BANDS });
    expect(b.text).toMatch(/150〜220字/);
    expect(writer.pickLength({ photo: true, type: 'work', rand: () => 0.99 }).text).toMatch(/280〜420字/);
  });
  test('SYSTEM に 問いかけで締めない・利用シーンを毎回書かない が入り、「具体的な場面を 1 つ入れる」は消えた', () => {
    expect(personaCafe.SYSTEM).toMatch(/問いかけ・疑問文で締めない/);
    expect(personaCafe.SYSTEM).toMatch(/利用シーン/);
    expect(personaCafe.SYSTEM).not.toMatch(/具体的な場面を 1 つ入れる/);
  });
  test('writePost は公式の長さを prompt に渡す', async () => {
    const anthropic = { messages: { create: jest.fn(async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ドリンク1杯で時間を気にせず過ごせます。Wi-Fiと電源もあるので、ゆっくり作業できます。ぜひ立ち寄ってみてください。\nタグ: セルフカフェ' }] })) } };
    await writer.writePost({ type: 'work', dateKey: '2026-11-09', anthropic, persona: personaCafe, banned: [], rand: () => 0.5 });
    expect(String(anthropic.messages.create.mock.calls[0][0].messages[0].content)).toMatch(/60〜120字/);
  });
});

test('豆知識（trivia）はいつも一番長い段', () => {
  const writer = require('../src/writer');
  const personaCafe = require('../src/personaCafe');
  expect(writer.pickLength({ photo: true, type: 'trivia', rand: () => 0, bandSet: personaCafe.LENGTH_BANDS }).text).toMatch(/150〜220字/);
  expect(writer.pickLength({ photo: false, type: 'trivia', rand: () => 0, bandSet: personaCafe.LENGTH_BANDS }).text).toMatch(/120〜180字/);
});

test('偉人の名言（quote）もいつも一番長い段', () => {
  const writer = require('../src/writer');
  const personaCafe = require('../src/personaCafe');
  expect(writer.pickLength({ photo: true, type: 'quote', rand: () => 0, bandSet: personaCafe.LENGTH_BANDS }).text).toMatch(/150〜220字/);
});
