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
