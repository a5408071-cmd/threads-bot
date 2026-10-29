const { runCafeTick, pickCafeType, CAFE_WINDOWS } = require('../src/cafeTick');
const { drawSlots } = require('../src/slots');
const { memoryStore } = require('../src/store');

const at = (hm, d = '2026-10-29') => new Date(`${d}T${hm}:00+09:00`);
const TOKEN = { token: 'ctk', userId: 'cafe1', expiresAt: '2026-12-20T00:00:00.000Z' };
const NEWS_ITEM = { url: 'https://selfcafe.jp/newstore/1/', date: '2026-10-13', category: '新店舗情報', title: '岐阜県大垣市に「セルフカフェイオンタウン大垣店」10月31日(土)10:30OPEN' };
const ANNOUNCE = { item: NEWS_ITEM, text: 'イオンタウン大垣内に、Wi-Fi・電源完備の無人カフェがオープンします。営業時間：10:30～22:00', shopUrl: 'https://selfcafe.jp/shop/gifu/aeontown-ogaki/', storeName: 'セルフカフェイオンタウン大垣店', photo: null };
const PHOTO = { id: 'hp:x', url: 'https://selfcafe.jp/wp_control/wp-content/uploads/a.jpg', name: 'HP: セルフカフェ 藤が丘店', mediaType: 'image/jpeg', bytes: Buffer.from('i') };

function deps(over = {}) {
  const store = over.store || memoryStore({ now: () => over.now || at('11:20'), prefix: 'threads_cafe_' });
  return {
    store,
    threads: { publishPost: jest.fn(async () => ({ ok: true, mediaId: 'cm1', permalink: 'https://www.threads.net/@selfcafe/post/1' })), refreshToken: jest.fn() },
    writer: { writePost: jest.fn(async () => ({ ok: true, text: '藤が丘駅から徒歩2分の藤が丘店は…', type: 'store', attempts: 1, tag: 'セルフカフェ' })) },
    notify: { owner: jest.fn(async () => ({ ok: true })) },
    site: {
      pickPhoto: jest.fn(async () => ({ url: 'https://selfcafe.jp/shop/aichi/fujigaoka/', photo: PHOTO })),
      pendingAnnouncements: jest.fn(async () => over.news || []),
      announcement: jest.fn(async () => ANNOUNCE),
    },
    anthropic: {},
    env: { THREADS_COPY_TO_OWNER: 'true', ...(over.env || {}) },
    now: () => over.now || at('11:20'),
    draw: () => ({ slots: ['11:17', '18:41'] }),
    mode: over.mode || 'live',
  };
}

test('公式の枠は 1 日 5 本（朝・昼前・昼過ぎ・夕・夜。2026-10-29 社長「毎日5投稿いける」）、間は 90 分以上、1 本少ない日は無い', () => {
  for (let k = 0; k < 100; k++) {
    const { slots } = drawSlots('2026-10-29', () => ((k * 0.37) + 0.13) % 1, { windows: CAFE_WINDOWS, oneLess: false });
    expect(slots).toHaveLength(5);
    const mins = slots.map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));
    for (let i = 1; i < mins.length; i++) expect(mins[i] - mins[i - 1]).toBeGreaterThanOrEqual(90);
    expect(slots[0] >= '07:00' && slots[4] <= '21:30').toBe(true);
  }
});

test('鍵が無ければ黙って何もしない（errors なし）', async () => {
  const d = deps();
  const r = await runCafeTick(d);
  expect(r).toMatchObject({ ok: true, noToken: true, errors: [] });
  expect(d.site.pickPhoto).not.toHaveBeenCalled();
});

test('ふだんの回は店名を出さない: 全店共通の事実だけ渡し、写真は HP のどこかの店の写真（店名は書かせない）。写しに【公式】', async () => {
  const d = deps();
  await d.store.setToken(TOKEN);
  const r = await runCafeTick(d);
  expect(r.posted).toEqual([expect.objectContaining({ mediaId: 'cm1' })]);
  const call = d.writer.writePost.mock.calls[0][0];
  expect(call.persona.SYSTEM).toMatch(/公式 Threads/);
  expect(call.facts).toMatch(/特定の店を紹介しない/);
  expect(call.facts).not.toMatch(/藤が丘/);
  expect(['newstore', 'campaign', 'store', 'area']).not.toContain(call.type);
  expect(call.photo).toBe(PHOTO);
  expect(call.banned).toEqual(expect.arrayContaining(['鈴木大基']));
  expect(d.threads.publishPost).toHaveBeenCalledWith(expect.objectContaining({ token: 'ctk', userId: 'cafe1', imageUrl: PHOTO.url, topicTag: 'セルフカフェ' }));
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/^【公式】/);
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/全店/);
});

test('写真は最近使った店を避ける', async () => {
  const d = deps();
  await d.store.setToken(TOKEN);
  await d.store.savePost({ mediaId: 'old', text: 't', type: 'work', source: 'auto', postedAt: '2026-10-28T03:00:00.000Z', storeUrl: 'https://selfcafe.jp/shop/aichi/akatsuka/' });
  await runCafeTick(d);
  expect(d.site.pickPhoto).toHaveBeenCalledWith({ recentUrls: ['https://selfcafe.jp/shop/aichi/akatsuka/'] });
});

test('新店舗・キャンペーンの記事があれば、その回は記事の事実で店名入りの告知。告知した記事は二度と出さず、1 日 1 本まで', async () => {
  const d = deps({ news: [NEWS_ITEM] });
  await d.store.setToken(TOKEN);
  await runCafeTick(d);
  const call = d.writer.writePost.mock.calls[0][0];
  expect(call.type).toBe('newstore');
  expect(call.facts).toMatch(/イオンタウン大垣/);
  expect(call.facts).toMatch(/10:30～22:00/);
  expect(d.notify.owner.mock.calls[0][0]).toMatch(/セルフカフェイオンタウン大垣店/);
  // 同じ日の 2 本目（夕方）はふだんの回
  const d2 = deps({ store: d.store, news: [NEWS_ITEM, { ...NEWS_ITEM, url: 'https://selfcafe.jp/campaign/2/', category: 'キャンペーン' }], now: at('18:45') });
  await runCafeTick(d2);
  expect(d2.site.announcement).not.toHaveBeenCalled();
  expect(d2.writer.writePost.mock.calls[0][0].type).not.toBe('newstore');
  // 翌日は告知済みの記事を飛ばして次の記事
  const d3 = deps({ store: d.store, news: [NEWS_ITEM, { ...NEWS_ITEM, url: 'https://selfcafe.jp/campaign/2/', category: 'キャンペーン' }], now: at('11:20', '2026-10-30') });
  await runCafeTick(d3);
  expect(d3.site.announcement).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://selfcafe.jp/campaign/2/' }));
});

test('告知の投稿に失敗したら告知済みにしない（次の回にもう一度）', async () => {
  const d = deps({ news: [NEWS_ITEM] });
  d.threads.publishPost = jest.fn(async () => ({ ok: false, stage: 'publish', error: 'x' }));
  await d.store.setToken(TOKEN);
  await runCafeTick(d);
  expect(await d.store.getConfig('announced')).toBeFalsy();
});

test('記事が読めなくても、ふだんの回として投稿は止めない', async () => {
  const d = deps({ news: [NEWS_ITEM] });
  d.site.pendingAnnouncements = jest.fn(async () => { throw new Error('timeout'); });
  await d.store.setToken(TOKEN);
  const r = await runCafeTick(d);
  expect(r.posted).toHaveLength(1);
});

test('dry は投稿せず店名と本文を返す', async () => {
  const d = deps({ mode: 'dry', now: at('09:00') });
  await d.store.setToken(TOKEN);
  const r = await runCafeTick(d);
  expect(r.preview).toMatchObject({ photoUrl: PHOTO.url });
  expect(d.threads.publishPost).not.toHaveBeenCalled();
});

test('CAFE_ENABLED=false なら止まる', async () => {
  const d = deps({ env: { CAFE_ENABLED: 'false' } });
  await d.store.setToken(TOKEN);
  expect(await runCafeTick(d)).toMatchObject({ disabled: true });
});

test('pickCafeType は直近 2 本の型を避け、店名の要る型（store・area・newstore・campaign）は選ばない', () => {
  for (let i = 0; i < 200; i++) expect(['study', 'work', 'store', 'area', 'newstore', 'campaign']).not.toContain(pickCafeType(['study', 'work']));
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
  expect(r.preview.text).toBeTruthy();
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

test('noStoreCheck: ふだんの回の店名・駅名を止める（最寄り駅・主要駅などの一般語は通す）', () => {
  const { noStoreCheck } = require('../src/cafeTick');
  expect(noStoreCheck('セルフカフェ栄店は朝から').ok).toBe(false);
  expect(noStoreCheck('藤が丘駅から近い').ok).toBe(false);
  expect(noStoreCheck('「栄」駅から').ok).toBe(false);
  expect(noStoreCheck('最寄り駅の近くや主要駅、全国のセルフカフェで。無人店舗です').ok).toBe(true);
});

test('ふだんの回は writePost に店名の検査（check）を渡す。告知の回は渡さない', async () => {
  const d = deps();
  await d.store.setToken(TOKEN);
  await runCafeTick(d);
  expect(typeof d.writer.writePost.mock.calls[0][0].check).toBe('function');
  const d2 = deps({ news: [NEWS_ITEM] });
  await d2.store.setToken(TOKEN);
  await runCafeTick(d2);
  expect(d2.writer.writePost.mock.calls[0][0].check).toBeFalsy();
});
