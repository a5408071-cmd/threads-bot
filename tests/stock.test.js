const { createStock, STOCK_COOLDOWN_DAYS } = require('../src/stock');
const { memoryStore } = require('../src/store');

const NOW = new Date('2026-10-28T09:20:00+09:00');
const PHOTOS = [
  { id: 101, width: 4000, height: 2600, photographer: 'Ann', url: 'https://www.pexels.com/photo/101/', src: { large2x: 'https://images.pexels.com/101/large2x.jpg', large: 'https://images.pexels.com/101/large.jpg' } },
  { id: 102, width: 3000, height: 2000, photographer: 'Bob', url: 'https://www.pexels.com/photo/102/', src: { large2x: 'https://images.pexels.com/102/large2x.jpg', large: 'https://images.pexels.com/102/large.jpg' } },
];

function mk({ photos = PHOTOS, env = { PEXELS_API_KEY: 'pk' }, store = memoryStore({ now: () => NOW }), rng = () => 0, head } = {}) {
  const http = {
    get: jest.fn(async (url, opts) => {
      if (/api\.pexels\.com/.test(url)) return { data: { photos } };
      if (head) return head(url);
      return { status: 200, headers: { 'content-type': 'image/jpeg' }, data: Buffer.from('jpg') };
    }),
  };
  return { stock: createStock({ http, store, env, now: () => NOW, rng }), http, store };
}

test('search: Pexels を叩いて横長の写真を 1 枚選び、Meta が取れる URL と撮影者を返す', async () => {
  const { stock, http } = mk({ rng: () => 0.9 });
  const p = await stock.search('autumn golf course');
  expect(p).toEqual({ id: 'pexels:102', url: 'https://images.pexels.com/102/large2x.jpg', name: 'Pexels: Bob', page: 'https://www.pexels.com/photo/102/', photographer: 'Bob' });
  const call = http.get.mock.calls[0];
  expect(call[0]).toBe('https://api.pexels.com/v1/search');
  expect(call[1]).toMatchObject({ headers: { Authorization: 'pk' }, params: { query: 'autumn golf course', orientation: 'landscape', per_page: 15 } });
});

test('search: 最近使った写真は避ける。鍵が無い・結果なし・失敗は null', async () => {
  const { stock, store } = mk({ rng: () => 0 });
  await store.markPhotoUsed('pexels:101');
  expect((await stock.search('x')).id).toBe('pexels:102');
  expect(await mk({ env: {} }).stock.search('x')).toBeNull();
  expect(await mk({ photos: [] }).stock.search('x')).toBeNull();
  const bad = mk();
  bad.http.get.mockRejectedValueOnce(new Error('429'));
  expect(await bad.stock.search('x')).toBeNull();
});

test('search: 画像 URL を実際に開いて確かめる（開けなければ null）', async () => {
  const { stock, http } = mk({ head: async () => { throw new Error('403'); } });
  expect(await stock.search('x')).toBeNull();
  expect(http.get.mock.calls.some((c) => /large2x\.jpg/.test(c[0]))).toBe(true);
});

test('STOCK_COOLDOWN_DAYS は 180', () => expect(STOCK_COOLDOWN_DAYS).toBe(180));
