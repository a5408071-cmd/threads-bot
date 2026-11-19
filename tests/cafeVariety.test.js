const { openingCheck, pickCafeType, GUIDE_TYPES } = require('../src/cafeTick');

// 2026-11-19 社長「最近の投稿見て 店舗と文がいつも同じ感じで変」→「1-3すすめて」
describe('書き出しの決まり文句と、直近と同じ書き出しを止める', () => {
  const check = openingCheck(['カフェインが効き始めるのは、飲んでから20分ほどたってから。そのあいだに…']);
  test.each([
    '緑と集中にまつわる豆知識をひとつ。2015年に発表された研究では…',
    '木曜日に読みたい、経営者の名言です🌿\n「人生・仕事の結果＝考え方×熱意×能力」稲盛和夫',
    '背中をそっと押してくれる名言です🌿\n「人生は恐れを知らぬ冒険か、無かのどちらかである」',
    '大阪市平野区の「セルフカフェ 大阪平野西店」は、大阪メトロ谷町線の平野駅から徒歩5分。',
    '「セルフカフェ 鳴海山下店」は、名古屋市緑区にある28席のお店です。',
    'テーブルのあいだに、木の仕切り板がすっと立っているお店です。黄色い壁と木目のテーブルが明るい…',
  ])('決まり文句は書き直し: %s', (text) => {
    const r = check(text);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/決まり文句/);
  });

  test('直近の投稿と書き出しの12字が同じなら書き直し', () => {
    const r = check('カフェインが効き始めるのは、飲んでから30分。');
    expect(r).toEqual({ ok: false, reason: '書き出しが最近の投稿と同じ。ちがう書き出しにする' });
  });

  test.each([
    '「憧れるのをやめましょう」\nWBC決勝の前に、大谷翔平がロッカールームで仲間にかけた言葉です。',
    '壁いっぱいの草花の壁紙に囲まれて、94席。渋谷神南店は、街の真ん中で深呼吸できる場所です。',
    '作業が途中で止まると、元に戻るまで平均で20分以上かかるという研究があります。',
  ])('中身から始まる文は通す: %s', (text) => {
    expect(check(text)).toEqual({ ok: true });
  });
});

describe('使い方・設備の回は週1本', () => {
  const W = { work: 1, howto: 1, facility: 1, quote: 1 };
  test('直近7日に出ていれば選ばない（配分があっても）', () => {
    for (let i = 0; i < 50; i++) {
      const t = pickCafeType(['work', 'quote'], () => i / 50, W, ['trivia', 'quote'], { allowed: false, due: false });
      expect(GUIDE_TYPES).not.toContain(t);
    }
  });
  test('直近7日に出ていなければ、次はどちらか（配分で選ぶ）', () => {
    expect(GUIDE_TYPES).toContain(pickCafeType(['work', 'quote'], () => 0, W, ['trivia', 'quote'], { allowed: true, due: true }));
    expect(pickCafeType(['work'], () => 0, { howto: 2 }, ['trivia', 'quote'], { allowed: true, due: true })).toBe('howto');
  });
  test('毎日枠（豆知識・名言）がまだなら、そちらが先', () => {
    expect(['trivia', 'quote']).toContain(pickCafeType(['work'], () => 0, W, [], { allowed: true, due: true }));
  });
});

test('店名の書き出しはスペースが無くても・全角でも止める（レビュー指摘）', () => {
  const check = openingCheck([]);
  expect(check('「セルフカフェ鳴海山下店」は、28席のお店です。').ok).toBe(false);
  expect(check('緑区の「セルフカフェ　鳴海山下店」は、28席。').ok).toBe(false);
});
