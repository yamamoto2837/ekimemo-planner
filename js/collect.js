// ============================================================
// 取りこぼし回収リスト（F2）
//
// 路線ごとに「あと何駅でコンプか」を数え、少ない順に並べる。
// 残り1駅・2駅・3駅で絞り込める。
// 廃駅はもう行けないので、最初は残りに数えない（切り替えで数えられる）。
// ============================================================

const collectFilter = {
  remain: 0,          // 0 = すべて、1〜3 = 残りがちょうどその駅数の路線だけ
  search: '',         // 路線名の一部
  countClosed: false, // 廃駅も残りに数えるか（画面の「廃駅を残りに数えない」の逆）
};

const REMAIN_CHOICES = [
  { value: 0, label: 'すべて' },
  { value: 1, label: '残り1駅' },
  { value: 2, label: '残り2駅' },
  { value: 3, label: '残り3駅' },
];
const MAX_SHOWN_STATIONS = 10;   // 1つの路線で並べる残り駅の上限

// ---------- 準備（app.js から呼ばれる） ----------

function initCollectScreen() {
  const chips = document.getElementById('remainChips');
  for (const c of REMAIN_CHOICES) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.dataset.value = c.value;
    b.addEventListener('click', () => { collectFilter.remain = c.value; renderCollect(); });
    chips.append(b);
  }
  document.getElementById('lineSearch').addEventListener('input', e => {
    collectFilter.search = e.target.value.trim();
    renderCollect();
  });
  // 「廃駅を残りに数えない」にチェック → 廃駅は数えない
  const excludeClosed = document.getElementById('excludeClosed');
  collectFilter.countClosed = !excludeClosed.checked;
  excludeClosed.addEventListener('change', e => {
    collectFilter.countClosed = !e.target.checked;
    renderCollect();
  });
}

// ---------- 1つの路線を、表示用の数字にする ----------

function lineView(stat) {
  const remaining = collectFilter.countClosed
    ? stat.stations.filter(u => stat.remainingActive.includes(u) || stat.remainingClosed.includes(u))
    : stat.remainingActive;
  const total = collectFilter.countClosed ? stat.stations.length : stat.activeTotal;
  return { stat, remaining, total, done: total - remaining.length };
}

// ---------- 描画 ----------

function renderCollect() {
  const empty = document.getElementById('collectEmpty');
  const body = document.getElementById('collectBody');
  if (!appState.resolved) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  // 路線ごとの集計（app.js。進捗が変わったときだけ作り直される）
  const lineStats = getLineStats();

  // 残りが1駅以上ある路線だけ（コンプ済みと、数える駅が無い路線は外す）
  const views = lineStats.map(lineView).filter(v => v.total > 0 && v.remaining.length > 0);

  // 絞り込みボタン（当てはまる路線の数も出す）
  document.querySelectorAll('#remainChips .chip').forEach(b => {
    const value = Number(b.dataset.value);
    const choice = REMAIN_CHOICES.find(c => c.value === value);
    const n = value === 0 ? views.length : views.filter(v => v.remaining.length === value).length;
    b.textContent = `${choice.label}（${n}路線）`;
    b.setAttribute('aria-pressed', String(value === collectFilter.remain));
  });

  // 絞り込み
  let shown = views;
  if (collectFilter.remain > 0) shown = shown.filter(v => v.remaining.length === collectFilter.remain);
  if (collectFilter.search) shown = shown.filter(v => v.stat.name.includes(collectFilter.search));

  // 並べ方：残りが少ない順 → 駅数が多い順 → 路線名順
  shown.sort((a, b) =>
    a.remaining.length - b.remaining.length ||
    b.total - a.total ||
    a.stat.name.localeCompare(b.stat.name, 'ja'));

  document.getElementById('collectCount').textContent = `${shown.length} 路線`;
  const list = document.getElementById('lineList');
  list.replaceChildren(...shown.map(lineItem));
  if (shown.length === 0) list.append(el('li', 'muted', '当てはまる路線はありません。'));
}

// 路線1つ分の表示
function lineItem(v) {
  const li = el('li', 'line-item');

  const head = el('div', 'line-head');
  // 路線名を押すと路線詳細（F3）へ
  const nameLink = el('a', '', v.stat.name);
  nameLink.href = lineHref(v.stat.cd);
  const name = el('span', 'line-name');
  name.append(nameLink);
  head.append(name, el('span', 'remain', `残り ${v.remaining.length} 駅`));

  const rate = v.done / v.total * 100;
  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill');
  fill.style.width = rate + '%';
  bar.append(fill);

  let subText = `全 ${v.total} 駅中 ${v.done} 駅アクセス済み（${formatRate(v.done, v.total)}）`;
  if (v.stat.closedLine) subText += '　廃線';
  const sub = el('div', 'line-sub', subText);

  // 残っている駅（路線の並び順）
  const stations = el('ul', 'remain-stations');
  for (const u of v.remaining.slice(0, MAX_SHOWN_STATIONS)) {
    const unit = MASTER.units[u];
    const item = el('li', '', unit.name);
    item.append(el('small', '', `（${prefName(unit.pref)}）`));
    if (unit.closed) item.append(' ', el('span', 'tag', '廃駅'));
    stations.append(item);
  }
  if (v.remaining.length > MAX_SHOWN_STATIONS) {
    stations.append(el('li', 'muted', `ほか ${v.remaining.length - MAX_SHOWN_STATIONS} 駅`));
  }

  li.append(head, bar, sub, stations);
  const memo = memoView(lineMemo(v.stat.cd));   // この路線のメモ（memo.js）
  if (memo) li.append(memo);
  return li;
}
