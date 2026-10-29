const { runCafeTick, pickCafeType, CAFE_WINDOWS } = require('../src/cafeTick');
const { drawSlots } = require('../src/slots');
const { memoryStore } = require('../src/store');

const at = (hm, d = '2026-10-29') => new Date(`${d}T${hm}:00+09:00`);
const TOKEN = { token: 'ctk', userId: 'cafe1', expiresAt: '2026-12-20T00:00:00.000Z' };
const FACTS = { name: 'セルフカフェ 藤が丘店', area: '名古屋市名東区', station: '藤が丘駅', hours: '7:00〜23:00', holiday: 'なし', seats: '30席', paid: { 個室ブース: true, 会議室: false }, images: [] };
const PHOTO = { id: 'hp:x', url: 'https://selfcafe.jp/wp_control/wp-content/uploads/a.jpg', name: 'HP: セルフカフェ 藤が丘店', mediaType: 'image/jpeg', bytes: Buffer.from('i') };

function deps(over = {}) {
  const store = over.store || memoryStore({ now: () => over.now || at('11:20'), prefix: 'threads_cafe_' });
  return {
    store,
    threads: { publishPost: jest.fn(async () => ({ ok: true, mediaId: 'cm1', permalink: 'https://www.threads.net/@selfcafe/post/1' })), refreshToken: jest.fn() },
    writer: { writePost: jest.fn(async () => ({ ok: true, text: '藤が丘駅から徒歩2分の藤が丘店は…', type: 'store', attempts: 1, tag: 'セルフカフェ' })) },
    notify: { owner: jest.fn(async () => ({ ok: true })) },
    site: { pickStore: jest.fn(async () => ({ url: 'https://selfcafe.jp/shop/aichi/fujigaoka/', facts: FACTS, photo: PHOTO })) },
    anthropic: {},
    env: { THREADS_COPY_TO_OWNER: 'true', ...(over.env || {}) },
    now: () => over.now || at('11:20'),
    draw: () => ({ slots: ['11:17', '18:41'] }),
    mode: over.mode || 'live',
  };
}

test('公式の枠は昼 11:00〜13:30・夕 17:00〜20:00 の 2 本（1 本少ない日は無い）', () => {
  for (let k = 0; k < 100; k++) {
    const { slots } = drawSlots('2026-10-29', () => ((k * 0.37) + 0.13) % 1, { windows: CAFE_WINDOWS, oneLess: false });
    expect(slots).toHaveLength(2);
  }
});

test('鍵が無ければ黙って何もしない（errors なし）', async () => {
  const d = deps();
  const r = await runCafeTick(d);
  expect(r).toMatchObject({ ok: true, noToken: true, errors: [] });
  expect(d.site.pickStore).not.toHaveBeenCalled();
});

test('時刻の枠で HP の店を選び、事実と写真で書いて投稿。写真は selfcafe.jp の URL、写しに【公式】', async () => {
  const d = deps();
  await d.store.setToken(TOKEN);
  const r = await runCafeTick(d);
  expect(r.posted).toEqual([expect.objectContaining({ mediaId: 'cm1', store: 'セルフカフェ 藤が丘店' })]);
  const call = d.writer.writePost.mock.calls[0][0];
  expect(call.persona.SYSTEM).toMatch(/公式 Threads/);
  expect(call.facts).toMatch(/藤が丘駅/);
  expect(call.facts).toMatch(/会議室 なし/);
  expect(call.photo).toBe(PHOTO);
  expect(call.banned).toEqual(expect.arrayContaining(['鈴木大基']));
  expect(call.banned).not.toContain('セルフカフェ');
  expect(d.threads.publishPost).toHaveBeenCalledWith(expect.objectContaining({ token: 'ctk', userId: 'cafe1', imageUrl: PHOTO.url, topicTag: 'セルフカフェ' }));
  expect((await d.store.recentPosts(1))[0]).toMatchObject({ storeUrl: 'https://selfcafe.jp/shop/aichi/fujigaoka/' });
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/^【公式】/);
});

test('最近紹介した店の URL を pickStore に渡す（同じ店が続かない）', async () => {
  const d = deps();
  await d.store.setToken(TOKEN);
  await d.store.savePost({ mediaId: 'old', text: 't', type: 'store', source: 'auto', postedAt: '2026-10-28T03:00:00.000Z', storeUrl: 'https://selfcafe.jp/shop/aichi/akatsuka/' });
  await runCafeTick(d);
  expect(d.site.pickStore).toHaveBeenCalledWith({ recentUrls: ['https://selfcafe.jp/shop/aichi/akatsuka/'] });
});

test('dry は投稿せず店名と本文を返す', async () => {
  const d = deps({ mode: 'dry', now: at('09:00') });
  await d.store.setToken(TOKEN);
  const r = await runCafeTick(d);
  expect(r.preview).toMatchObject({ store: 'セルフカフェ 藤が丘店', photoUrl: PHOTO.url });
  expect(d.threads.publishPost).not.toHaveBeenCalled();
});

test('CAFE_ENABLED=false なら止まる', async () => {
  const d = deps({ env: { CAFE_ENABLED: 'false' } });
  await d.store.setToken(TOKEN);
  expect(await runCafeTick(d)).toMatchObject({ disabled: true });
});

test('pickCafeType は直近 2 本の型を避ける', () => {
  for (let i = 0; i < 50; i++) expect(['store', 'work']).not.toContain(pickCafeType(['store', 'work']));
});

test('store の prefix で趣味用と公式の記録が混ざらない', async () => {
  const { fakeDb, createStore } = require('../src/store');
  const db = fakeDb();
  const hobby = createStore(db); const cafe = createStore(db, { prefix: 'threads_cafe_' });
  await hobby.setToken({ token: 'h', userId: 'u1' });
  expect(await cafe.getToken()).toBeNull();
  await cafe.setToken({ token: 'c', userId: 'u2' });
  expect((await hobby.getToken()).token).toBe('h');
  expect([...db._cols.keys()].sort()).toEqual(['threads_cafe_config', 'threads_config']);
});

test('鍵が無くても dry なら文を作って見せる（接続前の確認用）', async () => {
  const d = deps({ mode: 'dry', now: at('09:00') });
  const r = await runCafeTick(d);
  expect(r.preview).toMatchObject({ store: 'セルフカフェ 藤が丘店' });
});

describe('公式にも試験・暦・継続のコツ・名言（2026-10-29 社長「これセルフカフェの公式の方もね 偉人の名言もセルフはいれていこう」）', () => {
  const personaCafe = require('../src/personaCafe');
  const { SEARCH_TYPES } = require('../src/writer');
  test('型に countdown・koyomi・tips・quote があり、どれも検索で確かめる', () => {
    expect(personaCafe.TYPES).toEqual(expect.arrayContaining(['countdown', 'koyomi', 'tips', 'quote']));
    for (const t of ['countdown', 'koyomi', 'tips', 'quote']) {
      expect(personaCafe.TYPE_GUIDE[t]).toBeTruthy();
      expect(SEARCH_TYPES).toContain(t);
    }
    expect(personaCafe.SYSTEM).toMatch(/名言/);
  });
  test('pickCafeType で新しい型も出る', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(pickCafeType([]));
    for (const t of ['countdown', 'koyomi', 'tips', 'quote']) expect(seen).toContain(t);
  });
  test('名言は趣味用には入れない', () => {
    expect(require('../src/writer').TYPES).not.toContain('quote');
  });
});
