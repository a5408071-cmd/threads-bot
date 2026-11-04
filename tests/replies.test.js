const { createReplies } = require('../src/replies');
const { memoryStore } = require('../src/store');

const NOW = new Date('2026-10-28T09:05:00+09:00');

function mk({ posts = [], repliesByPost = {}, store = memoryStore({ now: () => NOW }) } = {}) {
  const threads = {
    listMyPosts: jest.fn(async () => posts),
    listReplies: jest.fn(async ({ mediaId }) => {
      const r = repliesByPost[mediaId];
      if (r instanceof Error) throw r;
      return r || [];
    }),
  };
  const notify = { owner: jest.fn(async () => ({ ok: true })) };
  const replies = createReplies({ threads, store, notify, now: () => NOW });
  return { threads, notify, store, replies };
}

const P1 = { id: 'm1', permalink: 'https://www.threads.net/@me/post/1', timestamp: '2026-10-27T00:00:00+0000' };
const P2 = { id: 'm2', permalink: 'https://www.threads.net/@me/post/2', timestamp: '2026-10-26T00:00:00+0000' };

test('初回は記録だけで知らせない', async () => {
  const { replies, notify, store } = mk({ posts: [P1], repliesByPost: { m1: [{ id: 'r1', text: 'いいね', username: 'bob', timestamp: 't', permalink: 'pr1' }] } });
  const r = await replies.poll({ token: 'tk', userId: 'u1' });
  expect(r).toMatchObject({ checked: 1, newReplies: 1, notified: 0, initialized: true, errors: [] });
  expect(notify.owner).not.toHaveBeenCalled();
  expect(await store.seenReply('r1')).toBe(true);
  expect(await store.getConfig('repliesInitialized')).toBeTruthy();
});

test('2 回目以降は新着を 1 通にまとめて知らせ、既読は数えない', async () => {
  const store = memoryStore({ now: () => NOW });
  await store.setConfig('repliesInitialized', { at: 'x' });
  await store.markReplySeen('r0', {});
  const { replies, notify } = mk({
    store,
    posts: [P1, P2],
    repliesByPost: {
      m1: [{ id: 'r0', text: '古い', username: 'ann', timestamp: 't', permalink: 'pr0' }, { id: 'r1', text: '平日行けます！', username: 'bob', timestamp: 't', permalink: 'pr1' }],
      m2: [{ id: 'r2', text: 'x'.repeat(150), username: 'cat', timestamp: 't', permalink: 'pr2' }],
    },
  });
  const r = await replies.poll({ token: 'tk', userId: 'u1' });
  expect(r).toMatchObject({ checked: 2, newReplies: 2, notified: 2, errors: [] });
  expect(notify.owner).toHaveBeenCalledTimes(1);
  const msg = notify.owner.mock.calls[0][0];
  expect(msg).toMatch(/コメント 2 件/);
  expect(msg).toMatch(/@bob/);
  expect(msg).toMatch(/平日行けます/);
  expect(msg).toMatch(/https:\/\/www\.threads\.net\/@me\/post\/1/);
  expect(msg).toMatch(/x{100}…/);
  expect(msg).not.toMatch(/x{101}/);
  expect(await store.seenReply('r1')).toBe(true);
  expect(await store.seenReply('r2')).toBe(true);
});

test('自分の返信は除く', async () => {
  const store = memoryStore({ now: () => NOW });
  await store.setConfig('repliesInitialized', { at: 'x' });
  const { replies, notify } = mk({ store, posts: [P1], repliesByPost: { m1: [{ id: 'r9', text: '自分の返事', username: 'me', timestamp: 't', permalink: 'p', from: { id: 'u1' } }] } });
  const r = await replies.poll({ token: 'tk', userId: 'u1' });
  expect(r.newReplies).toBe(0);
  expect(notify.owner).not.toHaveBeenCalled();
});

test('知らせに失敗したら既読にしない（次回また知らせる）', async () => {
  const store = memoryStore({ now: () => NOW });
  await store.setConfig('repliesInitialized', { at: 'x' });
  const { replies, notify } = mk({ store, posts: [P1], repliesByPost: { m1: [{ id: 'r1', text: 'hi', username: 'bob', timestamp: 't', permalink: 'p' }] } });
  notify.owner.mockResolvedValueOnce({ ok: false, error: 'HTTP 403' });
  const r = await replies.poll({ token: 'tk', userId: 'u1' });
  expect(r.notified).toBe(0);
  expect(r.errors).toEqual([expect.stringMatching(/403/)]);
  expect(await store.seenReply('r1')).toBe(false);
});

test('1 投稿の listReplies が投げても他は続き errors に残る', async () => {
  const store = memoryStore({ now: () => NOW });
  await store.setConfig('repliesInitialized', { at: 'x' });
  const { replies, notify } = mk({ store, posts: [P1, P2], repliesByPost: { m1: new Error('rate limit'), m2: [{ id: 'r2', text: 'ok', username: 'cat', timestamp: 't', permalink: 'p2' }] } });
  const r = await replies.poll({ token: 'tk', userId: 'u1' });
  expect(r.errors).toEqual([expect.stringMatching(/m1.*rate limit/)]);
  expect(r.newReplies).toBe(1);
  expect(notify.owner).toHaveBeenCalledTimes(1);
});

test('listMyPosts には 7 日前の since を渡す', async () => {
  const { replies, threads } = mk({ posts: [] });
  await replies.poll({ token: 'tk', userId: 'u1' });
  expect(threads.listMyPosts).toHaveBeenCalledWith({ token: 'tk', sinceIso: '2026-10-21T00:05:00.000Z' });
});

test('自分の返信は is_reply_owned_by_me でも除く（実際に頼んでいる fields の形）', async () => {
  const store = memoryStore({ now: () => NOW });
  await store.setConfig('repliesInitialized', { at: 'x' });
  const { replies, notify } = mk({ store, posts: [P1], repliesByPost: { m1: [
    { id: 'r9', text: '自分の返事', username: 'me', timestamp: 't', permalink: 'p', is_reply_owned_by_me: true },
    { id: 'r10', text: '相手', username: 'bob', timestamp: 't', permalink: 'p', is_reply_owned_by_me: false },
  ] } });
  const r = await replies.poll({ token: 'tk', userId: 'u1' });
  expect(r.newReplies).toBe(1);
  expect(notify.owner.mock.calls[0][0]).toMatch(/@bob/);
  expect(notify.owner.mock.calls[0][0]).not.toMatch(/自分の返事/);
});

describe('コメントへの自動返信（2026-10-28 社長「イソが自動で」）', () => {
  function mkAuto({ answer = '嬉しいです！ぜひ一緒に回りましょう⛳' } = {}) {
    const store = memoryStore({ now: () => NOW });
    const threads = {
      listMyPosts: jest.fn(async () => [P1]),
      listReplies: jest.fn(async () => [{ id: 'r1', text: '平日行けます！', username: 'bob', timestamp: 't', permalink: 'pr1', is_reply_owned_by_me: false }]),
      publishReply: jest.fn(async () => ({ ok: true, mediaId: 'rep1', permalink: 'prep' })),
    };
    const notify = { owner: jest.fn(async () => ({ ok: true })) };
    const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' })) } };
    const replies = createReplies({ threads, store, notify, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' } });
    return { replies, threads, notify, anthropic, store };
  }
  test('新しいコメントに AI が短い返事を書いて投稿し、社長 DM にはコメントと返事を並べて知らせる', async () => {
    const { replies, threads, notify, store, anthropic } = mkAuto();
    await store.setConfig('repliesInitialized', { at: 'x' });
    const r = await replies.poll({ token: 'tk', userId: 'u1' });
    expect(threads.publishReply).toHaveBeenCalledWith({ token: 'tk', userId: 'u1', text: '嬉しいです！ぜひ一緒に回しましょう⛳'.replace('回し', '回り'), replyToId: 'r1' });
    expect(r.replied).toBe(1);
    const msg = notify.owner.mock.calls[0][0];
    expect(msg).toMatch(/@bob/); expect(msg).toMatch(/平日行けます/); expect(msg).toMatch(/↩/); expect(msg).toMatch(/嬉しいです/);
    const prompt = JSON.stringify(anthropic.messages.create.mock.calls[0][0]);
    expect(prompt).toMatch(/平日行けます/); expect(prompt).toMatch(/名古屋/);
  });
  test('AI が「SKIP」と答えたら返事せず知らせだけ（営業・荒らし・意味不明）', async () => {
    const { replies, threads, notify, store } = mkAuto({ answer: 'SKIP' });
    await store.setConfig('repliesInitialized', { at: 'x' });
    const r = await replies.poll({ token: 'tk', userId: 'u1' });
    expect(threads.publishReply).not.toHaveBeenCalled();
    expect(r.replied).toBe(0);
    expect(notify.owner.mock.calls[0][0]).toMatch(/返事なし/);
  });
  test('THREADS_AUTO_REPLY が true でなければ従来どおり知らせるだけ', async () => {
    const { replies, threads, store } = mkAuto();
    const r2 = createReplies({ threads, store, notify: { owner: jest.fn(async () => ({ ok: true })) }, now: () => NOW, anthropic: {}, env: {} });
    await store.setConfig('repliesInitialized', { at: 'x' });
    await r2.poll({ token: 'tk', userId: 'u1' });
    expect(threads.publishReply).not.toHaveBeenCalled();
  });
});

describe('公式: 質問・答えにくいコメントは HP のリンクで案内（2026-10-31 社長）', () => {
  const LINKS = {
    top: { url: 'https://selfcafe.jp/', label: 'トップ' },
    faq: { url: 'https://selfcafe.jp/faq/', label: 'よくある質問' },
    membership: { url: 'https://selfcafe.jp/membership/', label: 'サブスク' },
  };
  function mkGuide(answer, { storeUrl } = {}) {
    const store = memoryStore({ now: () => NOW });
    const threads = {
      listMyPosts: jest.fn(async () => [P1]),
      listReplies: jest.fn(async () => [{ id: 'r1', text: '料金はいくらですか？', username: 'bob', timestamp: 't', permalink: 'pr1', is_reply_owned_by_me: false }]),
      publishReply: jest.fn(async () => ({ ok: true, mediaId: 'rep1', permalink: 'prep' })),
    };
    const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' })) } };
    const replies = createReplies({ threads, store, notify: { owner: jest.fn(async () => ({ ok: true })) }, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' }, guideLinks: LINKS });
    return { replies, threads, anthropic, store, storeUrl };
  }

  test('[LINK:キー] を HP の URL に置き換えて返事する', async () => {
    const { replies, threads, store } = mkGuide('ご質問ありがとうございます。料金はこちらにまとめています [LINK:membership]');
    await store.setConfig('repliesInitialized', { at: 'x' });
    await replies.poll({ token: 'tk', userId: 'u1' });
    expect(threads.publishReply.mock.calls[0][0].text).toBe('ご質問ありがとうございます。料金はこちらにまとめています\nhttps://selfcafe.jp/membership/');
  });

  test('知らないキーと、一覧に無い URL は消す', async () => {
    const { replies, threads, store } = mkGuide('こちらをご覧ください https://example.com/x [LINK:nazo]');
    await store.setConfig('repliesInitialized', { at: 'x' });
    await replies.poll({ token: 'tk', userId: 'u1' });
    const t = threads.publishReply.mock.calls[0][0].text;
    expect(t).not.toMatch(/example\.com/); expect(t).not.toMatch(/LINK/);
  });

  test('prompt に案内先の一覧と「質問・答えにくいときはリンクで案内」が入り、投稿の店のページも選べる', async () => {
    const { replies, anthropic, store } = mkGuide('ありがとうございます！ [LINK:store]');
    await store.setConfig('repliesInitialized', { at: 'x' });
    await store.savePost({ mediaId: 'm1', text: '安城駅前店がオープン', storeUrl: 'https://selfcafe.jp/shop/aichi/anjoeki/', storeName: '安城駅前店' });
    const r = await replies.poll({ token: 'tk', userId: 'u1' });
    const prompt = JSON.stringify(anthropic.messages.create.mock.calls[0][0]);
    expect(prompt).toMatch(/LINK:faq/); expect(prompt).toMatch(/LINK:store/); expect(prompt).toMatch(/安城駅前店/);
    expect(prompt).toMatch(/質問/);
    expect(r.replied).toBe(1);
  });

  test('案内先の選び方（値段はトップ・使い方は使い方ページ・faq に値段は無い）が prompt に入る（2026-11-02 社長）', async () => {
    const { replies, anthropic, store } = mkGuide('ご質問ありがとうございます [LINK:top]');
    await store.setConfig('repliesInitialized', { at: 'x' });
    await replies.poll({ token: 'tk', userId: 'u1' });
    const prompt = anthropic.messages.create.mock.calls[0][0].messages[0].content;
    expect(prompt).toMatch(/ドリンクの値段[^\n]*LINK:top/);
    expect(prompt).toMatch(/使い方[^\n]*LINK:usage/);
    expect(prompt).toMatch(/サブスク[^\n]*LINK:membership/);
    expect(prompt).toMatch(/faq[^\n]*ドリンクの値段は載っていない/);
  });

  test('コメントに店名があれば、投稿が店の記事でなくても店舗一覧からその店のページを LINK:store に（2026-11-02 社長「特定の店舗の時は子ページのTOP」）', async () => {
    const store = memoryStore({ now: () => NOW });
    await store.setConfig('repliesInitialized', { at: 'x' });
    await store.savePost({ mediaId: 'm1', text: '集中できます', storeUrl: 'https://selfcafe.jp/shop/aichi/fujigaoka/', storeName: null });
    const threads = { listMyPosts: jest.fn(async () => [P1]), listReplies: jest.fn(async () => [{ id: 'r1', text: '安城駅前店の営業時間は？', username: 'b' }]), publishReply: jest.fn(async () => ({ ok: true })) };
    const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: '店舗ページをご覧ください [LINK:store]' }] })) } };
    const site = { findStore: jest.fn(async (t) => (/安城/.test(t) ? { url: 'https://selfcafe.jp/shop/aichi/anjoeki/', name: 'セルフカフェ 安城駅前店', address: '愛知県安城市' } : null)) };
    await createReplies({ threads, store, notify: { owner: jest.fn(async () => ({ ok: true })) }, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' }, guideLinks: LINKS, site }).poll({ token: 't', userId: 'u' });
    expect(site.findStore).toHaveBeenCalledWith('安城駅前店の営業時間は？');
    expect(anthropic.messages.create.mock.calls[0][0].messages[0].content).toMatch(/LINK:store: セルフカフェ 安城駅前店のページ/);
    expect(threads.publishReply.mock.calls[0][0].text).toBe('店舗ページをご覧ください\nhttps://selfcafe.jp/shop/aichi/anjoeki/');
  });

  test('店舗一覧が読めなくても返事は止めない（店のページ無しで続ける）', async () => {
    const store = memoryStore({ now: () => NOW });
    await store.setConfig('repliesInitialized', { at: 'x' });
    const threads = { listMyPosts: jest.fn(async () => [P1]), listReplies: jest.fn(async () => [{ id: 'r1', text: '藤が丘店は？', username: 'b' }]), publishReply: jest.fn(async () => ({ ok: true })) };
    const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: 'こちらです [LINK:store]' }] })) } };
    const site = { findStore: jest.fn(async () => { throw new Error('一覧が読めない'); }) };
    const r = await createReplies({ threads, store, notify: { owner: jest.fn(async () => ({ ok: true })) }, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' }, guideLinks: LINKS, site }).poll({ token: 't', userId: 'u' });
    expect(r.replied).toBe(1);
    expect(threads.publishReply.mock.calls[0][0].text).toBe('こちらです\nhttps://selfcafe.jp/');
  });

  test('店のページが無い投稿で [LINK:store] を書いたらトップに落とす', async () => {
    const { replies, threads, store } = mkGuide('詳しくはこちら [LINK:store]');
    await store.setConfig('repliesInitialized', { at: 'x' });
    await replies.poll({ token: 'tk', userId: 'u1' });
    expect(threads.publishReply.mock.calls[0][0].text).toBe('詳しくはこちら\nhttps://selfcafe.jp/');
  });

  test('guideLinks が無い（趣味アカウント）なら prompt にリンクの話は入らない', async () => {
    const store = memoryStore({ now: () => NOW });
    await store.setConfig('repliesInitialized', { at: 'x' });
    const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: 'どうも' }] })) } };
    const threads = { listMyPosts: jest.fn(async () => [P1]), listReplies: jest.fn(async () => [{ id: 'r1', text: 'こんにちは', username: 'b' }]), publishReply: jest.fn(async () => ({ ok: true })) };
    await createReplies({ threads, store, notify: { owner: jest.fn(async () => ({ ok: true })) }, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' } }).poll({ token: 't', userId: 'u' });
    expect(JSON.stringify(anthropic.messages.create.mock.calls[0][0])).not.toMatch(/LINK:/);
  });
});

describe('公式: リンクの後始末（レビュー指摘）', () => {
  const LINKS = { top: { url: 'https://selfcafe.jp/', label: 'トップ' }, faq: { url: 'https://selfcafe.jp/faq/', label: 'FAQ' } };
  async function run(answer, setup) {
    const store = memoryStore({ now: () => NOW });
    await store.setConfig('repliesInitialized', { at: 'x' });
    if (setup) await setup(store);
    const threads = { listMyPosts: jest.fn(async () => [P1]), listReplies: jest.fn(async () => [{ id: 'r1', text: '質問です', username: 'b' }]), publishReply: jest.fn(async () => ({ ok: true })) };
    const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: answer }] })) } };
    await createReplies({ threads, store, notify: { owner: jest.fn(async () => ({ ok: true })) }, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' }, guideLinks: LINKS }).poll({ token: 't', userId: 'u' });
    return threads.publishReply.mock.calls[0] && threads.publishReply.mock.calls[0][0].text;
  }
  test('日本語に続く許可済み URL は URL だけ抜いて末尾に回す（文は残す）', async () => {
    expect(await run('詳しくはhttps://selfcafe.jp/faq/をご覧ください。')).toBe('詳しくはをご覧ください。\nhttps://selfcafe.jp/faq/');
  });
  test('URL の直後の「。」は URL に含めない', async () => {
    expect(await run('こちらです https://selfcafe.jp/faq/。')).toBe('こちらです 。\nhttps://selfcafe.jp/faq/');
  });
  test('__proto__ などのキーは無視する', async () => {
    expect(await run('どうぞ [LINK:constructor]')).toBe('どうぞ');
  });
  test('投稿の店のページが返事に付く', async () => {
    const t = await run('ありがとうございます [LINK:store]', (s) => s.savePost({ mediaId: 'm1', text: '安城', storeUrl: 'https://selfcafe.jp/shop/aichi/anjoeki/', storeName: '安城駅前店' }));
    expect(t).toBe('ありがとうございます\nhttps://selfcafe.jp/shop/aichi/anjoeki/');
  });
  test('ふだんの回（店名なし。storeUrl は写真の店）では店のページを付けず、トップに落とす', async () => {
    const t = await run('ありがとうございます [LINK:store]', (s) => s.savePost({ mediaId: 'm1', text: '集中できます', storeUrl: 'https://selfcafe.jp/shop/aichi/fujigaoka/', storeName: null }));
    expect(t).toBe('ありがとうございます\nhttps://selfcafe.jp/');
  });
});

test('投稿に replyTone があれば、そのコメントの返事の調子として AI に渡す（2026-11-03 社長「短文でさわやかに元気で感謝」）', async () => {
  const store = memoryStore({ now: () => NOW });
  await store.setConfig('repliesInitialized', { at: 'x' });
  await store.savePost({ mediaId: P1.id, text: '人生初のフルマラソン', replyTone: '短文でさわやかに元気よく感謝を伝える' });
  const threads = {
    listMyPosts: jest.fn(async () => [P1]),
    listReplies: jest.fn(async () => [{ id: 'r9', text: '水分こまめに！', username: 'amy', timestamp: 't', permalink: 'p', is_reply_owned_by_me: false }]),
    publishReply: jest.fn(async () => ({ ok: true, mediaId: 'x', permalink: 'y' })),
  };
  const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: 'ありがとうございます！' }] })) } };
  const replies = createReplies({ threads, store, notify: { owner: jest.fn(async () => ({ ok: true })) }, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' } });
  await replies.poll({ token: 'tk', userId: 'u1' });
  expect(JSON.stringify(anthropic.messages.create.mock.calls[0][0])).toMatch(/短文でさわやかに元気よく感謝を伝える/);
});

describe('返信への返信も拾う（2026-11-04 社長「返信に返信して、さらに返信きたやつが無視になっちゃってる」）', () => {
  // conversation: 投稿直下（replied_to=投稿）と、自分の返事への返事（replied_to=自分の返信）と、他人同士のやりとり（replied_to=他人の返信）
  const CONV = [
    { id: 'r1', text: '平日行けます！', username: 'bob', timestamp: 't1', permalink: 'pr1', is_reply_owned_by_me: false, replied_to: { id: 'm1' }, root_post: { id: 'm1' } },
    { id: 'mine1', text: 'ありがとうございます！ぜひ！', username: 'me', timestamp: 't2', permalink: 'pm1', is_reply_owned_by_me: true, replied_to: { id: 'r1' }, root_post: { id: 'm1' } },
    { id: 'r2', text: '来週の水曜どうですか？', username: 'bob', timestamp: 't3', permalink: 'pr2', is_reply_owned_by_me: false, replied_to: { id: 'mine1' }, root_post: { id: 'm1' } },
    { id: 'r3', text: '私も行きたい（bobさんへ）', username: 'carol', timestamp: 't4', permalink: 'pr3', is_reply_owned_by_me: false, replied_to: { id: 'r1' }, root_post: { id: 'm1' } },
  ];
  function mkConv({ conv = CONV, withListReplies = false } = {}) {
    const store = memoryStore({ now: () => NOW });
    const threads = {
      listMyPosts: jest.fn(async () => [P1]),
      listConversation: jest.fn(async () => conv),
      publishReply: jest.fn(async () => ({ ok: true, mediaId: 'rep', permalink: 'prep' })),
      ...(withListReplies ? { listReplies: jest.fn(async () => conv.filter((c) => c.replied_to.id === 'm1')) } : {}),
    };
    const notify = { owner: jest.fn(async () => ({ ok: true })) };
    const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: '水曜いいですね！' }], stop_reason: 'end_turn' })) } };
    const replies = createReplies({ threads, store, notify, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' } });
    return { replies, threads, notify, anthropic, store };
  }
  test('会話全体（conversation）を読み、自分の返事への返事にも返す。他人同士のやりとりには返さず既読にする', async () => {
    const { replies, threads, anthropic, store } = mkConv();
    await store.setConfig('repliesInitialized', { at: 'x' });
    const r = await replies.poll({ token: 'tk', userId: 'u1' });
    expect(threads.listConversation).toHaveBeenCalledWith({ token: 'tk', mediaId: 'm1' });
    const to = threads.publishReply.mock.calls.map((c) => c[0].replyToId).sort();
    expect(to).toEqual(['r1', 'r2']); // mine1 は自分、r3 は他人への返事
    expect(r.replied).toBe(2);
    expect(await store.seenReply('r3')).toBeTruthy();
    expect(await store.seenReply('mine1')).toBeFalsy();
  });
  test('自分の返事への返事には、直前の自分の返事を AI に渡す（話の続きとして返す）', async () => {
    const { replies, anthropic, store } = mkConv();
    await store.setConfig('repliesInitialized', { at: 'x' });
    await replies.poll({ token: 'tk', userId: 'u1' });
    const prompts = anthropic.messages.create.mock.calls.map((c) => JSON.stringify(c[0]));
    const p2 = prompts.find((p) => /来週の水曜/.test(p));
    expect(p2).toMatch(/ありがとうございます！ぜひ！/);
    expect(p2).toMatch(/自分の前の返事/);
    const p1 = prompts.find((p) => /平日行けます/.test(p));
    expect(p1).not.toMatch(/自分の前の返事/);
  });
  test('listConversation が無い・失敗したら listReplies に戻る', async () => {
    const d = mkConv({ withListReplies: true });
    d.threads.listConversation.mockImplementation(async () => { throw new Error('boom'); });
    await d.store.setConfig('repliesInitialized', { at: 'x' });
    const r = await d.replies.poll({ token: 'tk', userId: 'u1' });
    expect(d.threads.listReplies).toHaveBeenCalled();
    expect(r.errors).toEqual([]);
    expect(d.threads.publishReply.mock.calls.map((c) => c[0].replyToId)).toEqual(['r1']);
  });
});

describe('返信への返信の歯止め（2026-11-04 レビュー指摘）', () => {
  const base = { username: 'bob', timestamp: '2026-10-28T00:00:00+0000', is_reply_owned_by_me: false, root_post: { id: 'm1' } };
  const mine = (id, to) => ({ ...base, id, text: `返事${id}`, username: 'me', is_reply_owned_by_me: true, replied_to: { id: to } });
  function mkConv(conv, env = {}) {
    const store = memoryStore({ now: () => NOW });
    const threads = {
      listMyPosts: jest.fn(async () => [P1]),
      listConversation: jest.fn(async () => conv),
      listReplies: jest.fn(async () => conv.filter((c) => c.replied_to && c.replied_to.id === 'm1' && !c.is_reply_owned_by_me)),
      publishReply: jest.fn(async () => ({ ok: true, mediaId: 'rep', permalink: 'prep' })),
    };
    const notify = { owner: jest.fn(async () => ({ ok: true })) };
    const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: 'そうですね！' }], stop_reason: 'end_turn' })) } };
    const replies = createReplies({ threads, store, notify, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true', ...env } });
    return { replies, threads, notify, anthropic, store };
  }
  test('自分の返事が 3 段続いた相手には返さない（既読にして知らせには「やりとり上限」）', async () => {
    const conv = [
      { ...base, id: 'r1', text: '1', replied_to: { id: 'm1' } }, mine('a1', 'r1'),
      { ...base, id: 'r2', text: '2', replied_to: { id: 'a1' } }, mine('a2', 'r2'),
      { ...base, id: 'r3', text: '3', replied_to: { id: 'a2' } }, mine('a3', 'r3'),
      { ...base, id: 'r4', text: '4', replied_to: { id: 'a3' } },
    ];
    const d = mkConv(conv);
    await d.store.setConfig('repliesInitialized', { at: 'x' });
    for (const id of ['r1', 'r2', 'r3']) await d.store.markReplySeen(id, { replied: true });
    const r = await d.replies.poll({ token: 'tk', userId: 'u1' });
    expect(d.threads.publishReply).not.toHaveBeenCalled();
    expect(r.newReplies).toBe(1);
    expect(d.notify.owner.mock.calls[0][0]).toMatch(/やりとり上限/);
    expect(await d.store.seenReply('r4')).toBeTruthy();
  });
  test('replied_to が 1 件も無い（会話の形が取れていない）ときは従来の投稿直下だけに戻す', async () => {
    const conv = [{ ...base, id: 'r1', text: '1', replied_to: null }, { ...base, id: 'r2', text: '2', replied_to: null, username: 'carol' }];
    const d = mkConv(conv.map((c) => ({ ...c, replied_to: undefined })));
    d.threads.listReplies.mockImplementation(async () => [{ ...base, id: 'r1', text: '1' }]);
    await d.store.setConfig('repliesInitialized', { at: 'x' });
    await d.replies.poll({ token: 'tk', userId: 'u1' });
    expect(d.threads.listReplies).toHaveBeenCalled();
    expect(d.threads.publishReply.mock.calls.map((c) => c[0].replyToId)).toEqual(['r1']);
  });
  test('親が一覧に無い返事は既読にせず errors に残す（消えないように）', async () => {
    const d = mkConv([{ ...base, id: 'r9', text: 'x', replied_to: { id: 'gone' } }]);
    await d.store.setConfig('repliesInitialized', { at: 'x' });
    const r = await d.replies.poll({ token: 'tk', userId: 'u1' });
    expect(await d.store.seenReply('r9')).toBeFalsy();
    expect(r.errors.join()).toMatch(/親/);
  });
  test('自分の返事への返事が 2 日より古いものは、返さずに既読にする（切り替え直後に古い会話へまとめて返さない）', async () => {
    const old = '2026-10-20T00:00:00+0000';
    const d = mkConv([{ ...base, id: 'r1', text: '1', replied_to: { id: 'm1' }, timestamp: old }, mine('a1', 'r1'), { ...base, id: 'r2', text: '2', replied_to: { id: 'a1' }, timestamp: old }]);
    await d.store.setConfig('repliesInitialized', { at: 'x' });
    await d.store.markReplySeen('r1', { replied: true });
    const r = await d.replies.poll({ token: 'tk', userId: 'u1' });
    expect(d.threads.publishReply).not.toHaveBeenCalled();
    expect(r.newReplies).toBe(0);
    expect(await d.store.seenReply('r2')).toBeTruthy();
  });
  test('続きの返事には HP のリンク案内を付けない（公式アカウント）', async () => {
    const d = mkConv([{ ...base, id: 'r1', text: '1', replied_to: { id: 'm1' } }, mine('a1', 'r1'), { ...base, id: 'r2', text: '値段は？', replied_to: { id: 'a1' } }]);
    const guided = createReplies({ threads: d.threads, store: d.store, notify: d.notify, now: () => NOW, anthropic: d.anthropic, env: { THREADS_AUTO_REPLY: 'true' }, guideLinks: { top: { url: 'https://selfcafe.jp/', label: 'トップ' } } });
    await d.store.setConfig('repliesInitialized', { at: 'x' });
    await d.store.markReplySeen('r1', { replied: true });
    await guided.poll({ token: 'tk', userId: 'u1' });
    const p = JSON.stringify(d.anthropic.messages.create.mock.calls[0][0]);
    expect(p).toMatch(/値段は/); expect(p).not.toMatch(/LINK:top/);
  });
});

test('一人参加・不安のコメントには「自分も初めて・現地で会いたい・いつから滞在？」の指示が prompt に入る（2026-11-04 社長）。公式アカウントには入らない', async () => {
  const store = memoryStore({ now: () => NOW });
  const threads = {
    listMyPosts: jest.fn(async () => [P1]),
    listReplies: jest.fn(async () => [{ id: 'r1', text: '一人で参加なので不安です…', username: 'bob', timestamp: 't', permalink: 'pr1', is_reply_owned_by_me: false }]),
    publishReply: jest.fn(async () => ({ ok: true })),
  };
  const notify = { owner: jest.fn(async () => ({ ok: true })) };
  const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: '自分も初めてです！ぜひ現地で会いましょう。いつから滞在予定ですか？' }], stop_reason: 'end_turn' })) } };
  const hobby = createReplies({ threads, store, notify, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' } });
  await store.setConfig('repliesInitialized', { at: 'x' });
  await hobby.poll({ token: 'tk', userId: 'u1' });
  const p = JSON.stringify(anthropic.messages.create.mock.calls[0][0]);
  for (const w of ['自分も初めて', '現地で会', 'いつから滞在', '12/7', '12/14', 'ゴルフ']) expect(p).toContain(w);
  const cafe = createReplies({ threads, store: memoryStore({ now: () => NOW }), notify, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' }, persona: require('../src/personaCafe') });
  anthropic.messages.create.mockClear();
  await cafe.draftReply({ comment: { text: '不安です', username: 'x' }, post: { text: 't' } });
  expect(JSON.stringify(anthropic.messages.create.mock.calls[0][0])).not.toContain('いつから滞在');
});

test('直近の自分の返事（最大 6 件）を prompt に渡して同じ言い回しを避けさせ、返したあと記録する（2026-11-04 レビュー指摘）', async () => {
  const store = memoryStore({ now: () => NOW });
  await store.setConfig('recentAnswers', { texts: ['自分も初めてです！ぜひ現地で会いましょう。いつから滞在予定ですか？'] });
  const threads = {
    listMyPosts: jest.fn(async () => [P1]),
    listReplies: jest.fn(async () => [{ id: 'r1', text: '一人参加で不安', username: 'bob', timestamp: 't', permalink: 'pr1', is_reply_owned_by_me: false }, { id: 'r2', text: '楽しみ！', username: 'carol', timestamp: 't', permalink: 'pr2', is_reply_owned_by_me: false }]),
    publishReply: jest.fn(async () => ({ ok: true })),
  };
  const notify = { owner: jest.fn(async () => ({ ok: true })) };
  let n = 0;
  const anthropic = { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: `返事${++n}` }], stop_reason: 'end_turn' })) } };
  const replies = createReplies({ threads, store, notify, now: () => NOW, anthropic, env: { THREADS_AUTO_REPLY: 'true' } });
  await store.setConfig('repliesInitialized', { at: 'x' });
  await replies.poll({ token: 'tk', userId: 'u1' });
  const p1 = JSON.stringify(anthropic.messages.create.mock.calls[0][0]);
  expect(p1).toMatch(/直近の自分の返事/); expect(p1).toMatch(/いつから滞在予定ですか/);
  const p2 = JSON.stringify(anthropic.messages.create.mock.calls[1][0]);
  expect(p2).toMatch(/返事1/); // 同じ見回りの中で書いた返事も次の prompt に入る
  expect((await store.getConfig('recentAnswers')).texts).toEqual(['返事2', '返事1', '自分も初めてです！ぜひ現地で会いましょう。いつから滞在予定ですか？']);
});
