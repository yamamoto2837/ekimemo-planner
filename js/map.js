// ============================================================
// 地図表示（F5）
//
// 未アクセスの駅を地図に丸いピンで出す。都道府県・路線で絞り込める。
// 地図は Leaflet ＋ OpenStreetMap。ピンは数千個になるので、
// 軽い描き方（canvas）を使う。
// ============================================================

const mapFilter = {
  pref: 0,          // 0 = すべての都道府県
  line: '',         // '' = すべての路線
  showClosed: false,
  showDone: false,
};

let leafletMap = null;     // 地図本体（初めて地図画面を開いたときに作る）
let markerLayer = null;    // ピンをまとめて入れる場所
let needFit = true;        // 次に描くとき、ピン全体が入るように地図を動かすか

const JAPAN_CENTER = [36.5, 137.5];
const JAPAN_ZOOM = 5;
const MAX_POPUP_LINES = 6;

// ---------- 準備（app.js から呼ばれる） ----------

function initMapScreen() {
  const prefSelect = document.getElementById('mapPref');
  prefSelect.append(new Option('すべて', '0'));
  for (let p = 1; p <= 47; p++) prefSelect.append(new Option(prefName(p), String(p)));

  prefSelect.addEventListener('change', () => {
    mapFilter.pref = Number(prefSelect.value);
    mapFilter.line = '';
    needFit = true;
    fillMapLineOptions();
    renderMap();
  });
  document.getElementById('mapLine').addEventListener('change', e => {
    mapFilter.line = e.target.value;
    needFit = true;
    renderMap();
  });
  document.getElementById('mapShowClosed').addEventListener('change', e => {
    mapFilter.showClosed = e.target.checked;
    renderMap();
  });
  document.getElementById('mapShowDone').addEventListener('change', e => {
    mapFilter.showDone = e.target.checked;
    renderMap();
  });
  fillMapLineOptions();
}

// アドレス（#map/pref/13、#map/line/路線コード）から絞り込みを決める
function setMapRoute(kind, value) {
  if (kind === 'pref') {
    mapFilter.pref = Number(value) || 0;
    mapFilter.line = '';
  } else if (kind === 'line') {
    mapFilter.pref = 0;
    mapFilter.line = hasKey(MASTER.lines, value) ? value : '';
  }
  needFit = true;
  document.getElementById('mapPref').value = String(mapFilter.pref);
  fillMapLineOptions();
}

// 路線の選択肢（都道府県を選んでいれば、その県を通る路線だけ）
function fillMapLineOptions() {
  const select = document.getElementById('mapLine');
  const stats = getLineStats();
  const remainOf = {};
  if (stats) for (const s of stats) remainOf[s.cd] = s.remainingActive.length;

  const lines = Object.entries(MASTER.lines).filter(([, l]) =>
    mapFilter.pref === 0 || l.stations.some(sc => MASTER.stations[sc].pref === mapFilter.pref));
  lines.sort((a, b) => a[1].name.localeCompare(b[1].name, 'ja'));

  select.replaceChildren(new Option(`すべて（${lines.length} 路線）`, ''));
  for (const [cd, l] of lines) {
    const n = remainOf[cd];
    const text = n === undefined ? l.name : `${l.name}（${n === 0 ? 'コンプ' : '残り ' + n}）`;
    select.append(new Option(text, cd));
  }
  select.value = mapFilter.line;
}

// ---------- 地図本体 ----------

// 地図を作る。Leaflet が読み込めなかったら false
function ensureMap() {
  if (leafletMap) return true;
  if (!window.L) {
    document.getElementById('mapView').replaceChildren(
      el('p', 'message error map-error', '地図の部品を読み込めませんでした。インターネットにつながっているか確かめてください。'));
    return false;
  }
  leafletMap = L.map('mapView', { preferCanvas: true }).setView(JAPAN_CENTER, JAPAN_ZOOM);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(leafletMap);
  markerLayer = L.layerGroup().addTo(leafletMap);
  return true;
}

// 地図画面が表示されたとき（app.js から呼ばれる）
function onMapShown() {
  if (!appState.resolved || !ensureMap()) return;
  // 隠れていた間は大きさが測れないので、表示されてから測り直す
  leafletMap.invalidateSize();
  renderMap();
}

// CSS の色（明るい画面・暗い画面で変わる）を読む
function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- 地図に出す駅を集める ----------

function collectMapPoints() {
  const accessed = appState.resolved.accessed;
  const points = [];
  const add = (u, lat, lon) => {
    const unit = MASTER.units[u];
    let status = 'todo';
    if (accessed.has(u)) status = 'done';
    else if (unit.closed) status = 'closed';
    if (status === 'done' && !mapFilter.showDone) return;
    if (status === 'closed' && !mapFilter.showClosed) return;
    points.push({ u, lat, lon, status });
  };

  if (mapFilter.line) {
    // 路線で絞るときは、その路線の駅の位置を使う
    const seen = new Set();
    for (const sc of MASTER.lines[mapFilter.line].stations) {
      const s = MASTER.stations[sc];
      if (seen.has(s.u)) continue;
      seen.add(s.u);
      if (mapFilter.pref && s.pref !== mapFilter.pref) continue;
      add(s.u, s.lat, s.lon);
    }
  } else {
    for (const [u, unit] of Object.entries(MASTER.units)) {
      if (mapFilter.pref && unit.pref !== mapFilter.pref) continue;
      add(u, unit.lat, unit.lon);
    }
  }
  return points;
}

// ---------- 描画 ----------

function renderMap() {
  const empty = document.getElementById('mapEmpty');
  const body = document.getElementById('mapBody');
  if (!appState.resolved) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  // 地図画面が見えていないときは描かない（表示されたときに onMapShown で描く）
  if (document.getElementById('map').hidden || !ensureMap()) return;

  const points = collectMapPoints();
  const counts = { todo: 0, closed: 0, done: 0 };
  points.forEach(p => counts[p.status]++);

  const parts = [`未アクセス ${counts.todo} 駅`];
  if (mapFilter.showClosed) parts.push(`廃駅 ${counts.closed} 駅`);
  if (mapFilter.showDone) parts.push(`アクセス済み ${counts.done} 駅`);
  document.getElementById('mapCount').textContent = parts.join(' ／ ') + ' を表示中';

  // 色と大きさ。アクセス済み → 廃駅 → 未アクセス の順に描き、未アクセスが一番上に来るようにする
  const styles = {
    done:   { radius: 4, color: cssColor('--done'), weight: 1, fillColor: cssColor('--done'), fillOpacity: 0.5 },
    closed: { radius: 5, color: cssColor('--muted'), weight: 2, dashArray: '2 2', fillColor: cssColor('--surface'), fillOpacity: 0.8 },
    todo:   { radius: 6, color: '#ffffff', weight: 1.5, fillColor: cssColor('--todo'), fillOpacity: 0.95 },
  };
  markerLayer.clearLayers();
  for (const status of ['done', 'closed', 'todo']) {
    for (const p of points) {
      if (p.status !== status) continue;
      const marker = L.circleMarker([p.lat, p.lon], styles[status]);
      marker.bindPopup(() => stationPopup(p));
      marker.bindTooltip(MASTER.units[p.u].name, { direction: 'top', offset: [0, -4] });
      markerLayer.addLayer(marker);
    }
  }

  // 絞り込みを変えたときは、ピン全体が入るように地図を動かす
  if (needFit) {
    needFit = false;
    if (points.length === 0) {
      leafletMap.setView(JAPAN_CENTER, JAPAN_ZOOM);
    } else if (mapFilter.pref === 0 && !mapFilter.line) {
      leafletMap.setView(JAPAN_CENTER, JAPAN_ZOOM);
    } else {
      leafletMap.fitBounds(L.latLngBounds(points.map(p => [p.lat, p.lon])), { padding: [24, 24], maxZoom: 14 });
    }
  }
}

// ピンを押したときに出る説明（文字は textContent で入れる）
function stationPopup(p) {
  const unit = MASTER.units[p.u];
  const box = el('div', 'popup');
  box.append(el('b', '', unit.name), el('span', 'muted', `（${prefName(unit.pref)}）`));
  const statusText = { todo: '未アクセス', closed: '廃駅（未アクセス）', done: 'アクセス済み' }[p.status];
  box.append(el('div', 'popup-status popup-' + p.status, statusText));

  // 通る路線（押すと路線詳細へ）
  const lineCds = [];
  for (const c of unit.codes) {
    const lc = MASTER.stations[c].line;
    if (!lineCds.includes(lc) && MASTER.lines[lc]) lineCds.push(lc);
  }
  const lines = el('div', 'popup-lines');
  lineCds.slice(0, MAX_POPUP_LINES).forEach((lc, i) => {
    if (i > 0) lines.append('、');
    const a = el('a', '', MASTER.lines[lc].name);
    a.href = lineHref(lc);
    lines.append(a);
  });
  if (lineCds.length > MAX_POPUP_LINES) lines.append(` ほか ${lineCds.length - MAX_POPUP_LINES} 路線`);
  box.append(lines);
  return box;
}
