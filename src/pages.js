/**
 * Meta の App Review（審査）で求められる固定ページ（プライバシーポリシー・利用規約・データ削除の案内）。
 * 誰でも開ける。内容は「本人（アプリの所有者）専用の自動投稿ツールで、他人のデータを保存しない」ことを説明する。
 */
const APP_NAME = 'suzuki-threads';

function page(title, bodyJa, bodyEn) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - ${APP_NAME}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.7;color:#222}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2em}small{color:#666}</style></head>
<body><h1>${title}</h1>${bodyJa}<hr><h2>English</h2>${bodyEn}<p><small>最終更新 / Last updated: 2026-10-28</small></p></body></html>`;
}

const PRIVACY = page('プライバシーポリシー / Privacy Policy',
  `<p>「${APP_NAME}」（以下「本アプリ」）は、所有者本人の Threads アカウントに投稿を行い、そのアカウントの統計（フォロワー数・表示数など）と、本人の投稿に付いた返信を読むためのツールです。</p>
<h2>取得する情報</h2><ul><li>本人の Threads アカウントのアクセストークン、ユーザー ID、ユーザー名</li><li>本人が投稿した内容と、その投稿の統計（表示数・いいね数・返信数など）</li><li>本人の投稿に付いた返信（投稿 ID・ユーザー名・本文）と、キーワード検索で表示された公開投稿（投稿 ID・ユーザー名・本文）</li></ul>
<h2>利用目的</h2><ul><li>本人のアカウントへの投稿・返信の作成</li><li>投稿の反応を見て、本人の投稿内容を調整すること</li></ul>
<h2>第三者への提供</h2><p>取得した情報を第三者に販売・提供することはありません。投稿文の生成には Anthropic 社の API を利用しますが、送信するのは本人の投稿文と、返信・検索で表示された公開投稿の本文のみで、学習には利用されません。</p>
<h2>保存と削除</h2><p>情報は Google Cloud（東京リージョン）に保存し、返信・検索結果の記録は 90 日以内に削除します。本人の求めにより、すべての情報を削除します（下記の連絡先へ）。</p>
<h2>連絡先</h2><p>本アプリの所有者（Threads: @tete_nagoya）へ Threads のダイレクトメッセージでご連絡ください。</p>`,
  `<p>"${APP_NAME}" (the "App") is a personal tool that publishes posts to its owner's own Threads account, reads that account's insights (followers, views, etc.) and the replies to the owner's posts.</p>
<h2>Information we collect</h2><ul><li>The owner's Threads access token, user ID and username</li><li>The owner's posts and their insights (views, likes, replies, etc.)</li><li>Replies to the owner's posts (post ID, username, text) and public posts returned by keyword search (post ID, username, text)</li></ul>
<h2>How we use it</h2><ul><li>To create posts and replies on the owner's account</li><li>To adjust the owner's content based on engagement</li></ul>
<h2>Sharing</h2><p>We never sell or share this information with third parties. Post text is generated with the Anthropic API; only the owner's post text and the text of public replies/search results are sent, and they are not used for training.</p>
<h2>Retention and deletion</h2><p>Data is stored on Google Cloud (Tokyo region). Records of replies and search results are deleted within 90 days. All data is deleted on request (see contact).</p>
<h2>Contact</h2><p>Message the owner on Threads (@tete_nagoya).</p>`);

const TERMS = page('利用規約 / Terms of Service',
  `<p>本アプリは所有者本人のみが利用する個人用ツールです。第三者向けのサービスではなく、一般の方が利用・登録することはできません。</p><p>本アプリは Meta Platforms, Inc. の Threads API を利用しており、Threads の利用規約およびプラットフォームポリシーに従って運用します。</p>`,
  `<p>The App is a personal tool used only by its owner. It is not offered to the public and no one else can sign up or use it.</p><p>The App uses the Threads API by Meta Platforms, Inc. and operates in accordance with the Threads Terms of Use and the Meta Platform Policies.</p>`);

const DELETION = page('データ削除の案内 / Data Deletion',
  `<p>本アプリが保存している情報の削除を希望される場合は、Threads のダイレクトメッセージで所有者（@tete_nagoya）へ「データ削除希望」とご連絡ください。受け取りから 7 日以内に、該当する情報（返信・検索結果の記録）をすべて削除し、完了をお知らせします。</p><p>所有者本人のアカウント情報は、Threads の「設定 → アカウント → ウェブサイトの権限」から本アプリの連携を解除することでアクセスが無効になり、保存済みのトークンも削除されます。</p>`,
  `<p>To request deletion of data stored by the App, send a Threads direct message to the owner (@tete_nagoya) with "data deletion request". Within 7 days we delete all matching records (replies and search results) and confirm.</p><p>The owner can revoke the App's access from Threads Settings → Account → Website permissions; the stored token is then deleted.</p>`);

module.exports = { PRIVACY, TERMS, DELETION, APP_NAME };
