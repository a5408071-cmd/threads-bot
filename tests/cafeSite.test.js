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

// 2026-10-29 社長「全店舗に関係する話をしてるのに特定の店舗出すのはおかしい 特定の店舗は新店舗もしくは新しい取り組みがある場合のみ」
const { parseNewsList, parseNewsEntry, announcementDate, isAnnounceable } = require('../src/cafeSite');
const NEWS = `<div class="news-list">
<article class="news-listItem"> <a href="https://selfcafe.jp/newstore/202610133411/"> <p class="news-listItem_date"><time datetime="2026-10-13">2026.10.13</time></p> <p class="news-listItem_category" style="background:#ffe44c;">新店舗情報</p> <h3 class="news-listItem_title">岐阜県大垣市に「セルフカフェイオンタウン大垣店」10月31日(土)10:30OPEN</h3> </a> </article>
<article class="news-listItem"> <a href="https://selfcafe.jp/campaign/202610083302/"> <p class="news-listItem_date"><time datetime="2026-10-08">2026.10.08</time></p> <p class="news-listItem_category" style="background:#f00;">キャンペーン</p> <h3 class="news-listItem_title">【延長決定】サブスク初期費用0円キャンペーン10月12日（月・祝）まで</h3> </a> </article>
<article class="news-listItem"> <a href="https://selfcafe.jp/information/202609103176/"> <p class="news-listItem_date"><time datetime="2026-09-10">2026.09.10</time></p> <p class="news-listItem_category">お知らせ</p> <h3 class="news-listItem_title">【重要】メンバーシップ（サブスク）のお支払い方法変更について</h3> </a> </article>
</div>`;
const ENTRY = `<main class="l-contents" role="main"> <article class="news-entry"> <h1 class="news-entryData_title">岐阜県大垣市に「セルフカフェイオンタウン大垣店」10月31日(土)10:30OPEN</h1> </div> <div class="entryBody txtbox base--ss sectionbox"> <p><strong>セルフカフェイオンタウン大垣店が2026年10月31日(土)10:30OPEN</strong></p> <p>イオンタウン大垣内に、Wi-Fi・電源完備の無人カフェがオープンします。<br /> お買い物の合間に。</p> <p>営業時間：10:30～22:00</p> <p>▶店舗詳細はこちら：<a href="https://selfcafe.jp/shop/gifu/aeontown-ogaki/">https://selfcafe.jp/shop/gifu/aeontown-ogaki/</a></p> </div> <div class="entryNaviWrap"><a href="https://selfcafe.jp/newstore/202610133404/">前の記事へ</a></div></article></main>`;

test('parseNewsList: 日付・種類（新店舗情報／キャンペーン／お知らせ）・見出し・URL', () => {
  const l = parseNewsList(NEWS);
  expect(l).toHaveLength(3);
  expect(l[0]).toEqual({ url: 'https://selfcafe.jp/newstore/202610133411/', date: '2026-10-13', category: '新店舗情報', title: '岐阜県大垣市に「セルフカフェイオンタウン大垣店」10月31日(土)10:30OPEN' });
  expect(l[1].category).toBe('キャンペーン');
});

test('parseNewsEntry: 本文の文字と店舗ページのリンク（前後の記事へのリンクは拾わない）', () => {
  const e = parseNewsEntry(ENTRY);
  expect(e.text).toMatch(/お買い物の合間に/);
  expect(e.text).toMatch(/営業時間：10:30～22:00/);
  expect(e.shopUrl).toBe('https://selfcafe.jp/shop/gifu/aeontown-ogaki/');
});

test('announcementDate: 見出しの「M月D日」を記事の年で読む（年をまたぐなら翌年）', () => {
  expect(announcementDate({ date: '2026-10-13', title: '「イオンタウン大垣店」10月31日(土)OPEN' })).toBe('2026-10-31');
  expect(announcementDate({ date: '2026-12-20', title: '「X店」1月9日(土)OPEN' })).toBe('2027-01-09');
  expect(announcementDate({ date: '2026-10-13', title: '日付なし' })).toBeNull();
});

test('isAnnounceable: 新店舗は OPEN 日の 7 日後まで、キャンペーンは終わりの日まで、お知らせは出さない。記事が 30 日より古いものも出さない', () => {
  const [ns, cp, info] = parseNewsList(NEWS);
  expect(isAnnounceable(ns, '2026-10-29')).toBe(true);
  expect(isAnnounceable(ns, '2026-11-07')).toBe(true);
  expect(isAnnounceable(ns, '2026-11-08')).toBe(false);
  expect(isAnnounceable(cp, '2026-10-12')).toBe(true);
  expect(isAnnounceable(cp, '2026-10-13')).toBe(false);
  expect(isAnnounceable(info, '2026-09-11')).toBe(false);
  expect(isAnnounceable({ ...ns, date: '2026-08-01', title: '「X店」12月1日OPEN' }, '2026-10-29')).toBe(false);
  expect(isAnnounceable({ ...cp, title: '日付の無いキャンペーン' }, '2026-10-20')).toBe(true); // 日付が無ければ記事から 14 日まで
  expect(isAnnounceable({ ...cp, title: '日付の無いキャンペーン' }, '2026-10-23')).toBe(false);
});

test('announcementDate（レビュー指摘）: キャンペーンは最後の日付、新店舗は OPEN の直前、数か月前の月は翌年にしない', () => {
  expect(announcementDate({ date: '2026-10-01', category: 'キャンペーン', title: '10月1日〜10月12日まで初期費用0円' })).toBe('2026-10-12');
  expect(announcementDate({ date: '2026-10-01', category: '新店舗情報', title: '9月の好評を受け「X店」11月2日OPEN（説明会10月20日）' })).toBe('2026-11-02');
  expect(announcementDate({ date: '2026-10-08', category: 'キャンペーン', title: '9月30日までのキャンペーン' })).toBe('2026-09-30');
});

test('parseNewsEntry（レビュー指摘）: 本文に入れ子の div があっても店舗リンクまで読む', () => {
  const html = '<main><article><div class="entryBody txtbox"><div class="wp-block-image"><img src="a.jpg"></div><p>本文です</p><p><a href="https://selfcafe.jp/shop/gifu/aeontown-ogaki/">店</a></p></div><div class="entryNaviWrap"><a href="https://selfcafe.jp/shop/aichi/x/">別</a></div></article></main>';
  const e = parseNewsEntry(html);
  expect(e.shopUrl).toBe('https://selfcafe.jp/shop/gifu/aeontown-ogaki/');
  expect(e.text).toMatch(/本文です/);
});

describe('メディア情報（2026-10-29 社長「東洋経済新聞にインタビューされたことを紹介 HPのメディア情報あがったときは連動して」）', () => {
  const { parseMediaList, parseMediaEntry, MEDIA_URL } = require('../src/cafeSite');
  const LIST = `<!--repeat-->
			<article class="blog-listItem">
				<a href="https://selfcafe.jp/media-information/202610213449/">
					<div class="blog-listItem_img"><span><img src="https://selfcafe.jp/x.png" /></span></div>
					<p class="blog-listItem_date"><time datetime="2026-10-21">2026.10.21</time></p>
					<h3 class="blog-listItem_title">【メディア情報】東洋経済オンラインに掲載されました。</h3>
					<p class="blog-listItem_category"><span>#オンラインメディア</span>				</a>
			</article>
			<article class="blog-listItem">
				<a href="https://selfcafe.jp/media-information/202610073358/">
					<p class="blog-listItem_date"><time datetime="2026-10-07">2026.10.07</time></p>
					<h3 class="blog-listItem_title">フジテレビ めざましどようびで紹介されました。</h3>
					<p class="blog-listItem_category"><span>#テレビ出演</span><span>#オンラインメディア</span>				</a>
			</article>`;
  const ENTRY = `<div class="entryBody txtbox sectionbox"><p>東洋経済オンラインにセルフカフェの取材記事が掲載されました。</p>
<p>【東洋経済オンライン】<br><a href="https://toyokeizai.net/articles/-/961515">https://toyokeizai.net/articles/-/961515</a><br>【Yahoo!ニュース】<br><a href="https://news.yahoo.co.jp/articles/e4ea">https://news.yahoo.co.jp/articles/e4ea</a></p>
<p>▶FC制度のご案内 <a href="https://selfcafe.jp/franchise/">https://selfcafe.jp/franchise/</a></p></div><div class="entryNaviWrap">`;
  test('一覧: URL・日付・見出し、種類は「メディア掲載」（媒体の種類は tags）', () => {
    expect(MEDIA_URL).toBe('https://selfcafe.jp/media-information/');
    const l = parseMediaList(LIST);
    expect(l).toEqual([
      { url: 'https://selfcafe.jp/media-information/202610213449/', date: '2026-10-21', category: 'メディア掲載', title: '【メディア情報】東洋経済オンラインに掲載されました。', tags: ['オンラインメディア'] },
      { url: 'https://selfcafe.jp/media-information/202610073358/', date: '2026-10-07', category: 'メディア掲載', title: 'フジテレビ めざましどようびで紹介されました。', tags: ['テレビ出演', 'オンラインメディア'] },
    ]);
  });
  test('本文と、記事へのリンク（selfcafe.jp 以外の最初のリンク）', () => {
    const e = parseMediaEntry(ENTRY);
    expect(e.linkUrl).toBe('https://toyokeizai.net/articles/-/961515');
    expect(e.text).toMatch(/取材記事が掲載/);
  });
  test('isAnnounceable: メディア掲載は記事の日付から 14 日まで', () => {
    const [toyo] = parseMediaList(LIST);
    expect(isAnnounceable(toyo, '2026-10-29')).toBe(true);
    expect(isAnnounceable(toyo, '2026-11-04')).toBe(true);
    expect(isAnnounceable(toyo, '2026-11-05')).toBe(false);
  });
});

test('pendingAnnouncements: include に入れた記事は期間外でも告知の対象（2026-10-29 社長「高畑と安城と本陣もそれぞれ載せておいて」）', async () => {
  const http = { get: jest.fn(async (url) => {
    if (url === 'https://selfcafe.jp/news/') return { data: NEWS };
    throw new Error('unexpected ' + url);
  }) };
  const site = createCafeSite({ http, rng: () => 0 });
  expect(await site.pendingAnnouncements('2026-12-31')).toEqual([]);
  const r = await site.pendingAnnouncements('2026-12-31', { include: ['https://selfcafe.jp/newstore/202610133411/'] });
  expect(r.map((i) => i.url)).toEqual(['https://selfcafe.jp/newstore/202610133411/']);
});

test('announcement(item, { multi: true }): 店舗ページの写真を複数（最大 5 枚）取る。1 枚目は photo にも', async () => {
  const NEWSTORE = { url: 'https://selfcafe.jp/newstore/202609273245/', date: '2026-09-27', category: '新店舗情報', title: '名古屋市中川区に「セルフカフェ高畑店」10月5日(月)17:00OPEN' };
  const entryHtml = '<div class="entryBody"><p>高畑店がオープン</p><a href="https://selfcafe.jp/shop/aichi/fujigaoka/">店舗</a></div><div class="entryNavi">';
  const http = { get: jest.fn(async (url) => {
    if (url === NEWSTORE.url) return { data: entryHtml };
    if (/\/shop\/aichi\//.test(url)) return { data: PAGE };
    if (/uploads/.test(url)) return { status: 200, headers: { 'content-type': 'image/jpeg' }, data: Buffer.from('img') };
    throw new Error('unexpected ' + url);
  }) };
  const site = createCafeSite({ http, rng: () => 0 });
  const a = await site.announcement(NEWSTORE, { multi: true });
  expect(a.photos.map((p) => p.url)).toEqual(['https://selfcafe.jp/wp_control/wp-content/uploads/2026/02/a.jpg', 'https://selfcafe.jp/wp_control/wp-content/uploads/2026/02/b.png']);
  expect(a.photo.url).toBe(a.photos[0].url);
  const one = await site.announcement(NEWSTORE);
  expect(one.photos).toBeUndefined();
});
