const { parseStoreList, parseStorePage, createCafeSite } = require('../src/cafeSite');

const LIST = `<a href="https://selfcafe.jp/shop/aichi/akatsuka/">赤塚</a><a href="https://selfcafe.jp/shop/aichi/anjoeki/">安城駅</a><a href="https://selfcafe.jp/shop/aichi/akatsuka/">dup</a><a href="https://selfcafe.jp/about/">x</a>`;
const PAGE = `<div class="shop-header"><div class="shop-header_slide js-slide_shop">
<div class="shop-header_img"><img src="https://selfcafe.jp/wp_control/wp-content/uploads/2026/02/a.jpg" alt=""></div>
<div class="shop-header_img"><img src="https://selfcafe.jp/wp_control/wp-content/uploads/2026/02/b.png" alt=""></div>
<div class="shop-header_img"><img src="https://selfcafe.jp/wp_control/wp-content/uploads/2026/02/c.webp" alt=""></div>
</div></div>
<dl><dt>店舗名</dt><dd>セルフカフェ 藤が丘店</dd><dt>営業時間</dt><dd>7:00〜23:00</dd><dt>定休日</dt><dd>なし</dd><dt>席数</dt><dd>30席</dd><dt>住所</dt><dd>〒465-0032 愛知県名古屋市名東区藤が丘141</dd><dt>アクセス方法</dt><dd>「藤が丘」駅徒歩2分</dd></dl>
<ul><li class="shop-paidservice_item"><span>個室ブース</span></li><li class="shop-paidservice_item is-disabled"><span>会議室</span></li><li class="shop-paidservice_item is-disabled"><span>会員専用エリア</span></li><li class="shop-paidservice_item"><span>コピー機</span></li></ul>`;

test('parseStoreList: /shop/<県>/<slug>/ の店舗ページだけ、重複なし', () => {
  expect(parseStoreList(LIST)).toEqual(['https://selfcafe.jp/shop/aichi/akatsuka/', 'https://selfcafe.jp/shop/aichi/anjoeki/']);
});

test('parseStorePage: 店名・営業時間・最寄駅・エリア・有料サービス（is-disabled は無い）・ギャラリー写真（jpg/png だけ）', () => {
  const f = parseStorePage(PAGE, 'https://selfcafe.jp/shop/aichi/fujigaoka/');
  expect(f).toMatchObject({ name: 'セルフカフェ 藤が丘店', hours: '7:00〜23:00', holiday: 'なし', seats: '30席', station: '藤が丘駅', area: '名古屋市名東区', url: 'https://selfcafe.jp/shop/aichi/fujigaoka/' });
  expect(f.paid).toEqual({ 個室ブース: true, 会議室: false, 会員専用エリア: false, コピー機: true });
  expect(f.images).toEqual(['https://selfcafe.jp/wp_control/wp-content/uploads/2026/02/a.jpg', 'https://selfcafe.jp/wp_control/wp-content/uploads/2026/02/b.png']);
});

test('pickStore: 最近紹介していない店からランダムに選び、事実と写真 1 枚を返す。画像は実際に取って確かめる', async () => {
  const http = { get: jest.fn(async (url, opts) => {
    if (url === 'https://selfcafe.jp/shop/') return { data: LIST };
    if (/\/shop\/aichi\//.test(url)) return { data: PAGE.replace('藤が丘店', url.includes('akatsuka') ? '赤塚店' : '安城駅店') };
    if (/uploads/.test(url)) return { status: 200, headers: { 'content-type': 'image/jpeg' }, data: Buffer.from('img') };
    throw new Error('unexpected ' + url);
  }) };
  const site = createCafeSite({ http, rng: () => 0 });
  const r = await site.pickStore({ recentUrls: ['https://selfcafe.jp/shop/aichi/akatsuka/'] });
  expect(r.facts.name).toBe('セルフカフェ 安城駅店');
  expect(r.photo).toMatchObject({ url: 'https://selfcafe.jp/wp_control/wp-content/uploads/2026/02/a.jpg', mediaType: 'image/jpeg', name: 'HP: セルフカフェ 安城駅店' });
  expect(Buffer.isBuffer(r.photo.bytes)).toBe(true);
});

test('pickStore: 写真が 1 枚も取れなければ photo は null（事実だけ返す）', async () => {
  const http = { get: jest.fn(async (url) => {
    if (url === 'https://selfcafe.jp/shop/') return { data: LIST };
    if (/\/shop\/aichi\//.test(url)) return { data: PAGE };
    throw new Error('403');
  }) };
  const r = await createCafeSite({ http, rng: () => 0 }).pickStore({});
  expect(r.facts.name).toBe('セルフカフェ 藤が丘店');
  expect(r.photo).toBeNull();
});
