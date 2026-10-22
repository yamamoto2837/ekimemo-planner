// ============================================================
// 地域別進捗（F4）
//
// 都道府県ごとの達成率と残りの駅数を一覧にする。
// ・達成率は廃駅も含めた全駅で計算する（全国の合計が取り込み画面と一致する）
// ・残りの駅数は「行ける駅」と「未アクセスの廃駅」に分けて出す
// 都道府県を押すと、その県の残りの駅を路線ごとにまとめて表示する。
// ============================================================

const PREF_SORTS = [
  { value: 'code', label: '北から順' },
  { value: 'remainAsc', label: '残りが少ない順' },
  { value: 'remainDesc', label: '残りが多い順' },
  { value: 'rateDesc', label: '達成率が高い順' },
  { value: 'rateAsc', label: '達成率が低い順' },
];
let prefSort = 'code';
let openPref = null;   // 開いている都道府県コード（null なら閉じている）

// ---------- 準備（app.js から呼ばれる） ----------

function initRegionScreen() {
  const chips = document.getElementById('prefSortChips');
  for (const s of PREF_SORTS) {
    const b = el('button', 'chip', s.label);
    b.type = 'button';
    b.dataset.value = s.value;
    b.addEventListener('click', () => { prefSort = s.value; renderRegion(); });
    chips.append(b);
  }
}

// アドレス（#pref/13 など）から開く県を決める
function selectPref(code) {
  openPref = code;
  renderRegion();
}

// ---------- 描画 ----------

function rateOf(done, total) {
  return total ? done / total : 0;
}

function renderRegion() {
  const empty = document.getElementById('prefEmpty');
  const body = document.getElementById('prefBody');
  const stats = getPrefStats();
  if (!stats) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  // --- 地方ごとのまとめ ---
  const regionBox = document.getElementById('regionCards');
  regionBox.replaceChildren();
  for (const r of REGIONS) {
    let total = 0, done = 0, remain = 0;
    for (let p = r.from; p <= r.to; p++) {
      total += stats[p].total;
      done += stats[p].done;
      remain += stats[p].remainingActive.length;
    }
    const c = el('div', 'card region-card');
    c.append(el('span', 'region-name', r.name), el('b', '', formatRate(done, total)), el('span', '', `残り ${remain} 駅`));
    regionBox.append(c);
  }

  // --- 並べ替えボタン ---
  document.querySelectorAll('#prefSortChips .chip').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.value === prefSort));
  });

  // --- 都道府県の一覧 ---
  const rows = stats.slice(1);
  if (prefSort === 'remainAsc') rows.sort((a, b) => a.remainingActive.length - b.remainingActive.length || a.pref - b.pref);
  if (prefSort === 'remainDesc') rows.sort((a, b) => b.remainingActive.length - a.remainingActive.length || a.pref - b.pref);
  if (prefSort === 'rateDesc') rows.sort((a, b) => rateOf(b.done, b.total) - rateOf(a.done, a.total) || a.pref - b.pref);
  if (prefSort === 'rateAsc') rows.sort((a, b) => rateOf(a.done, a.total) - rateOf(b.done, b.total) || a.pref - b.pref);

  const list = document.getElementById('prefList');
  list.replaceChildren(...rows.map(prefRow));
}

// 都道府県1つ分の行
function prefRow(s) {
  const isOpen = openPref === s.pref;
  const li = el('li', 'pref-row' + (isOpen ? ' open' : ''));

  // 行全体がリンク。押すと開く／もう一度押すと閉じる
  const head = el('a', 'pref-head');
  head.href = isOpen ? '#pref' : '#pref/' + s.pref;
  head.setAttribute('aria-expanded', String(isOpen));

  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill');
  fill.style.width = rateOf(s.done, s.total) * 100 + '%';
  bar.append(fill);

  const remain = s.remainingActive.length;
  head.append(
    el('span', 'pref-name', prefName(s.pref)),
    bar,
    el('span', 'pref-rate', `${formatRate(s.done, s.total)}`),
    el('span', 'pref-nums', `${s.done} / ${s.total} 駅`),
    el('span', remain === 0 ? 'pref-remain done' : 'pref-remain', remain === 0 ? 'コンプ' : `残り ${remain} 駅`),
  );
  li.append(head);
  if (isOpen) li.append(prefDetail(s));
  return li;
}

// 開いた県の中身：残りの駅を路線ごとに
function prefDetail(s) {
  const box = el('div', 'pref-detail');
  const links = el('p', 'detail-links');
  const mapLink = el('a', '', 'この県を地図で見る');
  mapLink.href = '#map/pref/' + s.pref;
  links.append(mapLink);
  box.append(links);
  if (s.remainingClosed.length > 0) {
    box.append(el('p', 'help', `このほか、未アクセスの廃駅が ${s.remainingClosed.length} 駅あります（もう行けないため下には出していません）。`));
  }
  if (s.remainingActive.length === 0) {
    box.append(el('p', '', 'この県の行ける駅は、すべてアクセス済みです。'));
    return box;
  }

  // 路線ごとにまとめる（乗換駅は、通る路線それぞれに出る）
  const byLine = new Map();
  for (const u of s.remainingActive) {
    const seenLines = new Set();
    for (const c of MASTER.units[u].codes) {
      const lc = MASTER.stations[c].line;
      if (seenLines.has(lc) || !MASTER.lines[lc]) continue;
      seenLines.add(lc);
      if (!byLine.has(lc)) byLine.set(lc, []);
      byLine.get(lc).push(u);
    }
  }
  // 路線の並び順で駅を並べるため、路線の駅順の位置を使う
  const lines = [...byLine.entries()].sort((a, b) =>
    b[1].length - a[1].length || MASTER.lines[a[0]].name.localeCompare(MASTER.lines[b[0]].name, 'ja'));

  box.append(el('p', 'help', `残りの駅を路線ごとに並べています（${lines.length} 路線）。路線名を押すと路線詳細に移ります。乗換駅は、通る路線それぞれに出ます。`));
  const ul = el('ul', 'pref-lines');
  for (const [lc, units] of lines) {
    const line = MASTER.lines[lc];
    const order = new Map(line.stations.map((sc, i) => [MASTER.stations[sc].u, i]));
    units.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

    const li = el('li', '');
    const a = el('a', 'pref-line-name', line.name);
    a.href = lineHref(lc);
    li.append(a, el('span', 'remain', ` ${units.length} 駅`));
    li.append(el('div', 'pref-line-stations', units.map(u => MASTER.units[u].name).join('、')));
    ul.append(li);
  }
  box.append(ul);
  return box;
}
