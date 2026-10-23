// ============================================================
// 巡回ルート：回る駅を1駅ずつ選ぶ
//
// 3つの方法で、同じ「回る駅」の一覧（routeSettings.picked）に入れる。
//   ・地図で選ぶ … 駅の印を押すと入り、もう一度押すと外れる（アクセス済みの駅も選べる）
//   ・駅名で足す … 駅名を入れて「足す」。同じ名前の駅がいくつかあれば選ぶ（アクセス済みの駅も選べる）
//   ・路線から選ぶ … 路線を選ぶと、その路線の未アクセス駅がチェックつきで並ぶ
// 選んだ駅と選び方は、このブラウザに覚えておく（次に開いたときも残る）。
// ============================================================

const PICK_STORE_KEY = 'ekimemo-route-pick';   // 覚えておく場所（localStorage）
const PICK_SHOWN_MAX = 120;                     // 「回る駅」の一覧に並べる上限

let pickLeafletMap = null;
let pickLayer = null;
let pickMarkers = new Map();   // 駅メモの駅 → 地図の印
let pickMapFitted = false;     // 最初に地図の範囲を合わせたか
let pickLineCd = '';           // 「路線から選ぶ」で選んでいる路線
let pickShowDone = true;       // アクセス済みの駅も地図に出すか

// ---------- 準備（route.js の initRouteScreen から呼ばれる） ----------

function initRoutePick() {
  // 覚えていた中身を戻す
  try {
    const saved = JSON.parse(localStorage.getItem(PICK_STORE_KEY) || 'null');
    if (saved) {
      if (saved.mode === 'prefs' || saved.mode === 'stations') routeSettings.mode = saved.mode;
      if (Array.isArray(saved.picked)) routeSettings.picked = new Set(saved.picked.filter(u => MASTER.units[u]));
    }
  } catch (e) { /* 覚えていなくても動く */ }

  document.querySelectorAll('#routeModeChips .chip').forEach(b => {
    b.addEventListener('click', () => {
      routeSettings.mode = b.dataset.mode;
      storePick();
      renderRouteMode();
      renderRoutePick();
      fitRoutePickMap();
    });
  });
  document.getElementById('routePickClear').addEventListener('click', () => {
    if (routeSettings.picked.size && !confirm(`回る駅 ${routeSettings.picked.size} 駅をすべて外しますか？`)) return;
    routeSettings.picked.clear();
    pickChanged();
    restyleAllPickMarkers();
  });
  document.getElementById('routePickNameForm').addEventListener('submit', e => { e.preventDefault(); addPickByName(); });
  document.getElementById('routePickLineSearch').addEventListener('input', fillPickLines);
  document.getElementById('routePickLine').addEventListener('change', e => { pickLineCd = e.target.value; renderPickLineStations(); });
  document.getElementById('routePickMapBox').addEventListener('toggle', fitRoutePickMap);
  const showDone = document.getElementById('routePickShowDone');
  showDone.checked = pickShowDone;
  showDone.addEventListener('change', () => { pickShowDone = showDone.checked; drawPickMap(); });
}

function storePick() {
  try {
    localStorage.setItem(PICK_STORE_KEY, JSON.stringify({ mode: routeSettings.mode, picked: [...routeSettings.picked] }));
  } catch (e) { /* 覚えられなくても動く */ }
}

// ---------- 選び方の切り替え ----------

function renderRouteMode() {
  const stations = routeSettings.mode === 'stations';
  document.querySelectorAll('#routeModeChips .chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === routeSettings.mode)));
  document.getElementById('routePickBox').hidden = !stations;
  document.getElementById('routePrefBox').hidden = stations;
  updateRouteCount();   // route.js
}

// ---------- 選べる駅 ----------

// 未アクセスで選べる駅か（廃駅なら「廃駅も対象にする」のとき）。「路線から選ぶ」で使う
function pickable(u) {
  const unit = MASTER.units[u];
  if (!unit || !appState.resolved || appState.resolved.accessed.has(u)) return false;
  return routeSettings.withClosed || !unit.closed;
}

// アクセス済みの駅か
function pickDone(u) {
  return !!(appState.resolved && MASTER.units[u] && appState.resolved.accessed.has(u));
}

// 地図や駅名で選べる駅か（未アクセスで選べる駅か、アクセス済みの駅）
function pickableAny(u) {
  return pickable(u) || pickDone(u);
}

function setPicked(u, on) {
  if (on) routeSettings.picked.add(u); else routeSettings.picked.delete(u);
}

// 回る駅が変わったとき：一覧・路線の欄・数を描き直して、覚えておく
function pickChanged() {
  storePick();
  renderPickedList();
  renderPickLineStations();
  updateRouteCount();   // route.js
}

// ---------- 描画（route.js の renderRoute から呼ばれる） ----------

function renderRoutePick() {
  if (!appState.resolved || routeSettings.mode !== 'stations') return;
  // 駅マスタから無くなった駅は、回る駅から外す（アクセス済みになった駅は、選んだまま残す）
  let removed = 0;
  for (const u of [...routeSettings.picked]) {
    if (!MASTER.units[u]) { routeSettings.picked.delete(u); removed++; }
  }
  if (removed) storePick();
  renderPickedList();
  fillPickLines();
  renderPickLineStations();
  drawPickMap();
}

// 「回る駅」の一覧（押すと外れる）
function renderPickedList() {
  const targets = routeTargets();   // route.js
  const box = document.getElementById('routePickedList');
  box.replaceChildren();
  const closedOut = [...routeSettings.picked].filter(u => !pickableAny(u) && MASTER.units[u] && MASTER.units[u].closed).length;
  document.getElementById('routePickedCount').textContent = `回る駅 ${targets.length} 駅`;
  document.getElementById('routePickClear').hidden = routeSettings.picked.size === 0;
  if (targets.length === 0) {
    box.append(el('p', 'muted', 'まだ選んでいません。下の地図・駅名・路線から選んでください。'));
    return;
  }
  for (const u of targets.slice(0, PICK_SHOWN_MAX)) {
    const unit = MASTER.units[u];
    const b = el('button', 'chip picked-chip' + (pickDone(u) ? ' picked-done' : ''), `${unit.name}${unit.closed ? '（廃駅）' : ''}${pickDone(u) ? '（アクセス済み）' : ''} ✕`);
    b.type = 'button';
    b.title = `${unit.name}（${prefName(unit.pref)}）を外す`;
    b.addEventListener('click', () => { setPicked(u, false); pickChanged(); restylePickMarker(u); });
    box.append(b);
  }
  if (targets.length > PICK_SHOWN_MAX) box.append(el('span', 'muted', `ほか ${targets.length - PICK_SHOWN_MAX} 駅`));
  if (closedOut) box.append(el('p', 'help', `「廃駅も対象にする」を外しているため、選んだ廃駅 ${closedOut} 駅は数に入れていません。`));
}

// ---------- 地図で選ぶ ----------

function pickStyle(u) {
  const unit = MASTER.units[u];
  if (routeSettings.picked.has(u)) return { radius: 8, color: '#ffffff', weight: 2, dashArray: null, fillColor: cssColor('--accent'), fillOpacity: 1 };
  // アクセス済み：押して選べるよう、地図の道路にまぎれない濃さにする
  if (pickDone(u)) return { radius: 5, color: '#ffffff', weight: 1.5, dashArray: null, fillColor: cssColor('--muted'), fillOpacity: 0.9 };
  if (unit.closed) return { radius: 5, color: cssColor('--muted'), weight: 2, dashArray: '2 2', fillColor: cssColor('--surface'), fillOpacity: 0.8 };
  return { radius: 6, color: '#ffffff', weight: 1.5, dashArray: null, fillColor: cssColor('--todo'), fillOpacity: 0.95 };
}

function drawPickMap() {
  // 画面や地図の欄が見えていないときは描かない（見えたときに fitRoutePickMap で描く）
  if (!appState.resolved || document.getElementById('route').hidden || !document.getElementById('routePickMapBox').open) return;
  if (!window.L) {
    document.getElementById('routePickMap').replaceChildren(el('p', 'message error map-error', '地図の部品を読み込めませんでした。'));
    return;
  }
  if (!pickLeafletMap) {
    pickLeafletMap = L.map('routePickMap', { preferCanvas: true }).setView(JAPAN_CENTER, JAPAN_ZOOM);   // map.js の日本の真ん中
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(pickLeafletMap);
    pickLayer = L.layerGroup().addTo(pickLeafletMap);
  }
  pickLayer.clearLayers();
  pickMarkers = new Map();
  // アクセス済み → 廃駅 → 未アクセス → 回る駅 の順に描き、回る駅が一番上に来るようにする
  // アクセス済みの駅は「アクセス済みの駅も地図に出す」のときだけ（選んだ駅はいつも出す）
  const units = Object.keys(MASTER.units).filter(u => pickable(u) || (pickDone(u) && (pickShowDone || routeSettings.picked.has(u))));
  const rank = u => routeSettings.picked.has(u) ? 3 : pickDone(u) ? 0 : MASTER.units[u].closed ? 1 : 2;
  units.sort((a, b) => rank(a) - rank(b));
  for (const u of units) {
    const unit = MASTER.units[u];
    const marker = L.circleMarker([unit.lat, unit.lon], pickStyle(u));
    marker.bindTooltip(unit.name + (unit.closed ? '（廃駅）' : '') + (pickDone(u) ? '（アクセス済み）' : ''), { direction: 'top', offset: [0, -4] });
    marker.on('click', () => {
      setPicked(u, !routeSettings.picked.has(u));
      pickChanged();
      restylePickMarker(u);
    });
    pickLayer.addLayer(marker);
    pickMarkers.set(u, marker);
  }
  // 最初の1回だけ、選んだ駅が入るように範囲を合わせる
  if (!pickMapFitted) {
    pickMapFitted = true;
    const sel = routeTargets();
    setTimeout(() => {
      if (!pickLeafletMap) return;
      pickLeafletMap.invalidateSize();
      if (sel.length) pickLeafletMap.fitBounds(L.latLngBounds(sel.map(u => [MASTER.units[u].lat, MASTER.units[u].lon])), { padding: [24, 24], maxZoom: 12 });
    }, 100);
  }
}

function restylePickMarker(u) {
  // アクセス済みの駅を出さない設定のときは、出す・消すが変わるので描き直す
  if (pickDone(u) && !pickShowDone) { drawPickMap(); return; }
  const m = pickMarkers.get(u);
  if (!m) return;
  m.setStyle(pickStyle(u));
  if (routeSettings.picked.has(u)) m.bringToFront();
}

function restyleAllPickMarkers() {
  drawPickMap();
}

// 画面や地図の欄が見えたとき：地図を描く（描いてあれば大きさを測り直す）
function fitRoutePickMap() {
  if (routeSettings.mode !== 'stations') return;
  if (!pickLeafletMap) { drawPickMap(); return; }
  setTimeout(() => { if (pickLeafletMap) pickLeafletMap.invalidateSize(); }, 100);
}

// ---------- 駅名で足す ----------

function addPickByName() {
  const input = document.getElementById('routePickName');
  const msg = document.getElementById('routePickNameMsg');
  const choices = document.getElementById('routePickNameChoices');
  choices.replaceChildren();
  const text = input.value.trim();
  const say = (t, kind) => { msg.textContent = t; msg.className = 'message' + (kind ? ' ' + kind : ''); };
  if (!text) { say('駅名を入れてください。', 'error'); return; }

  const hits = findStationsByName(text);   // myroute.js
  if (hits.length === 0) { say(`「${text}」という駅が見つかりません（駅メモでの名前で入れます）。`, 'error'); return; }
  const ok = hits.filter(pickableAny);   // アクセス済みの駅も選べる
  if (ok.length === 0) {
    say(`「${text}」は廃駅です。「廃駅も対象にする」にチェックを入れると選べます。`, 'error');
    return;
  }
  const add = u => {
    if (routeSettings.picked.has(u)) { say(`${MASTER.units[u].name} は、もう回る駅に入っています。`, ''); return; }
    setPicked(u, true);
    pickChanged();
    restylePickMarker(u);
    say(`${MASTER.units[u].name}（${prefName(MASTER.units[u].pref)}${pickDone(u) ? '・アクセス済み' : ''}）を足しました。`, 'good');
    input.value = '';
    choices.replaceChildren();
  };
  if (ok.length === 1) { add(ok[0]); return; }
  // 同じ名前の駅がいくつかあるときは、選んでもらう
  say(`「${text}」は ${ok.length} 駅あります。足す駅を選んでください。`, '');
  for (const u of ok) {
    const b = el('button', '', candidateLabel(u) + (pickDone(u) ? '（アクセス済み）' : ''));   // myroute.js
    b.type = 'button';
    b.addEventListener('click', () => add(u));
    choices.append(b);
  }
}

// ---------- 路線から選ぶ ----------

function pickLineStats() {
  const stats = getLineStats();
  const byCd = {};
  if (stats) for (const s of stats) byCd[s.cd] = s;
  return byCd;
}

// 路線の選択肢（未アクセス駅が残っている路線だけ。絞り込みの文字があれば、その文字を含む路線だけ）
function fillPickLines() {
  const select = document.getElementById('routePickLine');
  const word = document.getElementById('routePickLineSearch').value.trim();
  const byCd = pickLineStats();
  const lines = [];
  for (const [cd, line] of Object.entries(MASTER.lines)) {
    if (word && !line.name.includes(word)) continue;
    const s = byCd[cd];
    const n = s ? s.remaining.filter(pickable).length : 0;
    if (n > 0) lines.push({ cd, name: line.name, n });
  }
  lines.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  select.replaceChildren(new Option(lines.length ? `路線を選んでください（${lines.length} 路線）` : '当てはまる路線がありません', ''));
  for (const l of lines) select.append(new Option(`${l.name}（残り ${l.n}）`, l.cd));
  // 絞り込みで1つに決まったら、その路線を選ぶ
  if (word && lines.length === 1) pickLineCd = lines[0].cd;
  select.value = lines.some(l => l.cd === pickLineCd) ? pickLineCd : '';
  if (select.value !== pickLineCd) { pickLineCd = select.value; }
  renderPickLineStations();
}

function renderPickLineStations() {
  const box = document.getElementById('routePickLineStations');
  box.replaceChildren();
  if (!pickLineCd || !appState.resolved) return;
  const s = pickLineStats()[pickLineCd];
  if (!s) return;
  const units = s.remaining.filter(pickable);   // 路線の並び順
  if (units.length === 0) { box.append(el('p', 'muted', 'この路線に選べる未アクセス駅はありません。')); return; }

  const buttons = el('div', 'buttons');
  const allOn = el('button', '', `この路線の残り ${units.length} 駅をすべて選ぶ`);
  allOn.type = 'button';
  allOn.addEventListener('click', () => { units.forEach(u => setPicked(u, true)); pickChanged(); units.forEach(restylePickMarker); });
  const allOff = el('button', '', 'この路線の駅をすべて外す');
  allOff.type = 'button';
  allOff.addEventListener('click', () => { units.forEach(u => setPicked(u, false)); pickChanged(); units.forEach(restylePickMarker); });
  buttons.append(allOn, allOff);
  box.append(buttons);

  const list = el('div', 'route-pick-stations');
  for (const u of units) {
    const unit = MASTER.units[u];
    const label = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = routeSettings.picked.has(u);
    cb.addEventListener('change', () => { setPicked(u, cb.checked); pickChanged(); restylePickMarker(u); });
    label.append(cb, ` ${unit.name}${unit.closed ? '（廃駅）' : ''}`);
    list.append(label);
  }
  box.append(list);
}
