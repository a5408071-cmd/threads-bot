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
});
