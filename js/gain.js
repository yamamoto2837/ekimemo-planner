// ============================================================
// このルート（プラン）で埋まる駅のまとめ
//
// 埋まる駅（いま未アクセスで、このルートで取れる駅）を受け取り、
//   ・全体：アクセス済みの駅数と達成率が、どう変わるか
//   ・都道府県ごと：何駅増えて、達成率がどう変わるか
//   ・路線ごと：何駅増えて、残りが何駅になるか（コンプになる路線を先に）
// を並べる。遠征プラン（plans.js）・巡回ルート（route.js）・自分で作るルート（myroute.js）で使う。
// 地図（drawGainMap）は、道すじと埋まる駅・立ち寄る駅を描く。
// ============================================================

const GAIN_LINES_SHOWN = 15;   // 最初から見せる路線の数（残りは「ほかの路線」を開くと見える）

// 埋まる駅のまとめを作る。units … 埋まる駅（駅メモの駅の番号）
function gainView(units) {
  const box = el('div', 'gain');
  if (!appState.resolved) {
    box.append(el('p', 'muted', '進捗が取り込まれていないので、埋まる駅を数えられません。'));
    return box;
  }
  const accessed = appState.resolved.accessed;
  const gained = new Set(units.filter(u => MASTER.units[u] && !accessed.has(u)));
  box.append(el('h4', 'gain-title', `このルートで埋まる駅：${gained.size} 駅`));
  if (gained.size === 0) {
    box.append(el('p', 'muted', 'このルートで取れる駅は、すべてアクセス済みです。'));
    return box;
  }

  // 全体
  const total = appState.resolved.totalStations;
  const before = accessed.size, after = before + gained.size;
  box.append(el('p', 'gain-total', `全体：${before.toLocaleString()} → ${after.toLocaleString()} 駅（${formatRate(before, total)} → ${formatRate(after, total)}）`));

  // 都道府県ごと
  const prefStats = getPrefStats();
  const byPref = new Map();
  for (const u of gained) {
    const p = MASTER.units[u].pref;
    byPref.set(p, (byPref.get(p) || 0) + 1);
  }
  const prefLine = el('div', 'gain-prefs');
  [...byPref].sort((a, b) => a[0] - b[0]).forEach(([p, n]) => {
    const s = prefStats[p];
    const item = el('span', 'gain-pref');
    item.append(el('b', '', `${prefName(p)} +${n}`), ` （${formatRate(s.done, s.total)} → ${formatRate(s.done + n, s.total)}${s.done + n === s.total ? '・コンプ' : ''}）`);
    prefLine.append(item);
  });
  box.append(prefLine);

  // 路線ごと
  const lines = [];
  for (const s of getLineStats()) {
    const got = s.remaining.filter(u => gained.has(u));
    if (got.length === 0) continue;
    lines.push({ cd: s.cd, name: s.name, got, before: s.remaining.length, after: s.remaining.length - got.length, total: s.stations.length });
  }
  // コンプになる路線 → 増える駅が多い路線 → 残りが少ない路線 の順
  lines.sort((a, b) => (a.after === 0) !== (b.after === 0) ? (a.after === 0 ? -1 : 1) : b.got.length - a.got.length || a.after - b.after);
  const complete = lines.filter(l => l.after === 0).length;
  box.append(el('p', 'gain-lines-head', `路線ごと：${lines.length} 路線で駅が埋まります${complete ? `（そのうち ${complete} 路線がコンプ）` : ''}`));
  const makeList = list => {
    const ul = el('ul', 'gain-lines');
    for (const l of list) {
      const li = el('li', l.after === 0 ? 'gain-line complete' : 'gain-line');
      const head = el('details');
      const sum = el('summary');
      const a = el('a', 'gain-line-name', l.name);
      a.href = lineHref(l.cd);   // app.js（路線詳細へ）
      sum.append(a, ` +${l.got.length} 駅（残り ${l.before} → ${l.after}）`);
      if (l.after === 0) sum.append(' ', el('span', 'tag gain-complete', 'コンプ'));
      head.append(sum, el('div', 'gain-line-stations', l.got.map(u => MASTER.units[u].name).join('、')));
      li.append(head);
      ul.append(li);
    }
    return ul;
  };
  box.append(makeList(lines.slice(0, GAIN_LINES_SHOWN)));
  if (lines.length > GAIN_LINES_SHOWN) {
    const more = el('details', 'gain-more');
    more.append(el('summary', '', `ほかの路線（${lines.length - GAIN_LINES_SHOWN}）`), makeList(lines.slice(GAIN_LINES_SHOWN)));
    box.append(more);
  }
  return box;
}

// 道すじと、埋まる駅（赤）・立ち寄る駅（番号）を地図に描く
//   div … 地図を描く入れ物、paths … [[駅, 駅, …], …]（道すじ）、stops … 立ち寄る駅、gained … 埋まる駅
// 戻り値: Leaflet の地図（描けなければ null）
function drawGainMap(div, paths, stops, gained) {
  if (!window.L) {
    div.replaceChildren(el('p', 'message error map-error', '地図の部品を読み込めませんでした。'));
    return null;
  }
  const map = L.map(div, { preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const pos = u => [MASTER.units[u].lat, MASTER.units[u].lon];
  for (const p of paths) {
    const pts = pathLatLngs(p);   // shapes.js（線路の形に沿って）
    if (pts.length > 1) L.polyline(pts, { color: cssColor('--accent'), weight: 3, opacity: 0.7 }).addTo(map);
  }
  for (const u of gained) {
    if (!MASTER.units[u]) continue;
    L.circleMarker(pos(u), { radius: 5, color: '#ffffff', weight: 1.5, fillColor: cssColor('--todo'), fillOpacity: 0.95 })
      .bindTooltip(MASTER.units[u].name).addTo(map);
  }
  stops.forEach((u, i) => {
    if (!MASTER.units[u]) return;
    const label = i === 0 ? '出' : String(i);
    const icon = L.divIcon({ className: 'route-pin', html: `<span>${label}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    L.marker(pos(u), { icon }).bindTooltip(MASTER.units[u].name).addTo(map);
  });
  const all = [...stops, ...gained].filter(u => MASTER.units[u]).map(pos);
  if (all.length) {
    const bounds = L.latLngBounds(all);
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
    setTimeout(() => { map.invalidateSize(); map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 }); }, 100);
  } else {
    map.setView(JAPAN_CENTER, JAPAN_ZOOM);   // map.js
  }
  return map;
}
