const { createStock, STOCK_COOLDOWN_DAYS, stockSig } = require('../src/stock');
const { memoryStore } = require('../src/store');

const NOW = new Date('2026-10-28T09:20:00+09:00');
const ENV = { PIXABAY_API_KEY: 'pk', CRON_KEY: 'tbkey', PUBLIC_BASE_URL: 'https://tb.example' };
const HITS = [
  { id: 101, imageWidth: 4000, imageHeight: 2600, user: 'Ann', pageURL: 'https://pixabay.com/photos/101/', largeImageURL: 'https://pixabay.com/get/101_1280.jpg', webformatURL: 'https://pixabay.com/get/101_640.jpg' },
  { id: 102, imageWidth: 3000, imageHeight: 2000, user: 'Bob', pageURL: 'https://pixabay.com/photos/102/', largeImageURL: 'https://pixabay.com/get/102_1280.jpg', webformatURL: 'https://pixabay.com/get/102_640.jpg' },
];

function mk({ hits = HITS, env = ENV, store = memoryStore({ now: () => NOW }), rng = () => 0, fetchImage } = {}) {
  const http = {
    get: jest.fn(async (url, opts) => {
      if (/pixabay\.com\/api\/?$/.test(url)) {
        const id = opts && opts.params && opts.params.id;
        return { data: { hits: id ? hits.filter((h) => String(h.id) === String(id)) : hits } };
      }
      if (fetchImage) return fetchImage(url);
      return { status: 200, headers: { 'content-type': 'image/jpeg' }, data: Buffer.from('jpgbytes') };
    }),
  };
  return { stock: createStock({ http, store, env, now: () => NOW, rng }), http, store };
}

test('search: Pixabay を叩いて横長の写真を 1 枚選び、自分の公開 URL（Meta が取りに来る）と撮影者を返す', async () => {
  const { stock, http } = mk({ rng: () => 0.9 });
  const p = await stock.search('autumn golf course');
  expect(p).toEqual({ id: 'pixabay:102', url: `https://tb.example/media/stock/102.jpg?sig=${stockSig('102', ENV)}`, name: 'Pixabay: Bob', page: 'https://pixabay.com/photos/102/', photographer: 'Bob' });
  const call = http.get.mock.calls[0];
  expect(call[0]).toBe('https://pixabay.com/api/');
  expect(call[1].params).toMatchObject({ key: 'pk', q: 'autumn golf course', image_type: 'photo', orientation: 'horizontal', safesearch: 'true', per_page: 20 });
});

test('search: 最近使った写真は避ける。鍵が無い・結果なし・失敗は null', async () => {
  const { stock, store } = mk({ rng: () => 0 });
  await store.markPhotoUsed('pixabay:101');
  expect((await stock.search('x')).id).toBe('pixabay:102');
  expect(await mk({ env: { CRON_KEY: 'k', PUBLIC_BASE_URL: 'x' } }).stock.search('x')).toBeNull();
  expect(await mk({ hits: [] }).stock.search('x')).toBeNull();
  const bad = mk();
  bad.http.get.mockRejectedValueOnce(new Error('429'));
  expect(await bad.stock.search('x')).toBeNull();
});

test('search: 画像を実際に取って確かめる（取れなければ null）。serve は同じ画像を返す（ホットリンクせず自分で出す）', async () => {
  const { stock, http } = mk({ fetchImage: async () => { throw new Error('403'); } });
  expect(await stock.search('x')).toBeNull();
  expect(http.get.mock.calls.some((c) => /_1280\.jpg/.test(c[0]))).toBe(true);
  const ok = mk({ rng: () => 0 });
  const p = await ok.stock.search('x');
  const served = await ok.stock.serve('101', stockSig('101', ENV));
  expect(served.toString()).toBe('jpgbytes');
  expect(await ok.stock.serve('101', 'wrong')).toBeNull();
  expect(p.id).toBe('pixabay:101');
  // 別インスタンスでも id から Pixabay に聞き直して出せる
  const other = mk();
  expect((await other.stock.serve('102', stockSig('102', ENV))).toString()).toBe('jpgbytes');
});

test('STOCK_COOLDOWN_DAYS は 180', () => expect(STOCK_COOLDOWN_DAYS).toBe(180));
