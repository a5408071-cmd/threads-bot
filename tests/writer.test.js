const { pickType, checkText, writePost, TYPES, parseBanned, DEFAULT_BANNED } = require('../src/writer');

// 120 字以上の「通る」見本（自動投稿は短すぎる案を書き直させる＝2026-10-27 社長「文章短すぎ！」）
const LONG = '名古屋で平日ゴルフ行ける人、いませんか！？三重・岐阜は平日ガラガラで安くて最高なのに、周りが土日派ばっかりで寂しいです笑。30代、スコア90〜100で楽しむ派。20代・30代大歓迎、40代ももちろんOKです！気軽にコメントくださいね🙌 平日の午後からでも大丈夫です！';
const LONG_NG = (w) => `${w}の仲間と平日ゴルフ行ける人、いませんか！？三重・岐阜は平日ガラガラで安くて最高なのに、周りが土日派ばっかりで寂しいです笑。30代、スコア90〜100で楽しむ派。20代・30代大歓迎、40代ももちろんOKです！気軽にコメントくださいね🙌 平日の午後からでも大丈夫です！`;

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
  expect(n).toBeGreaterThan(120); // 型が 13 に増えたので 3/19 くらい（他の型の 1.5〜3 倍）
});

test('checkText: 500 字超・URL・NG 語・似すぎ・空は落ちる', () => {
  expect(checkText('あ'.repeat(501)).ok).toBe(false);
  expect(checkText('詳しくは https://example.com').ok).toBe(false);
  expect(checkText('詳しくは www.example.com まで').ok).toBe(false);
  expect(checkText('ウッドデザインパークのゴルフ会', { banned: ['ウッドデザインパーク'] })).toEqual({ ok: false, reason: 'NG語: ウッドデザインパーク' });
  expect(checkText('wood designpark のゴルフ会', { banned: ['Wood DesignPark'] }).ok).toBe(false); // 大文字小文字・空白は無視
  expect(checkText(LONG + 'よろしく', { recent: [LONG] })).toEqual({ ok: false, reason: '直近の投稿と似すぎ' });
  expect(checkText('   ').ok).toBe(false);
  expect(checkText('今日のベストショットは？', { recent: [LONG] })).toEqual({ ok: true });
});

test('checkText: minChars を渡したときだけ短すぎる案を落とす（/api/post＝社長の一言には掛けない）', () => {
  expect(checkText('今日のベストショットは？', { minChars: 120 }).ok).toBe(false);
  expect(checkText('今日のベストショットは？', { minChars: 120 }).reason).toMatch(/短すぎ/);
  expect(checkText('今日のベストショットは？').ok).toBe(true);
  expect(checkText(LONG, { minChars: 120 }).ok).toBe(true);
});

test('NG 語は環境変数が空でも既定（会社名・本名）で止まり、全角・半角の違いも当てる', () => {
  expect(DEFAULT_BANNED).toEqual(expect.arrayContaining(['ウッドデザインパーク', 'セルフカフェ', '鈴木大基']));
  expect(parseBanned({})).toEqual(expect.arrayContaining(DEFAULT_BANNED));
  expect(parseBanned({ THREADS_BANNED_WORDS: '追加語' })).toEqual(expect.arrayContaining([...DEFAULT_BANNED, '追加語']));
  expect(checkText('ＷＤＰのゴルフ会', { banned: ['WDP'] }).ok).toBe(false);
  expect(checkText('ｾﾙﾌｶﾌｪ行った', { banned: ['セルフカフェ'] }).ok).toBe(false);
});

test('writePost: NG 語は 2 回書き直しても落ちたら ok:false', async () => {
  const a = fakeAnthropic([LONG_NG('ウッド'), LONG_NG('ウッド2'), LONG_NG('ウッド3')]);
  const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: { THREADS_BANNED_WORDS: 'ウッド;鈴木' }, anthropic: a });
  expect(r).toMatchObject({ ok: false, type: 'question' });
  expect(r.reason).toMatch(/NG語/);
  expect(a.messages.create).toHaveBeenCalledTimes(3);
});

test('writePost: 1 回目が落ちて 2 回目が通れば attempts 2、書き直しの指示に落ちた理由が入る', async () => {
  const a = fakeAnthropic(['https://x.y を見て', LONG]);
  const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
  expect(r).toEqual({ ok: true, text: LONG, type: 'question', attempts: 2, tag: 'ゴルフ' });
  expect(JSON.stringify(a.messages.create.mock.calls[1][0])).toMatch(/URL/);
});

test('writePost: 120 字未満の案は短すぎるとして書き直させる', async () => {
  const a = fakeAnthropic(['今日のベストショットは？', LONG]);
  const r = await writePost({ type: 'hook', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
  expect(r).toMatchObject({ ok: true, attempts: 2, text: LONG });
  expect(JSON.stringify(a.messages.create.mock.calls[1][0])).toMatch(/短すぎ/);
});

test('writePost の system に人物像と禁止事項、user に日付・型・直近の投稿が入る', async () => {
  const a = fakeAnthropic([LONG]);
  await writePost({ type: 'hook', recent: ['前の投稿です'], dateKey: '2026-10-28', env: {}, anthropic: a });
  const call = a.messages.create.mock.calls[0][0];
  const sys = String(call.system);
  expect(sys).toMatch(/名古屋/); expect(sys).toMatch(/90/); expect(sys).toMatch(/ゴルフ場の名前/); expect(sys).toMatch(/作り話/);
  expect(sys).toMatch(/150〜300字/);
  expect(call.model).toBe('claude-opus-5-5');
  expect(call.max_tokens).toBeGreaterThanOrEqual(8000);
  const user = JSON.stringify(call.messages);
  expect(user).toMatch(/2026-10-28/); expect(user).toMatch(/水/); expect(user).toMatch(/前の投稿です/);
});

test('writePost は前後の引用符や「投稿:」の見出しを剥がす', async () => {
  const a = fakeAnthropic([`投稿:\n「${LONG}」`]);
  const r = await writePost({ type: 'hook', recent: [], dateKey: '2026-10-28', env: { THREADS_MODEL: 'x' }, anthropic: a });
  expect(r.text).toBe(LONG);
  expect(a.messages.create.mock.calls[0][0].model).toBe('x');
});

test('writePost: stop_reason が max_tokens（途中で切れた）の案は使わず書き直させる', async () => {
  let i = 0;
  const outs = [{ text: LONG.slice(0, 130), stop: 'max_tokens' }, { text: LONG, stop: 'end_turn' }];
  const a = { messages: { create: jest.fn(async () => { const o = outs[i++]; return { content: [{ type: 'text', text: o.text }], stop_reason: o.stop }; }) } };
  const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
  expect(r).toMatchObject({ ok: true, attempts: 2, text: LONG });
  expect(JSON.stringify(a.messages.create.mock.calls[1][0])).toMatch(/途中で切れ/);
});

test('引用符は本文全体を包んでいるときだけ剥がす（文中の「…」で始まる本文の先頭を削らない）', async () => {
  const body = `「明日はゴルフだから早く寝よう」と決めたはずが、気づいたら三杯目…これ、ゴルファーあるあるですよね笑。${LONG}`;
  const a = fakeAnthropic([body]);
  const r = await writePost({ type: 'aruaru', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
  expect(r.text).toBe(body);
});

test('writePost: 写真を渡すと user に画像ブロックと「写っているものに合わせる・いつどこでは断定しない」の指示が入る', async () => {
  const a = fakeAnthropic([LONG]);
  const photo = { id: 'P1', name: 'course.jpg', mediaType: 'image/jpeg', bytes: Buffer.from('jpegbytes') };
  await writePost({ type: 'season', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a, photo });
  const msg = a.messages.create.mock.calls[0][0].messages[0];
  expect(Array.isArray(msg.content)).toBe(true);
  const img = msg.content.find((b) => b.type === 'image');
  expect(img).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('jpegbytes').toString('base64') } });
  const txt = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  expect(txt).toMatch(/写真/); expect(txt).toMatch(/いつ|どこ/);
});

test('写真なしの回は短めの指示（100〜180字）、写真ありは 150〜300字。どちらも「募集・一杯で締めない」の指示が入る', async () => {
  const a = fakeAnthropic([LONG, LONG]);
  await writePost({ type: 'aruaru', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
  const u1 = JSON.stringify(a.messages.create.mock.calls[0][0].messages);
  expect(u1).toMatch(/100〜180字/);
  await writePost({ type: 'aruaru', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a, photo: { id: 'P', name: 'a.jpg', mediaType: 'image/jpeg', bytes: Buffer.from('x') } });
  const u2 = JSON.stringify(a.messages.create.mock.calls[1][0].messages);
  expect(u2).toMatch(/150〜300字/);
  const sys = String(a.messages.create.mock.calls[0][0].system);
  expect(sys).toMatch(/誘い型だけ/);
});

test('写真なしの最低字数は 80 字（写真ありは 120 字）', async () => {
  const short = 'ゴルフ場選び、景色派ですか？スコア派ですか？僕は完全に景色派で、山が見えるホールに立つだけでテンション上がります笑'; // 約 60 字
  const mid = short + 'みなさんはどっち派か、よかったら教えてください！'; // 約 85 字
  const a = fakeAnthropic([short, mid]);
  const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
  expect(r).toMatchObject({ ok: true, attempts: 2, text: mid });
  const b = fakeAnthropic([mid, LONG]);
  const r2 = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: {}, anthropic: b, photo: { id: 'P', name: 'a.jpg', mediaType: 'image/jpeg', bytes: Buffer.from('x') } });
  expect(r2).toMatchObject({ ok: true, attempts: 2, text: LONG });
});

describe('ゴルフ以外の型とタグ（2026-10-28 社長「ゴルフ以外の季節とか時事とか関係ない話も入れ込んで タグもつけてフォロワー増やしたいな」）', () => {
  test('型に daily（日常）と news（時事）があり、ゴルフ以外が 3 回に 1 回くらい出る', () => {
    expect(TYPES).toEqual(expect.arrayContaining(['daily', 'news']));
    let n = 0;
    for (let i = 0; i < 3000; i++) if (['daily', 'news'].includes(pickType([], new Date('2026-10-28T03:00:00Z'), Math.random))) n++;
    expect(n).toBeGreaterThan(450); expect(n).toBeLessThan(1500);
  });

  test('本文の最後の「タグ: xxx」を切り出す。# と . と & は落とし、50 字まで', async () => {
    const a = fakeAnthropic([`${LONG}\nタグ: #ゴルフ好きと繋がりたい`]);
    const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
    expect(r.text).toBe(LONG);
    expect(r.tag).toBe('ゴルフ好きと繋がりたい');
    const b = fakeAnthropic([`${LONG}\nタグ：秋.の&ゴルフ`]);
    expect((await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: {}, anthropic: b })).tag).toBe('秋のゴルフ');
  });

  test('タグが無ければ型ごとの既定タグ', async () => {
    const a = fakeAnthropic([LONG]);
    const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
    expect(r.tag).toBe('ゴルフ');
    const b = fakeAnthropic([LONG]);
    expect((await writePost({ type: 'daily', recent: [], dateKey: '2026-10-28', env: {}, anthropic: b })).tag).toBe('名古屋');
  });

  test('news 型はウェブ検索の道具を付けて呼び、政治・事件を避ける指示が入る。他の型は道具なし', async () => {
    const a = fakeAnthropic([LONG]);
    await writePost({ type: 'news', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
    const call = a.messages.create.mock.calls[0][0];
    expect(call.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
    expect(JSON.stringify(call.messages)).toMatch(/検索/);
    expect(String(call.system)).toMatch(/政治/);
    const b = fakeAnthropic([LONG]);
    await writePost({ type: 'daily', recent: [], dateKey: '2026-10-28', env: {}, anthropic: b });
    expect(b.messages.create.mock.calls[0][0].tools).toBeUndefined();
  });

  test('news 型で pause_turn が返ったら続きを頼む（content を assistant として足す）', async () => {
    let i = 0;
    const outs = [
      { content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }], stop_reason: 'pause_turn' },
      { content: [{ type: 'text', text: LONG }], stop_reason: 'end_turn' },
    ];
    const a = { messages: { create: jest.fn(async () => outs[i++]) } };
    const r = await writePost({ type: 'news', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
    expect(r.ok).toBe(true);
    const second = a.messages.create.mock.calls[1][0].messages;
    expect(second[1]).toMatchObject({ role: 'assistant', content: outs[0].content });
  });

  test('本文に #ハッシュタグ が混ざっていたら落とす（タグは topic_tag で付ける）', () => {
    expect(checkText(LONG + ' #ゴルフ').ok).toBe(false);
  });
});

describe('ストック写真の検索語（2026-10-28 社長「写真そんなに在庫ないなー」→ 案1）', () => {
  test('stockPhoto:true なら「写真: 英語の検索語」の行を求め、photoQuery に切り出す', async () => {
    const a = fakeAnthropic([`${LONG}\n写真: roasted sweet potato autumn\nタグ: 秋`]);
    const r = await writePost({ type: 'daily', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a, stockPhoto: true });
    expect(r.text).toBe(LONG);
    expect(r.tag).toBe('秋');
    expect(r.photoQuery).toBe('roasted sweet potato autumn');
    expect(JSON.stringify(a.messages.create.mock.calls[0][0].messages)).toMatch(/写真: /);
  });
  test('stockPhoto でなければ写真の行は求めず、あっても落とす', async () => {
    const a = fakeAnthropic([`${LONG}\n写真: golf\nタグ: ゴルフ`]);
    const r = await writePost({ type: 'question', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
    expect(r.text).toBe(LONG);
    expect(r.photoQuery).toBeUndefined();
    expect(JSON.stringify(a.messages.create.mock.calls[0][0].messages)).not.toMatch(/写真: /);
  });
});

test('photoFits: 写真と本文を安いモデルに見せて yes/no で判定（答えが曖昧なら false）', async () => {
  const { photoFits } = require('../src/writer');
  const a = fakeAnthropic(['yes', 'NO、じゃがいもの炒め物です', '']);
  const bytes = Buffer.from('x');
  expect(await photoFits({ text: '焼き芋の話', bytes, mediaType: 'image/jpeg', env: {}, anthropic: a })).toBe(true);
  expect(await photoFits({ text: '焼き芋の話', bytes, mediaType: 'image/jpeg', env: {}, anthropic: a })).toBe(false);
  expect(await photoFits({ text: '焼き芋の話', bytes, mediaType: 'image/jpeg', env: {}, anthropic: a })).toBe(false);
  const call = a.messages.create.mock.calls[0][0];
  expect(call.model).toBe('claude-haiku-5-5');
  expect(call.messages[0].content.find((b) => b.type === 'image')).toBeTruthy();
  expect(JSON.stringify(call.messages)).toMatch(/焼き芋の話/);
});

test('photoFits: 「はい」「合う」「yes.」も yes 扱い。「いいえ」「no」は false', async () => {
  const { photoFits } = require('../src/writer');
  const a = fakeAnthropic(['はい', '合います', 'Yes.', 'いいえ', 'no']);
  const args = { text: 't', bytes: Buffer.from('x'), mediaType: 'image/jpeg', env: {}, anthropic: a };
  expect(await photoFits(args)).toBe(true);
  expect(await photoFits(args)).toBe(true);
  expect(await photoFits(args)).toBe(true);
  expect(await photoFits(args)).toBe(false);
  expect(await photoFits(args)).toBe(false);
  expect(JSON.stringify(a.messages.create.mock.calls[0][0].messages)).toMatch(/明るく/);
});

test('photoFits: 考える工程の分も出力枠に入るので max_tokens は 1000 以上、effort は low', async () => {
  const { photoFits } = require('../src/writer');
  const a = fakeAnthropic(['yes']);
  await photoFits({ text: 't', bytes: Buffer.from('x'), mediaType: 'image/jpeg', env: {}, anthropic: a });
  const call = a.messages.create.mock.calls[0][0];
  expect(call.max_tokens).toBeGreaterThanOrEqual(1000);
  expect(call.output_config).toEqual({ effort: 'low' });
});

describe('人物像の追加（2026-10-28 本人「キラキラしてて楽しい感じ」「経営者らしく仕事も生きがい」「12月ホノルルマラソン」「パーソナルで細マッチョ」「ストイックだけど酒は飲みすぎ」）', () => {
  test('型に work（仕事）と fitness（運動）があり、ゴルフ以外が半分くらい出る', () => {
    expect(TYPES).toEqual(expect.arrayContaining(['work', 'fitness']));
    let n = 0;
    for (let i = 0; i < 3000; i++) if (['daily', 'news', 'work', 'fitness'].includes(pickType([], new Date('2026-10-28T03:00:00Z'), Math.random))) n++;
    expect(n).toBeGreaterThan(1200); expect(n).toBeLessThan(1900);
  });
  test('system にマラソン・ジム・仕事の生きがい・飲みすぎ・キラキラ・生活感NG が入る', async () => {
    const a = fakeAnthropic([LONG]);
    await writePost({ type: 'work', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a });
    const sys = String(a.messages.create.mock.calls[0][0].system);
    for (const w of ['ホノルルマラソン', 'パーソナル', '細マッチョ', '生きがい', '飲みすぎ', 'キラキラ', '焼き芋']) expect(sys).toContain(w);
  });
  test('既定タグに work=経営者の日常、fitness=ホノルルマラソン', async () => {
    const a = fakeAnthropic([LONG, LONG]);
    expect((await writePost({ type: 'work', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a })).tag).toBe('経営者の日常');
    expect((await writePost({ type: 'fitness', recent: [], dateKey: '2026-10-28', env: {}, anthropic: a })).tag).toBe('ホノルルマラソン');
  });
});

test('pickType は weights（型ごとの重み）を渡せる。重み 0 の型は出ない', () => {
  const weights = { question: 0, aruaru: 0, invite: 0, season: 0, small: 0, hook: 0, work: 0, fitness: 5, daily: 1, news: 0 };
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(pickType([], new Date('2026-10-28T03:00:00Z'), Math.random, weights));
  expect([...seen].sort()).toEqual(['daily', 'fitness']);
});

describe('試験・暦・継続のコツ（2026-10-29 社長「簿記とか国家試験、センター試験などの話題も 残り何日とか 暦の話もいいね 継続することの難しさややる気を出すコツ へえーってなるといいね」）', () => {
  test('型に countdown・koyomi・tips があり、どれもウェブ検索で確かめる', async () => {
    expect(TYPES).toEqual(expect.arrayContaining(['countdown', 'koyomi', 'tips']));
    for (const type of ['countdown', 'koyomi', 'tips']) {
      const a = fakeAnthropic([`${LONG}\nタグ: 習慣化`]);
      await writePost({ type, recent: [], dateKey: '2026-10-29', env: {}, anthropic: a });
      expect(a.messages.create.mock.calls[0][0].tools).toEqual([expect.objectContaining({ type: 'web_search_20260209' })]);
    }
  });

  test('{N} は「日付:」の行の日までの日数に置き換え、日付の行は本文から外す', async () => {
    const a = fakeAnthropic([`${LONG}\n日商簿記の試験まで残り{N}日！\n日付: 2026-11-15\nタグ: 簿記`]);
    const r = await writePost({ type: 'countdown', recent: [], dateKey: '2026-10-29', env: {}, anthropic: a });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('残り17日');
    expect(r.text).not.toMatch(/\{N\}|日付:/);
    expect(r.tag).toBe('簿記');
  });

  test('{N} があるのに日付が無い・過去の日付なら書き直し', async () => {
    const a = fakeAnthropic([`${LONG}\n残り{N}日`, `${LONG}\n残り{N}日\n日付: 2026-10-01`, LONG]);
    const r = await writePost({ type: 'countdown', recent: [], dateKey: '2026-10-29', env: {}, anthropic: a });
    expect(r).toMatchObject({ ok: true, attempts: 3 });
    const third = JSON.stringify(a.messages.create.mock.calls[2][0].messages);
    expect(third).toMatch(/日付/);
  });

  test('残り日数を数字で直接書いたら書き直し（数え間違いを防ぐ）', async () => {
    const a = fakeAnthropic([`${LONG}\n共通テストまであと80日`, LONG]);
    const r = await writePost({ type: 'countdown', recent: [], dateKey: '2026-10-29', env: {}, anthropic: a });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  test('system に簿記・共通テスト・暦・継続のコツが入る', async () => {
    const a = fakeAnthropic([LONG]);
    await writePost({ type: 'tips', recent: [], dateKey: '2026-10-29', env: {}, anthropic: a });
    const sys = String(a.messages.create.mock.calls[0][0].system);
    for (const w of ['簿記', '共通テスト', '二十四節気', '継続']) expect(sys).toContain(w);
  });
});

describe('{N} の漏れを防ぐ（レビュー指摘）', () => {
  const { fillCountdown } = require('../src/writer');
  test('全角・小文字の {N} も置き換える。崩れた { } が残れば書き直し', () => {
    expect(fillCountdown('残り｛Ｎ｝日と{n}日', '2026-11-15', '2026-10-29').text).toBe('残り17日と17日');
    expect(fillCountdown('残り{N日}', '2026-11-15', '2026-10-29').ok).toBe(false);
    expect(fillCountdown('なんでも{x}', null, '2026-10-29', 'daily').ok).toBe(false);
  });
  test('数字の残り日数を止めるのは countdown 型だけ。漢数字・か月も止める', () => {
    expect(fillCountdown('週末まであと2日', null, '2026-10-29', 'daily').ok).toBe(true);
    expect(fillCountdown('試験まで残り八十日', null, '2026-10-29', 'countdown').ok).toBe(false);
    expect(fillCountdown('あと2か月', null, '2026-10-29', 'countdown').ok).toBe(false);
  });
  test('続けて呼んでも結果が変わらない', () => {
    for (let i = 0; i < 3; i++) expect(fillCountdown('残り{N}日', '2026-11-15', '2026-10-29').text).toBe('残り17日');
  });
  test('日付とタグの間に空行があっても日付の行を本文から外す', async () => {
    const a = fakeAnthropic([`${LONG}\n\n日付: 2026-11-15\n\nタグ: 簿記\n\n写真: study desk | notebook\n\n`]);
    const r = await writePost({ type: 'daily', recent: [], dateKey: '2026-10-29', env: {}, anthropic: a });
    expect(r.text).toBe(LONG);
  });
});

test('writePost の check（呼ぶ側の追加検査）に落ちたら理由を添えて書き直し', async () => {
  const a = fakeAnthropic([`${LONG}セルフカフェ栄店`, LONG]);
  const check = (t) => (t.includes('栄店') ? { ok: false, reason: '店名が入っている' } : { ok: true });
  const r = await writePost({ type: 'work', recent: [], dateKey: '2026-10-29', env: {}, anthropic: a, check, banned: [] });
  expect(r).toMatchObject({ ok: true, attempts: 2, text: LONG });
  expect(JSON.stringify(a.messages.create.mock.calls[1][0].messages)).toMatch(/店名が入っている/);
});
