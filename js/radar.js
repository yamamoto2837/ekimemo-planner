// ============================================================
// レーダー圏（F9 の画面）
//
// 都道府県とレーダーの駅数を選ぶと、未アクセスの駅を多く取れる立ち位置を、
// 取れる駅の多い順に挙げる。計算は radarplan.js。
// ============================================================

const radarSettings = {
  prefs: new Set(),
  n: 10,            // レーダーで取れる駅の数
  count: 5,         // おすすめする地点の数
  withClosed: true, // 廃駅も対象にする（駅メモでは廃駅もレーダーで取れる）
};
let radarLeafletMap = null;

// ---------- 準備（app.js から呼ばれる） ----------

function initRadarScreen() {
  const nInput = document.getElementById('radarN');
  const countInput = document.getElementById('radarCount');
  const closed = document.getElementById('radarClosed');
  nInput.value = radarSettings.n;
  countInput.value = radarSettings.count;
  closed.checked = radarSettings.withClosed;
  nInput.addEventListener('change', () => { radarSettings.n = clampInt(nInput.value, 1, 50, 10); nInput.value = radarSettings.n; });
  countInput.addEventListener('change', () => { radarSettings.count = clampInt(countInput.value, 1, 20, 5); countInput.value = radarSettings.count; });
  closed.addEventListener('change', () => { radarSettings.withClosed = closed.checked; renderRadarPrefs(); });
  document.getElementById('radarRun').addEventListener('click', runRadar);
  document.getElementById('radarClearPrefs').addEventListener('click', () => { radarSettings.prefs.clear(); renderRadarPrefs(); });
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 取りたい駅か（未アクセス。廃駅は設定しだい）
function radarIsTarget(u) {
  if (!appState.resolved || appState.resolved.accessed.has(u)) return false;
  return radarSettings.withClosed || !MASTER.units[u].closed;
}

// ---------- 都道府県の選択 ----------

function renderRadar() {
  const empty = document.getElementById('radarEmpty');
  const body = document.getElementById('radarBody');
  if (!appState.resolved) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true;
  body.hidden = false;
  renderRadarPrefs();
}

function renderRadarPrefs() {
  const stats = getPrefStats();
  const box = document.getElementById('radarPrefList');
  if (!stats || !box) return;
  box.replaceChildren();
  for (const r of REGIONS) {
    const row = el('div', 'route-region');
    row.append(el('span', 'route-region-name', r.name));
    for (let p = r.from; p <= r.to; p++) {
      const n = stats[p].remainingActive.length + (radarSettings.withClosed ? stats[p].remainingClosed.length : 0);
      const label = el('label', 'route-pref' + (n === 0 ? ' muted' : ''));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = radarSettings.prefs.has(p);
      cb.disabled = n === 0;
      cb.addEventListener('change', () => {
        if (cb.checked) radarSettings.prefs.add(p); else radarSettings.prefs.delete(p);
        updateRadarSummary();
      });
      label.append(cb, `${prefName(p)}（${n}）`);
      row.append(label);
    }
    box.append(row);
  }
  updateRadarSummary();
}

function updateRadarSummary() {
  const names = [...radarSettings.prefs].sort((a, b) => a - b).map(prefName).join('・');
  document.getElementById('radarPrefSummary').textContent =
    radarSettings.prefs.size ? `都道府県：${names}` : '都道府県を選ぶ（未アクセス駅の数）';
  document.getElementById('radarRun').disabled = radarSettings.prefs.size === 0;
}

// ---------- 計算と表示 ----------

function runRadar() {
  const msg = document.getElementById('radarMessage');
  if (radarSettings.prefs.size === 0) { msg.textContent = '都道府県を選んでください。'; msg.className = 'message error'; return; }
  msg.textContent = '立ち位置を探しています…（数秒かかることがあります）';
  msg.className = 'message';
  document.getElementById('radarRun').disabled = true;
  setTimeout(() => {
    const t0 = performance.now();
    let result;
    try {
      result = planRadar(radarSettings.prefs, radarSettings.n, radarSettings.count, radarIsTarget);
    } catch (e) {
      msg.textContent = '計算できませんでした: ' + e.message;
      msg.className = 'message error';
      document.getElementById('radarRun').disabled = false;
      return;
    }
    msg.textContent = `${result.candidateCount} か所の候補から探しました（${((performance.now() - t0) / 1000).toFixed(1)} 秒）。`;
    msg.className = 'message good';
    document.getElementById('radarRun').disabled = false;
    renderRadarResult(result);
  }, 30);
}

// 地点の言い方（○○駅 / ○○線 A〜B のあいだ）
function radarPlaceText(p) {
  if (p.kind === 'station') return `${MASTER.units[p.u].name}駅`;
  const line = MASTER.lines[p.line] ? MASTER.lines[p.line].name : '';
  return `${line} ${MASTER.units[p.a].name}〜${MASTER.units[p.b].name} のあいだ`;
}

function renderRadarResult(result) {
  const box = document.getElementById('radarResult');
  box.replaceChildren();
  if (result.picks.length === 0) {
    box.append(el('p', 'panel muted', `この地域では、レーダー（${radarSettings.n} 駅）で取れる未アクセスの駅が見つかりませんでした。`));
    return;
  }
  const head = el('div', 'panel');
  head.append(el('h3', '', `おすすめの立ち位置（レーダー ${radarSettings.n} 駅）`));
  head.append(el('p', 'detail-count', `${result.picks.length} か所で、未アクセスの駅を合わせて ${result.gottenCount} 駅取れます`));
  head.append(el('p', 'help', '近い順に n 駅を取る前提です。アクセス済みの駅も n 駅のうちに数えます。地点は駅と線路の上（約1kmごと）から選んでいます。実際のゲームの範囲や当たり方とは違うことがあります。'));
  box.append(head);

  const mapPanel = el('div', 'panel');
  const mapDiv = el('div', 'route-map');
  mapDiv.id = 'radarMapView';
  mapPanel.append(mapDiv);
  box.append(mapPanel);

  const list = el('ol', 'route-list');
  result.picks.forEach((pick, i) => {
    const li = el('li', 'route-stop');
    const headRow = el('div', 'route-stop-head');
    headRow.append(el('span', 'route-num', String(i + 1)), el('span', 'route-name', radarPlaceText(pick.point)));
    li.append(headRow);
    const info = el('div', 'route-rides');
    info.append(el('span', 'route-km', `未アクセス ${pick.gained.length} 駅が取れる（届く範囲 約 ${pick.radiusKm.toFixed(1)} km）`));
    const names = pick.gained.map(u => {
      const unit = MASTER.units[u];
      return unit.name + (unit.closed ? '（廃駅）' : '');
    });
    info.append(el('div', 'route-ride', names.join('、')));
    const others = pick.nearest.length - pick.gained.length;
    if (others > 0) info.append(el('div', 'route-ride muted', `ほかの ${others} 駅は、アクセス済みか、前の地点で取れる駅です`));
    li.append(info);
    list.append(li);
  });
  box.append(list);
  drawRadarMap(result);
}

function drawRadarMap(result) {
  if (!window.L) {
    document.getElementById('radarMapView').replaceChildren(el('p', 'message error map-error', '地図の部品を読み込めませんでした。'));
    return;
  }
  if (radarLeafletMap) { radarLeafletMap.remove(); radarLeafletMap = null; }
  radarLeafletMap = L.map('radarMapView', { preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(radarLeafletMap);

  const bounds = [];
  result.picks.forEach((pick, i) => {
    const c = [pick.point.lat, pick.point.lon];
    // 届く範囲の円
    L.circle(c, { radius: pick.radiusKm * 1000, color: cssColor('--accent'), weight: 1, fillOpacity: 0.06 }).addTo(radarLeafletMap);
    // 取れる未アクセスの駅
    for (const u of pick.gained) {
      const unit = MASTER.units[u];
      L.circleMarker([unit.lat, unit.lon], { radius: 5, color: '#fff', weight: 1, fillColor: cssColor('--todo'), fillOpacity: 0.9 })
        .bindTooltip(unit.name).addTo(radarLeafletMap);
      bounds.push([unit.lat, unit.lon]);
    }
    // 立ち位置の番号
    const icon = L.divIcon({ className: 'route-pin', html: `<span>${i + 1}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    L.marker(c, { icon }).bindTooltip(radarPlaceText(pick.point)).addTo(radarLeafletMap);
    bounds.push(c);
  });
  const b = L.latLngBounds(bounds);
  radarLeafletMap.fitBounds(b, { padding: [24, 24], maxZoom: 13 });
  setTimeout(() => {
    if (!radarLeafletMap) return;
    radarLeafletMap.invalidateSize();
    radarLeafletMap.fitBounds(b, { padding: [24, 24], maxZoom: 13 });
  }, 100);
}

// 画面が表示されたとき（app.js から呼ばれる）
function onRadarShown() {
  renderRadar();
  if (radarLeafletMap) radarLeafletMap.invalidateSize();
}
