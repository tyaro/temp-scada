import "./landing.css";
import { DEMO_SUBJECTS, type DemoSubject, type DemoView } from "./registry";

// GitHub Pages のトップページ。題材ごとに「運転表示で見る」「編集モードで開く」の入口を出す。
const REPOSITORY = "https://github.com/tyaro/temp-scada";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function entry(
  subject: DemoSubject,
  view: DemoView,
  label: string,
  primary = false,
) {
  const link = element("a", label, primary ? "entry primary" : "entry");
  link.href = `./demo.html?demo=${encodeURIComponent(subject.id)}&view=${view}`;
  link.dataset.demoEntry = `${subject.id}:${view}`;
  return link;
}
function card(subject: DemoSubject) {
  const section = element("section", undefined, "subject");
  section.dataset.demoSubject = subject.id;
  section.append(element("h2", subject.title), element("p", subject.summary));
  const list = element("ul");
  for (const item of subject.highlights) list.append(element("li", item));
  const story = element("p", undefined, "story");
  story.append(element("strong", "模擬値の筋書き: "), subject.story);
  const actions = element("div", undefined, "actions");
  actions.append(
    entry(subject, "operator", "運転表示で見る", true),
    entry(subject, "edit", "編集モードで開く"),
  );
  section.append(list, story, actions);
  return section;
}

const root = document.getElementById("landing")!;
const header = element("header");
const badge = element("span", "デモ（模擬値）", "badge");
header.append(
  badge,
  element("h1", "Banto SCADA デモ"),
  element(
    "p",
    "工程図エディタと運転表示を、ブラウザだけで試せます。画面の値はすべてブラウザの中で作る模擬値で、実設備・Hub・PLC には接続していません。設備はどれも架空です。",
    "lede",
  ),
);
const subjects = element("div", undefined, "subjects");
for (const subject of DEMO_SUBJECTS) subjects.append(card(subject));

const notes = element("section", undefined, "notes");
notes.append(element("h2", "デモで試せること・試せないこと"));
const noteList = element("ul");
for (const text of [
  "運転表示: ヘッダーの画面切替ボタンで画面を移り、機器を押すと読取の詳細を開けます。Esc で編集画面へ戻ります。",
  "編集モード: 部品の追加・移動・色や書式の変更を試せます。変更はこのタブの中だけで、JSON として書き出せます。",
  "警報: 模擬値がしきい値を越えると小札と帯の色が変わります。「アラーム一覧」で確認（ACK）と履歴を試せます。ブザーは鳴りません。",
  "履歴トレンド: トレンドの札を押し、「いまを終了にする」→「取得」で模擬値の履歴を表示します。記録 DB はありません。",
  "記録（Historian）・ログインとユーザー管理・実 Hub への接続・ファイルへの上書き保存は、デスクトップ版（Tauri）だけの機能です。このデモでは使えず、メニューには未接続の理由を表示します。",
])
  noteList.append(element("li", text));
notes.append(noteList);

const footer = element("footer");
const repository = element("a", "tyaro/temp-scada（GitHub）");
repository.href = REPOSITORY;
footer.append("ソースと設計資料: ", repository);
root.append(header, subjects, notes, footer);
