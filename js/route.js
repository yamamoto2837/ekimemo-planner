// ============================================================
// 巡回ルート（F7 の画面）
//
// 回る未アクセス駅を選ぶと、線路に沿って回る順番を出す。
// 選び方は2つ：
//   ・駅を選ぶ（最初はこちら）… 地図・駅名・路線から1駅ずつ選ぶ（routepick.js）
//   ・都道府県で選ぶ … 選んだ都道府県の未アクセス駅（廃駅も含められる）をすべて回る
// 計算は routeplan.js。
// ============================================================

const ROUTE_MAX_TARGETS = 300;   // 一度に回る駅の上限（多いと計算に時間がかかる）

const routeSettings = {
  mode: 'stations',   // 'stations' = 駅を選ぶ、'prefs' = 都道府県で選ぶ
  picked: new Set(),  // 駅を選ぶときの、回る駅（駅メモの駅の番号）
  prefs: new Set(),   // 選んだ都道府県
  round: false,       // 出発駅に戻ってくるか
  withClosed: true,   // 廃駅も対象にする（駅メモでは廃駅も、近くに行けば取れる）
};
let routeLeafletMap = null;
let routeLayerGroup = null;

// ---------- 準備（app.js から呼ばれる） ----------

function initRouteScreen() {
  document.getElementById('routeRun').addEventListener('click', runRoute);
  document.getElementById('routeRound').addEventListener('change', e => { routeSettings.round = e.target.checked; });
  const closedBox = document.getElementById('routeClosed');
  closedBox.checked = routeSettings.withClosed;
  closedBox.addEventListener('change', e => { routeSettings.withClosed = e.target.checked; renderRoutePrefs(); renderRoutePick(); });
  document.getElementById('routeStartForm').addEventListener('submit', e => { e.preventDefault(); runRoute(); });
  document.getElementById('routeClearPrefs').addEventListener('click', () => { routeSettings.prefs.clear(); renderRoutePrefs(); });
  initRoutePick();   // routepick.js（駅を1つずつ選ぶ欄）
}

// 回る駅の一覧
//   駅を選ぶとき … 選んだ駅のうち、いま未アクセスの駅
//   都道府県で選ぶとき … 選んだ都道府県の未アクセス駅（「廃駅も対象にする」なら廃駅も）
function routeTargets() {
  if (!appState.resolved) return [];
  if (routeSettings.mode === 'stations') {
    const accessed = appState.resolved.accessed;
    return [...routeSettings.picked].filter(u => MASTER.units[u] && !accessed.has(u));
  }
  const stats = getPrefStats();
  if (!stats) return [];
  const list = [];
  for (const p of routeSettings.prefs) list.push(...(routeSettings.withClosed ? stats[p].remaining : stats[p].remainingActive));
  return list;
}

// ---------- 都道府県の選択 ----------

function renderRoute() {
  const empty = document.getElementById('routeEmpty');
  const body = document.getElementById('routeBody');
  if (!appState.resolved) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true;
  body.hidden = false;
  renderRouteMode();   // routepick.js（選び方の切り替え）
  renderRoutePrefs();
  renderRoutePick();   // routepick.js
}

// いま使っている都道府県（都道府県で選ぶときは選んだ県、駅を選ぶときは選んだ駅のある県）
function routePrefsInUse() {
  if (routeSettings.mode === 'prefs') return [...routeSettings.prefs].sort((a, b) => a - b);
  return [...new Set(routeTargets().map(u => MASTER.units[u].pref))].sort((a, b) => a - b);
}

function renderRoutePrefs() {
  const stats = getPrefStats();
  const box = document.getElementById('routePrefList');
  box.replaceChildren();
  for (const r of REGIONS) {
    const row = el('div', 'route-region');
    row.append(el('span', 'route-region-name', r.name));
    for (let p = r.from; p <= r.to; p++) {
      const n = (routeSettings.withClosed ? stats[p].remaining : stats[p].remainingActive).length;
      const label = el('label', 'route-pref' + (n === 0 ? ' muted' : ''));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = routeSettings.prefs.has(p);
      cb.disabled = n === 0;
      cb.addEventListener('change', () => {
        if (cb.checked) routeSettings.prefs.add(p); else routeSettings.prefs.delete(p);
        updateRouteCount();
      });
      label.append(cb, `${prefName(p)}（${n}）`);
      row.append(label);
    }
    box.append(row);
  }
  updateRouteCount();
}

function updateRouteCount() {
  const n = routeTargets().length;
  const names = [...routeSettings.prefs].sort((a, b) => a - b).map(prefName).join('・');
  document.getElementById('routePrefSummary').textContent =
    routeSettings.prefs.size ? `都道府県：${names}（対象 ${n} 駅）` : '都道府県を選ぶ（未アクセス駅の数）';
  const run = document.getElementById('routeRun');
  run.disabled = n === 0 || n > ROUTE_MAX_TARGETS;
  const msg = document.getElementById('routeMessage');
  if (n > ROUTE_MAX_TARGETS) {
    msg.textContent = `対象が ${n} 駅あります。計算に時間がかかるので、${ROUTE_MAX_TARGETS} 駅以下になるよう${routeSettings.mode === 'prefs' ? '都道府県' : '駅'}を減らしてください。`;
    msg.className = 'message error';
  } else if (msg.className.includes('error')) {
    msg.textContent = '';
    msg.className = 'message';
  }
}

// ---------- 出発する駅 ----------

// 駅名から出発駅を決める（同じ名前が複数あれば、選んだ都道府県の駅を優先）
function findRouteStart(name) {
  if (!name) return { unit: null };
  const hits = Object.entries(MASTER.units).filter(([, u]) => u.name === name);
  if (hits.length === 0) return { error: `「${name}」という駅が見つかりません（「駅」は付けずに入力します）。` };
  const prefs = new Set(routePrefsInUse());
  const inPrefs = hits.filter(([, u]) => prefs.has(u.pref));
  const [id] = (inPrefs.length ? inPrefs : hits)[0];
  return { unit: id, note: hits.length > 1 ? `「${name}」は ${hits.length} 駅あるので、${prefName(MASTER.units[id].pref)}の駅を使いました。` : '' };
}

// ---------- 計算と表示 ----------

function runRoute() {
  const msg = document.getElementById('routeMessage');
  const targets = routeTargets();
  if (targets.length === 0) { msg.textContent = routeSettings.mode === 'prefs' ? '都道府県を選んでください。' : '回る駅を選んでください。'; msg.className = 'message error'; return; }
  const start = findRouteStart(document.getElementById('routeStart').value.trim());
  if (start.error) { msg.textContent = start.error; msg.className = 'message error'; return; }

  msg.textContent = `${targets.length} 駅の順番を考えています…（数秒かかることがあります）`;
  msg.className = 'message';
  document.getElementById('routeRun').disabled = true;
  // 画面に「考えています」を出してから計算する
  setTimeout(() => {
    const t0 = performance.now();
    let plan;
    try {
      plan = planRoute(targets, start.unit, routeSettings.round);
    } catch (e) {
      msg.textContent = '順番を計算できませんでした: ' + e.message;
      msg.className = 'message error';
      document.getElementById('routeRun').disabled = false;
      return;
    }
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    msg.textContent = (start.note ? start.note + ' ' : '') + `計算しました（${sec} 秒）。`;
    msg.className = 'message good';
    document.getElementById('routeRun').disabled = false;
    renderRouteResult(plan, start.unit, new Set(targets));
  }, 30);
}

function lineName(lc) {
  if (lc === 'transfer') return '乗り換え';
  if (lc === 'guess') return '線路データ無し（推定）';
  if (String(lc).startsWith('closed:')) {
    const real = lc.slice(7);
    return (MASTER.lines[real] ? MASTER.lines[real].name : real) + '（廃止区間・直線で推定）';
  }
  return MASTER.lines[lc] ? MASTER.lines[lc].name : lc;
}

function renderRouteResult(plan, startUnit, targetSet) {
  const box = document.getElementById('routeResult');
  box.replaceChildren();
  if (plan.order.length === 0) { box.append(el('p', 'muted', '回れる駅がありませんでした。')); return; }

  // 回る未アクセス駅の数（出発駅も未アクセスなら数に入れる）
  const visitCount = new Set(plan.order.filter(u => targetSet.has(u))).size;
  const head = el('div', 'panel');
  head.append(el('h3', '', `${visitCount} 駅を回る順番`));
  head.append(el('p', 'detail-count', `線路に沿った距離 約 ${Math.round(plan.totalKm)} km`));
  head.append(el('p', 'help', '乗り換え時間や運行本数は考えていません。机の上で計画を立てるための目安です。'));
  if (plan.guessed.length > 0) {
    head.append(el('p', 'notice', `線路のデータが無い駅（新幹線だけの駅や廃駅など）を含むため、${plan.guessed.length} 駅の前後は、近くの駅から直線で推定しています。`));
  }
  if (plan.unreachable.length > 0) {
    head.append(el('p', 'notice', `線路でつながっていないため、次の駅は順番に入れていません: ${plan.unreachable.map(u => MASTER.units[u] ? MASTER.units[u].name : u).join('、')}`));
  }
  box.append(head);

  // プランとして保存（plans.js）
  const save = el('div', 'panel plan-save');
  save.append(el('h4', '', 'プランとして保存'));
  const row = el('div', 'filter-row');
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.maxLength = 60;
  nameInput.value = routePrefsInUse().map(prefName).join('・') + ' 遠征';
  nameInput.setAttribute('aria-label', 'プランの名前');
  const dateInput = el('input');
  dateInput.type = 'date';
  dateInput.value = todayText();
  dateInput.setAttribute('aria-label', '遠征の日付');
  const saveBtn = el('button', 'primary', '保存する');
  saveBtn.type = 'button';
  const saveMsg = el('p', 'message');
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim() || '遠征';
    if (!dateInput.value) { saveMsg.textContent = '日付を入れてください。'; saveMsg.className = 'message error'; return; }
    saveBtn.disabled = true;
    try {
      const id = await addPlanFromRoute(name, dateInput.value, plan, startUnit, routeSettings.round, targetSet);
      saveMsg.replaceChildren(document.createTextNode('保存しました。'));
      const a = el('a', '', '遠征プランを見る');
      a.href = '#plans/' + encodeURIComponent(id);
      saveMsg.append(' ', a);
      saveMsg.className = 'message good';
    } catch (e) {
      saveMsg.textContent = '保存できませんでした: ' + e.message;
      saveMsg.className = 'message error';
      saveBtn.disabled = false;
    }
  });
  row.append(nameInput, dateInput, saveBtn);
  save.append(row, saveMsg);
  box.append(save);

  // 地図
  const mapPanel = el('div', 'panel');
  const mapDiv = el('div', 'route-map');
  mapDiv.id = 'routeMapView';
  mapPanel.append(mapDiv);
  box.append(mapPanel);

  // 順番の一覧
  const list = el('ol', 'route-list');
  plan.order.forEach((u, i) => {
    const unit = MASTER.units[u];
    const li = el('li', 'route-stop');
    const isStart = i === 0 && u === startUnit;
    const isReturn = routeSettings.round && i === plan.order.length - 1 && i > 0;
    const num = el('span', 'route-num', isStart ? '出発' : isReturn ? '到着' : String(startUnit ? i : i + 1));
    const name = el('span', 'route-name', unit.name);
    name.append(el('small', 'muted', `（${prefName(unit.pref)}）`));
    const headRow = el('div', 'route-stop-head');
    headRow.append(num, name);
    li.append(headRow);

    // 前の駅からの乗り方
    if (i > 0) {
      const leg = plan.legs[i - 1];
      const rides = el('div', 'route-rides');
      rides.append(el('span', 'route-km', `約 ${leg.km < 10 ? leg.km.toFixed(1) : Math.round(leg.km)} km`));
      for (const r of leg.rides) {
        const t = r.line === 'transfer'
          ? `乗り換え（${MASTER.units[r.from].name}→${MASTER.units[r.to].name}）`
          : `${lineName(r.line)}：${MASTER.units[r.from].name}→${MASTER.units[r.to].name}`;
        rides.append(el('div', (r.line === 'guess' || String(r.line).startsWith('closed:')) ? 'route-ride guess' : 'route-ride', t));
      }
      li.append(rides);
    }
    const memo = memoView(stationMemo(u));
    if (memo) li.append(memo);
    list.append(li);
  });
  box.append(list);

  drawRouteMap(plan, startUnit);
}

// 地図に、番号と通る道すじを描く
function drawRouteMap(plan, startUnit) {
  if (!window.L) {
    document.getElementById('routeMapView').replaceChildren(el('p', 'message error map-error', '地図の部品を読み込めませんでした。'));
    return;
  }
  if (routeLeafletMap) { routeLeafletMap.remove(); routeLeafletMap = null; }
  routeLeafletMap = L.map('routeMapView', { preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(routeLeafletMap);
  routeLayerGroup = L.layerGroup().addTo(routeLeafletMap);

  // 道すじ（通る駅を順につなぐ）
  const pts = [];
  for (const leg of plan.legs) for (const r of leg.rides) for (const u of r.path) {
    const unit = MASTER.units[u];
    pts.push([unit.lat, unit.lon]);
  }
  if (pts.length > 1) L.polyline(pts, { color: cssColor('--accent'), weight: 3, opacity: 0.7 }).addTo(routeLayerGroup);

  // 回る駅に番号
  plan.order.forEach((u, i) => {
    const unit = MASTER.units[u];
    const isStart = i === 0 && u === startUnit;
    const label = isStart ? '出' : String(startUnit ? i : i + 1);
    if (routeSettings.round && i === plan.order.length - 1 && i > 0) return;   // 戻ってきた出発駅は描かない
    const icon = L.divIcon({ className: 'route-pin', html: `<span>${label}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    L.marker([unit.lat, unit.lon], { icon }).bindTooltip(unit.name).addTo(routeLayerGroup);
  });
  // 描いた直後は地図の大きさが正しく測れないことがあるので、測り直してから範囲を合わせる
  const bounds = L.latLngBounds(plan.order.map(u => [MASTER.units[u].lat, MASTER.units[u].lon]));
  routeLeafletMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
  setTimeout(() => {
    if (!routeLeafletMap) return;
    routeLeafletMap.invalidateSize();
    routeLeafletMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
  }, 100);
}

// 画面が表示されたとき（app.js から呼ばれる）：地図の大きさを測り直す
function onRouteShown() {
  renderRoute();
  if (routeLeafletMap) routeLeafletMap.invalidateSize();
  fitRoutePickMap();   // routepick.js（駅を選ぶ地図の大きさを測り直す）
}
