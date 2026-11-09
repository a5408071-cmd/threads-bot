// 2026-11-09 社長「資格勉強とかのタブを付けるなら資格試験のことを乗せて」「偉人はもっと頻度あげて」「勉強や集中などのうんちくや豆知識系は毎日入れ込もう」
const { pickCafeType, examTagFix, DAILY_TYPES } = require('../src/cafeTick');
const personaCafe = require('../src/personaCafe');
const writer = require('../src/writer');

describe('公式: 豆知識・名言を毎日／資格タグは試験の回だけ', () => {
  test('今日まだ豆知識・名言が無ければ、配分や使い方の回より先にどちらか', () => {
    const recent = ['work', 'study', 'season', 'koyomi']; // 使い方・設備の回の条件も満たしている
    expect(DAILY_TYPES).toContain(pickCafeType(recent, () => 0, { work: 5 }, []));
    expect(pickCafeType(recent, () => 0, null, [])).toBe('trivia');
    expect(pickCafeType(recent, () => 0.99, null, [])).toBe('quote');
  });
  test('今日出した方は出さず、残りを出す。両方出したら通常の選び方', () => {
    expect(pickCafeType(['trivia'], () => 0, null, ['trivia'])).toBe('quote');
    expect(pickCafeType(['quote', 'trivia'], () => 0, { work: 5 }, ['trivia', 'quote'])).toBe('work');
  });
  test('直前と同じ型は続けない（前日の最後が名言でも今日の 1 本目は豆知識）', () => {
    expect(pickCafeType(['quote'], () => 0.99, null, [])).toBe('trivia');
  });
  test('todayTypes を渡さない呼び方は今まで通り', () => {
    expect(pickCafeType(['work', 'study', 'season', 'koyomi'], () => 0)).toBe('facility');
  });
  test('資格・試験のタグは countdown 以外なら型の既定へ', () => {
    expect(examTagFix({ ok: true, type: 'study', tag: '資格勉強' }).tag).toBe('勉強カフェ');
    expect(examTagFix({ ok: true, type: 'tips', tag: '簿記' }).tag).toBe('勉強カフェ');
    expect(examTagFix({ ok: true, type: 'countdown', tag: '資格勉強' }).tag).toBe('資格勉強');
    expect(examTagFix({ ok: true, type: 'trivia', tag: '集中力' }).tag).toBe('集中力');
    expect(examTagFix({ ok: true, type: 'trivia', tag: '簿記3級' }).tag).toBe('豆知識'); // 表記ゆれ
    expect(examTagFix({ ok: true, type: 'quote', tag: '共通テスト対策' }).tag).toBe('名言');
  });
  test('豆知識はウェブ検索あり・型の説明と既定のタグがある。countdown は試験そのものの情報', () => {
    expect(personaCafe.TYPES).toContain('trivia');
    expect(writer.SEARCH_TYPES).toContain('trivia');
    expect(personaCafe.TYPE_GUIDE.trivia).toMatch(/豆知識/);
    expect(personaCafe.DEFAULT_TAG.trivia).toBe('豆知識');
    expect(personaCafe.TYPE_GUIDE.countdown).toMatch(/国家試験/);
    expect(personaCafe.TYPE_GUIDE.countdown).toMatch(/共通テスト/);
  });
});
