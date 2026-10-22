// ============================================================
// 駅マスタの更新の知らせ（F10）
//
// 駅マスタを作り直したときの記録（master/changes.js）を見て、
// まだ見ていない更新があれば、画面の上にお知らせを出す。
// いちばん大事なのは「コンプ済みだった路線に加わった新駅」（要件定義書）。
// 一度「駅マスタの更新」画面を開いたら、そのお知らせは出さない。
// ============================================================

const CHANGES = Array.isArray(window.EKIMEMO_CHANGES) ? window.EKIMEMO_CHANGES : [];
const CHANGES_SEEN_KEY = 'ekimemo-changes-seen';

function changesSeen() {
  try { return localStorage.getItem(CHANGES_SEEN_KEY) || ''; } catch (e) { return ''; }
}
function markChangesSeen() {
  if (CHANGES.length === 0) return;
  try { localStorage.setItem(CHANGES_SEEN_KEY, CHANGES[0].builtAt); } catch (e) { /* 保存できなくても先へ */ }
}
function unseenChanges() {
  const seen = changesSeen();
  return CHANGES.filter(c => !seen || c.builtAt > seen);
}

// その路線に、ほかの駅を全部回っていた（コンプしていた）のに加わった駅
//   戻り値: [{ line, units: [加わった未アクセスの駅] }]
function brokenCompletions(entry) {
  if (!appState.resolved) return [];
  const accessed = appState.resolved.accessed;
  const result = [];
  for (const [lc, addedList] of Object.entries(entry.lineAdded || {})) {
    if (!hasKey(MASTER.lines, lc)) continue;
    const added = new Set(addedList);
    const lineUnits = [...new Set(MASTER.lines[lc].stations.map(c => MASTER.stations[c].u))];
    const others = lineUnits.filter(u => !added.has(u));
    // 駅メモの路線コンプは廃駅も含めて数えるので、廃駅も含めて「全部回っていたか」を見る
    if (others.length === 0 || !others.every(u => accessed.has(u))) continue;
    const todo = addedList.filter(u => !accessed.has(u));
    if (todo.length) result.push({ line: lc, units: todo });
  }
  return result;
}

// 駅の表示名（今の駅マスタに無ければ、記録に残っている名前）
function changeUnitName(info) {
  const u = typeof info === 'string' ? info : info.u;
  if (u && hasKey(MASTER.units, u)) return MASTER.units[u].name;
  return info.name || u;
}

// ---------- お知らせ（画面の上） ----------

function renderUpdateBanner() {
  const banner = document.getElementById('updateBanner');
  if (!banner) return;
  const list = unseenChanges();
  if (list.length === 0) { banner.hidden = true; return; }
  let broken = 0, added = 0, closed = 0;
  for (const c of list) {
    broken += brokenCompletions(c).reduce((s, b) => s + b.units.length, 0);
    added += (c.added || []).length;
    closed += (c.closed || []).length;
  }
  const parts = [];
  if (broken) parts.push(`コンプ済みの路線に新駅 ${broken} 駅`);
  if (added) parts.push(`新駅 ${added} 駅`);
  if (closed) parts.push(`廃駅になった駅 ${closed} 駅`);
  if (!parts.length) parts.push('路線名や駅の並びが変わりました');
  banner.replaceChildren();
  const a = el('a', '', `駅マスタが更新されました：${parts.join('、')}`);
  a.href = '#updates';
  banner.append(a);
  banner.classList.toggle('important', broken > 0);
  banner.hidden = false;
}

// ---------- 「駅マスタの更新」画面 ----------

function renderUpdates() {
  const box = document.getElementById('updateList');
  if (!box) return;
  box.replaceChildren();
  if (CHANGES.length === 0) {
    box.append(el('p', 'panel muted', 'まだ更新の記録はありません。駅マスタを作り直したときに、前回との違いがここに並びます。'));
    return;
  }
  const seen = changesSeen();
  CHANGES.forEach(c => box.append(updateCard(c, !seen || c.builtAt > seen)));
}

function updateCard(c, isNew) {
  const card = el('div', 'panel update-card');
  const title = el('h3', '', `${c.builtAt} の更新`);
  if (isNew) title.append(' ', el('span', 'badge-todo', '新着'));
  card.append(title, el('p', 'help', `前回（${c.from}）の駅マスタと比べた違いです。`));

  // コンプ済みだった路線に加わった新駅（いちばん大事）
  const broken = brokenCompletions(c);
  if (broken.length) {
    card.append(el('h4', 'update-important', `コンプ済みだった路線に、未アクセスの駅が加わりました（${broken.length} 路線）`));
    const ul = el('ul', 'update-list');
    for (const b of broken) {
      const li = el('li', '');
      const a = el('a', '', MASTER.lines[b.line].name);
      a.href = lineHref(b.line);
      li.append(a, `：${b.units.map(changeUnitName).join('、')}`);
      ul.append(li);
    }
    card.append(ul);
  } else if (appState.resolved) {
    card.append(el('p', '', 'コンプ済みだった路線に加わった駅はありません。'));
  }

  const accessed = appState.resolved ? appState.resolved.accessed : new Set();
  const section = (label, items, render) => {
    if (!items || items.length === 0) return;
    const d = el('details', 'update-section');
    d.append(el('summary', '', `${label}（${items.length}）`));
    const ul = el('ul', 'update-list');
    items.forEach(it => ul.append(render(it)));
    d.append(ul);
    card.append(d);
  };
  const stationItem = info => {
    const li = el('li', '', changeUnitName(info));
    li.append(el('small', 'muted', `（${prefName(info.pref)}）`));
    if (info.u && hasKey(MASTER.units, info.u)) li.append(' ', accessed.has(info.u) ? el('span', 'plan-check', '✓ アクセス済み') : el('span', 'badge-todo', '未アクセス'));
    return li;
  };
  section('新しく加わった駅', c.added, stationItem);
  section('廃駅になった駅', c.closed, stationItem);
  section('現役に戻った駅', c.reopened, stationItem);
  section('無くなった駅', c.removed, info => { const li = el('li', '', info.name); li.append(el('small', 'muted', `（${prefName(info.pref)}）`)); return li; });
  section('駅が加わった路線', Object.entries(c.lineAdded || {}), ([lc, list]) => {
    const li = el('li', '');
    if (hasKey(MASTER.lines, lc)) { const a = el('a', '', MASTER.lines[lc].name); a.href = lineHref(lc); li.append(a); }
    else li.append(lc);
    li.append(`：${list.map(changeUnitName).join('、')}`);
    return li;
  });
  section('名前が変わった路線', c.renamedLines, r => el('li', '', `${r.from} → ${r.to}`));
  return card;
}

// 画面を開いたら、お知らせは「見た」ことにする（app.js から呼ばれる）
function onUpdatesShown() {
  renderUpdates();
  markChangesSeen();
  renderUpdateBanner();
}
