// ============================================================
// 路線別残り駅一覧（F3）
//
// 選んだ路線の全駅を、路線の並び順で縦に並べ、未アクセスの駅を色分けする。
// 「路線の端が丸ごと残っている」のか「途中の1駅だけ抜けている」のかが
// わかるよう、未アクセスの区間のまとめも出す。
// ============================================================

let currentLineCd = null;      // 表示中の路線コード
const MAX_FIND_RESULTS = 50;   // 路線を探したときに並べる上限
const MAX_TRANSFERS = 6;       // 1駅で並べる乗換路線の上限

// ---------- 準備（app.js から呼ばれる） ----------

function initLineScreen() {
  document.getElementById('lineFind').addEventListener('input', renderLineFind);
}

// ---------- 路線を探す ----------

function renderLineFind() {
  const word = document.getElementById('lineFind').value.trim();
  const box = document.getElementById('lineFindResults');
  box.replaceChildren();
  if (!word) return;

  const stats = getLineStats();
  const remainOf = {};
  if (stats) for (const s of stats) remainOf[s.cd] = s.remaining.length;   // 廃駅も含めた残り

  const hits = Object.entries(MASTER.lines)
    .filter(([, l]) => l.name.includes(word))
    .sort((a, b) => a[1].name.localeCompare(b[1].name, 'ja'));
  for (const [cd, l] of hits.slice(0, MAX_FIND_RESULTS)) {
    const li = el('li', '');
    const a = el('a', '', l.name);
    a.href = lineHref(cd);
    li.append(a);
    if (cd in remainOf) {
      li.append(' ', el('span', remainOf[cd] === 0 ? 'muted' : 'remain', remainOf[cd] === 0 ? 'コンプ' : `残り ${remainOf[cd]} 駅`));
    }
    box.append(li);
  }
  if (hits.length === 0) box.append(el('li', 'muted', '見つかりません。'));
  if (hits.length > MAX_FIND_RESULTS) box.append(el('li', 'muted', `ほか ${hits.length - MAX_FIND_RESULTS} 路線（もう少し詳しく入力してください）`));
}

// ---------- 路線の駅を並べる ----------

// 路線の駅を、駅メモの駅で重なりを除いて並べる
function lineRows(line, accessed) {
  const rows = [];
  const seen = new Set();
  for (const sc of line.stations) {
    const station = MASTER.stations[sc];
    if (seen.has(station.u)) continue;
    seen.add(station.u);
    const unit = MASTER.units[station.u];
    let status = 'done';
    if (!accessed.has(station.u)) status = unit.closed ? 'closed' : 'todo';
    rows.push({ sc, station, unit, status });
  }
  return rows;
}

// 未アクセスの区間をまとめる（駅メモでは廃駅も近くに行けば取れるので、廃駅も含める）。
// アクセス済みの駅で区切る。
function todoSegments(rows) {
  const segments = [];
  let cur = null;
  let seenDoneBefore = false;
  for (const r of rows) {
    if (r.status === 'todo' || r.status === 'closed') {
      if (!cur) cur = { first: r, last: r, count: 0, atStart: !seenDoneBefore, atEnd: false };
      cur.last = r;
      cur.count++;
    } else if (r.status === 'done') {
      if (cur) { segments.push(cur); cur = null; }
      seenDoneBefore = true;
    }
  }
  if (cur) { cur.atEnd = true; segments.push(cur); }
  return segments;
}

// 区間の位置の言い方
function segmentPlace(seg, shape) {
  if (shape !== 'path') return '';            // 一本道でないときは端かどうか言えない
  if (seg.atStart && seg.atEnd) return '全区間';
  if (seg.atStart) return '起点側の端';
  if (seg.atEnd) return '終点側の端';
  return '途中';
}

// その駅で乗り換えられる、ほかの路線
function transferLines(unit, lineCd) {
  const result = [];
  const seen = new Set([lineCd]);
  for (const c of unit.codes) {
    const lc = MASTER.stations[c].line;
    if (seen.has(lc) || !MASTER.lines[lc]) continue;
    seen.add(lc);
    result.push(lc);
  }
  return result;
}

// ---------- 描画 ----------

// cd を渡すとその路線に切り替える。渡さなければ表示中の路線を描き直す。
function renderLineDetail(cd) {
  if (cd !== undefined) currentLineCd = cd;
  const box = document.getElementById('lineDetail');
  box.replaceChildren();

  const line = currentLineCd && hasKey(MASTER.lines, currentLineCd) ? MASTER.lines[currentLineCd] : null;
  if (!line) {
    box.append(el('p', 'muted', currentLineCd
      ? 'この路線は見つかりませんでした。上の欄から探してください。'
      : '上の欄で路線を探すか、取りこぼし回収リストの路線名を押してください。'));
    return;
  }

  const accessed = appState.resolved ? appState.resolved.accessed : new Set();
  const rows = lineRows(line, accessed);
  // 廃駅も含めて数える（駅メモの路線コンプも廃駅を含む）
  const done = rows.filter(r => r.status === 'done').length;
  const todo = rows.length - done;
  const todoClosed = rows.filter(r => r.status === 'closed').length;

  // --- 見出しと数字 ---
  const head = el('div', 'panel');
  const title = el('h3', 'detail-title', line.name);
  if (line.closed) title.append(' ', el('span', 'tag', '廃線'));
  head.append(title);

  if (!appState.resolved) {
    head.append(el('p', 'notice', '進捗が取り込まれていないので、全駅を未アクセスとして表示しています。'));
  }
  let countText;
  if (todo === 0) {
    countText = `コンプ済み（全 ${rows.length} 駅）`;
  } else {
    countText = `残り ${todo} 駅${todoClosed ? `（うち廃駅 ${todoClosed}）` : ''} ／ 全 ${rows.length} 駅中 ${done} 駅アクセス済み（${formatRate(done, rows.length)}）`;
  }
  head.append(el('p', 'detail-count', countText));
  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill');
  fill.style.width = (rows.length ? done / rows.length * 100 : 0) + '%';
  bar.append(fill);
  head.append(bar);

  // 地図へ
  const links = el('p', 'detail-links');
  const mapLink = el('a', '', 'この路線を地図で見る');
  mapLink.href = '#map/line/' + encodeURIComponent(currentLineCd);
  links.append(mapLink);
  head.append(links);

  // この路線のメモ（打ち込むと自動で保存される）
  head.append(memoEditor('line', currentLineCd, line.name, 'この路線のメモ',
    '例: 朝の1本目で端まで行き、折り返しで途中駅を回る').box);

  // 並び順についての注意
  if (line.shape === 'branch' || line.shape === 'loop') {
    head.append(el('p', 'help', line.shape === 'loop'
      ? '環状の路線です。どこから並べても同じなので、駅データの順で並べています。'
      : '分岐がある路線です。駅データの順で並べているので、分かれた先が続けて並ぶことがあります。'));
  }
  if (line.estimated) {
    head.append(el('p', 'help', '駅データ.jp に無い駅を含むため、並び順は位置から推定しています。'));
  }

  // --- 未アクセスの区間のまとめ ---
  const segs = todoSegments(rows);
  if (segs.length > 0) {
    head.append(el('h4', '', '未アクセスの区間'));
    const ul = el('ul', 'segments');
    for (const s of segs) {
      const name = s.count === 1 ? s.first.unit.name : `${s.first.unit.name}〜${s.last.unit.name}`;
      const place = segmentPlace(s, line.shape);
      const li = el('li', '');
      if (place) li.append(el('span', 'seg-place', place));
      li.append(`${name}（${s.count} 駅）`);
      ul.append(li);
    }
    head.append(ul);
  }

  // --- 全駅の並び ---
  const list = el('ol', 'route');
  rows.forEach(r => list.append(stationRow(r, currentLineCd)));
  const legend = el('p', 'legend');
  legend.append(
    el('span', 'lg lg-todo', '未アクセス'),
    el('span', 'lg lg-done', 'アクセス済み'),
    el('span', 'lg lg-closed', '廃駅（未アクセス）'));

  const routePanel = el('div', 'panel');
  routePanel.append(legend, list);
  box.append(head, routePanel);
}

// 駅1つ分の行
function stationRow(r, lineCd) {
  const li = el('li', 'st st-' + r.status);
  li.append(el('span', 'dot'));

  const body = el('div', 'st-body');
  const name = el('span', 'st-name', r.station.name);
  body.append(name, el('small', 'muted', `（${prefName(r.unit.pref)}）`));
  if (r.status === 'todo') body.append(' ', el('span', 'badge-todo', '未アクセス'));
  if (r.unit.closed) body.append(' ', el('span', 'tag', '廃駅'));
  if (r.unit.name !== r.station.name) body.append(el('div', 'st-note', `駅メモでは「${r.unit.name}」として数えます`));

  // 乗換できる路線（押すとその路線の詳細へ）
  const transfers = transferLines(r.unit, lineCd);
  if (transfers.length > 0) {
    const t = el('div', 'st-transfer', '乗換: ');
    transfers.slice(0, MAX_TRANSFERS).forEach((lc, i) => {
      if (i > 0) t.append('、');
      const a = el('a', '', MASTER.lines[lc].name);
      a.href = lineHref(lc);
      t.append(a);
    });
    if (transfers.length > MAX_TRANSFERS) t.append(` ほか ${transfers.length - MAX_TRANSFERS} 路線`);
    body.append(t);
  }

  // この駅のメモ（駅メモの駅ごと。乗換駅なら、どの路線から見ても同じメモ）
  const memoText = stationMemo(r.station.u);
  const view = memoView(memoText);
  if (view) body.append(view);
  const memoButton = el('button', 'memo-button', memoText.trim() ? 'メモを直す' : 'メモ');
  memoButton.type = 'button';
  memoButton.addEventListener('click', () => toggleStationMemo(li, r, lineCd));
  body.append(memoButton);

  li.append(body);
  return li;
}

// 駅のメモ欄を開く・閉じる
function toggleStationMemo(li, r, lineCd) {
  const body = li.querySelector('.st-body');
  const opened = body.querySelector('.memo-editor');
  if (opened) {
    // 閉じる：すぐ保存して、行を作り直す（書いたメモが表示される）
    flushMemoSave();
    li.replaceWith(stationRow(r, lineCd));
    return;
  }
  body.querySelector('.memo-view')?.remove();
  const editor = memoEditor('station', r.station.u, r.unit.name, `${r.unit.name}のメモ`, '例: 北口のバス停から乗り継ぐ');
  const close = el('button', 'memo-close', '閉じる');
  close.type = 'button';
  close.addEventListener('click', () => toggleStationMemo(li, r, lineCd));
  editor.box.append(close);
  body.querySelector('.memo-button').before(editor.box);
  body.querySelector('.memo-button').hidden = true;
  editor.textarea.focus();
}

// ---------- メモのある路線・駅の一覧 ----------

function renderMemoList() {
  const box = document.getElementById('memoList');
  const summary = document.getElementById('memoListSummary');
  if (!box) return;
  const lines = memoEntries('line');
  const stations = memoEntries('station');
  summary.textContent = `メモのある路線・駅（${lines.length + stations.length} 件）`;
  box.replaceChildren();
  if (lines.length + stations.length === 0) {
    box.append(el('p', 'help', 'まだメモはありません。路線を開いて、路線や駅のメモを書けます。'));
    return;
  }

  const ul = el('ul', 'memo-list');
  for (const [cd, m] of lines) {
    const li = el('li', '');
    const known = hasKey(MASTER.lines, cd);
    const a = el('a', '', `${known ? MASTER.lines[cd].name : m.name}（路線）`);
    if (known) a.href = lineHref(cd);
    li.append(a);
    if (!known) li.append(el('span', 'muted', '（今の駅マスタに見つかりません）'));
    li.append(el('div', 'memo-view', m.text));
    ul.append(li);
  }
  for (const [u, m] of stations) {
    const li = el('li', '');
    const unit = hasKey(MASTER.units, u) ? MASTER.units[u] : null;
    if (unit) {
      // 駅のメモは、その駅を通る路線（最初の1つ）へ移る
      const lc = MASTER.stations[unit.codes[0]].line;
      const a = el('a', '', `${unit.name}（${prefName(unit.pref)}）`);
      if (MASTER.lines[lc]) a.href = lineHref(lc);
      li.append(a);
    } else {
      li.append(el('span', '', m.name), el('span', 'muted', '（今の駅マスタに見つかりません）'));
    }
    li.append(el('div', 'memo-view', m.text));
    ul.append(li);
  }
  box.append(ul);
}
