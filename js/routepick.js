// ============================================================
// 巡回ルート：回る駅を1駅ずつ選ぶ
//
// 駅の取り方は3つ。地図・駅名・路線の一覧のどれで選んでも、いま選んでいる取り方で入る。
//   ・チェックイン（青）  … 実際に行く駅。回る順番は、この駅だけで考える（routeSettings.picked）
//   ・レーダー（紫）      … チェックインする駅から、レーダーで取る駅（routeSettings.radar：駅 → どの駅から）
//                           「どの駅から」を決めていなければ、いちばん近いチェックイン駅から取る
//   ・ルートビューン（緑）… 2つのチェックイン駅の間の駅を取る（routeSettings.rv：[{ a, b }]）
//                           2駅を両方通る路線ごとに、路線の並びで2駅の間にある駅が取れる
//                           （例: 東京と品川 → 新橋、有楽町〜高輪ゲートウェイ）
//   ・途中で取る（オレンジ）… 寄らずに、乗っている途中で取る駅（routeSettings.pass）
//                           いちばん近い区間に割り当てて表示する
//                           （自分で選ばなくても、線路沿いで取れる駅は自動で見つける：routeplan.js）
// 選んだ駅と選び方は、このブラウザに覚えておく（次に開いたときも残る）。
// ============================================================

const PICK_STORE_KEY = 'ekimemo-route-pick';   // 覚えておく場所（localStorage）
const PICK_SHOWN_MAX = 120;                     // 一覧に並べる上限

const PICK_ROLES = [
  { value: 'checkin', label: 'チェックイン' },
  { value: 'radar', label: 'レーダー' },
  { value: 'rv', label: 'ルートビューン' },
  { value: 'pass', label: '途中で取る' },
];
const ROLE_NAMES = { checkin: 'チェックイン', radar: 'レーダー', rv: 'ルートビューン', pass: '途中で取る' };

let pickLeafletMap = null;
let pickLayer = null;
let pickMarkers = new Map();   // 駅メモの駅 → 地図の印
let pickMapFitted = false;     // 最初に地図の範囲を合わせたか
let pickLineCd = '';           // 「路線から選ぶ」で選んでいる路線
let pickShowDone = true;       // アクセス済みの駅も地図に出すか
let pickRole = 'checkin';      // いま選んでいる取り方
let rvPending = null;          // ルートビューンで、1つ目に押した駅

// ---------- 準備（route.js の initRouteScreen から呼ばれる） ----------

function initRoutePick() {
  routeSettings.radar = new Map();
  routeSettings.rv = [];
  routeSettings.pass = new Set();
  // 覚えていた中身を戻す
  try {
    const saved = JSON.parse(localStorage.getItem(PICK_STORE_KEY) || 'null');
    if (saved) {
      if (saved.mode === 'prefs' || saved.mode === 'stations') routeSettings.mode = saved.mode;
      if (Array.isArray(saved.picked)) routeSettings.picked = new Set(saved.picked.filter(u => MASTER.units[u]));
      if (Array.isArray(saved.radar)) routeSettings.radar = new Map(saved.radar.filter(([u]) => MASTER.units[u]));
      if (Array.isArray(saved.rv)) routeSettings.rv = saved.rv.filter(p => MASTER.units[p.a] && MASTER.units[p.b]);
      if (Array.isArray(saved.pass)) routeSettings.pass = new Set(saved.pass.filter(u => MASTER.units[u]));
      if (typeof saved.autoPass === 'boolean') routeSettings.autoPass = saved.autoPass;
      if (Number.isInteger(saved.radarN) && saved.radarN >= 1 && saved.radarN <= 50) routeSettings.radarN = saved.radarN;
      if (typeof saved.splitTransfers === 'boolean') routeSettings.splitTransfers = saved.splitTransfers;
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
  // 取り方の切り替え
  const roleBox = document.getElementById('routePickRoles');
  for (const r of PICK_ROLES) {
    const b = el('button', 'chip role-chip role-' + r.value, r.label);
    b.type = 'button';
    b.dataset.role = r.value;
    b.addEventListener('click', () => {
      pickRole = r.value;
      const old = rvPending;
      rvPending = null;
      if (old) restylePick([old]);
      renderPickRoles();
      renderPickLineStations();
    });
    roleBox.append(b);
  }
  renderPickRoles();

  document.getElementById('routePickClear').addEventListener('click', () => {
    const n = routeSettings.picked.size + routeSettings.radar.size + routeSettings.pass.size;
    if (n && !confirm('選んだ駅をすべて外しますか？（チェックイン・レーダー・ルートビューン・途中で取るのすべて）')) return;
    routeSettings.picked.clear();
    routeSettings.radar.clear();
    routeSettings.rv = [];
    routeSettings.pass.clear();
    rvPending = null;
    pickChanged();
    drawPickMap();
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
    localStorage.setItem(PICK_STORE_KEY, JSON.stringify({
      mode: routeSettings.mode,
      picked: [...routeSettings.picked],
      radar: [...routeSettings.radar],
      rv: routeSettings.rv,
      pass: [...routeSettings.pass],
      autoPass: routeSettings.autoPass,
      radarN: routeSettings.radarN,
      splitTransfers: routeSettings.splitTransfers,
    }));
  } catch (e) { /* 覚えられなくても動く */ }
}

// ---------- 選び方・取り方の切り替え ----------

function renderRouteMode() {
  const stations = routeSettings.mode === 'stations';
  document.querySelectorAll('#routeModeChips .chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === routeSettings.mode)));
  document.getElementById('routePickBox').hidden = !stations;
  document.getElementById('routePrefBox').hidden = stations;
  updateRouteCount();   // route.js
}

function renderPickRoles() {
  document.querySelectorAll('#routePickRoles .chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.role === pickRole)));
  const help = {
    checkin: '地図の駅を押すと「チェックインする駅」に入ります。もう一度押すと外れます。',
    radar: '地図の駅を押すと「レーダーで取る駅」に入ります。使う場所は、経路の中で近い順の番号がいちばん小さくなる所を自動で探します（下の一覧で、使うチェックイン駅を決めることもできます）。',
    rv: '地図の駅を2つ順に押すと、2駅がチェックイン駅になり、その間の駅が「ルートビューンで取る駅」になります。',
    pass: '地図の駅を押すと「途中で取る駅」に入ります。寄らずに、近くを通る電車に乗っている途中で取る駅です（回る順番には入れず、いちばん近い区間に並べます）。',
  };
  setPickMessage(help[pickRole], '');
}

function setPickMessage(text, kind) {
  const msg = document.getElementById('routePickRoleMsg');
  msg.textContent = text;
  msg.className = 'message' + (kind ? ' ' + kind : '');
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

// ---------- ルートビューン ----------

// 2駅を両方通る路線ごとに、路線の並びで2駅の間にある駅を集める
// 戻り値: { lines: 両方を通る路線の数, units: [間の駅]（重なり無し） }
function rvBetween(a, b) {
  const units = [];
  const seen = new Set([a, b]);
  let lines = 0;
  for (const line of Object.values(MASTER.lines)) {
    const order = [];
    for (const sc of line.stations) {
      const u = MASTER.stations[sc].u;
      if (order[order.length - 1] !== u) order.push(u);
    }
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia < 0 || ib < 0) continue;
    lines++;
    const [from, to] = ia < ib ? [ia, ib] : [ib, ia];
    for (let i = from + 1; i < to; i++) {
      if (!seen.has(order[i])) { seen.add(order[i]); units.push(order[i]); }
    }
  }
  return { lines, units };
}

// ルートビューンの区間ごとの、取れる駅（2駅がまだチェックイン駅のものだけ）
function rvPairs() {
  return routeSettings.rv
    .filter(p => routeSettings.picked.has(p.a) && routeSettings.picked.has(p.b))
    .map(p => {
      const units = rvBetween(p.a, p.b).units.filter(u => routeSettings.withClosed || !MASTER.units[u].closed || pickDone(u));
      return { a: p.a, b: p.b, units, todo: units.filter(u => !pickDone(u)) };
    });
}

// ルートビューンで取れる駅すべて
function rvUnitSet() {
  const set = new Set();
  for (const p of rvPairs()) for (const u of p.units) set.add(u);
  return set;
}

// ---------- レーダー ----------

// 駅メモのレーダーは「いる場所から近い順に n 駅」を取る、という前提（レーダー画面 F9 と同じ）。
// レーダーで取る駅ごとに、経路の上（チェックイン駅と、乗っている途中の地点）で
// その駅が近い順の何番目になるかを調べ、いちばん小さい番号になる場所で使う。

// レーダーを使える場所の一覧：チェックイン駅と、区間の道すじの上に 0.3km おきに置いた点（経路の順番どおり）
//   戻り値: [{ lat, lon, stop: チェックイン駅 or null, leg: 区間の番号 or null, seq: 経路の中の順番 }]
function radarUsePoints(order, legs) {
  const pts = [];
  const seen = new Set();
  const addStop = u => {
    if (seen.has(u)) return;
    seen.add(u);
    pts.push({ lat: MASTER.units[u].lat, lon: MASTER.units[u].lon, stop: u, leg: null, seq: pts.length });
  };
  order.forEach((u, i) => {
    addStop(u);
    const l = (legs || [])[i];
    if (!l || !isFinite(l.km)) return;
    for (const r of l.rides) {
      if (r.line === 'guess') continue;   // 推定のつなぎは、実際には乗れない
      for (let k = 0; k + 1 < r.path.length; k++) {
        const a = MASTER.units[r.path[k]], b = MASTER.units[r.path[k + 1]];
        const steps = Math.max(1, Math.ceil(routeDistKm(a, b) / PASS_STEP_KM));   // routeplan.js
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          pts.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, stop: null, leg: i, seq: pts.length });
        }
      }
    }
  });
  return pts;
}

// 地点 p で、駅 u が近い順の何番目か（n 番目までに入らなければ 0）
function radarRankAt(p, u, n) {
  if (!p.near) p.near = radarNearest(p.lat, p.lon, n);   // radarplan.js（同じ点は1回だけ調べる）
  const i = p.near.findIndex(x => x.u === u);
  return i < 0 ? 0 : i + 1;
}

// レーダーで取る駅を、どこで使うか決める（巡回ルートの選んだ駅で）
function planRadarUse(order, legs) {
  return planRadarUseFor(radarTargets(), order, legs, routeSettings.radarN, routeSettings.radar);
}

// レーダーで取る駅を、どこで使うか決める
//   targets … レーダーで取る駅、n … レーダーで取れる駅の数、chosen … Map(駅 → 使うチェックイン駅。'' なら自動)
//   戻り値: { ok: [{ u, rank, stop, leg, near: その場所でいちばん近い駅, lat, lon, seq }]（経路の順番どおり）, ng: [{ u, from }] }
function planRadarUseFor(targets, order, legs, n, chosenMap) {
  const pts = radarUsePoints(order, legs);
  const ok = [], ng = [];
  for (const u of targets) {
    const unit = MASTER.units[u];
    const chosen = chosenMap ? chosenMap.get(u) : '';
    // 使う場所の候補：選んだチェックイン駅があれば、その駅だけ。無ければ経路の上すべて
    const cands = chosen && order.includes(chosen)
      ? pts.filter(p => p.stop === chosen)
      : pts.filter(p => routeDistKm(p, unit) <= 60);
    let best = null;
    for (const p of cands) {
      const rank = radarRankAt(p, u, n);
      if (!rank) continue;
      // 番号が小さい場所を選ぶ。同じなら、その駅に近い場所（同じくらいなら、チェックイン駅）を先にする
      const d = routeDistKm(p, unit);
      if (!best || rank < best.rank || (rank === best.rank && (d < best.d - 0.2 || (Math.abs(d - best.d) <= 0.2 && p.stop && !best.p.stop)))) best = { p, rank, d };
    }
    if (!best) { ng.push({ u, from: chosen && order.includes(chosen) ? chosen : null }); continue; }
    const p = best.p;
    ok.push({ u, rank: best.rank, stop: p.stop, leg: p.leg, near: p.stop || radarNearest(p.lat, p.lon, 1)[0].u, lat: p.lat, lon: p.lon, seq: p.seq });
  }
  ok.sort((a, b) => a.seq - b.seq);
  return { ok, ng };
}

// レーダーで取る駅（「廃駅も対象にする」を外したときは、未アクセスの廃駅を除く）
function radarTargets() {
  return [...routeSettings.radar.keys()].filter(u => MASTER.units[u] && (pickDone(u) || routeSettings.withClosed || !MASTER.units[u].closed));
}

// 自分で「途中で取る」にした駅（「廃駅も対象にする」を外したときは、未アクセスの廃駅を除く）
function passTargets() {
  return [...routeSettings.pass].filter(u => MASTER.units[u] && (pickDone(u) || routeSettings.withClosed || !MASTER.units[u].closed));
}

// 「途中で取れる駅には寄らない」で外してはいけない駅（レーダーを使う駅として選んだ駅、ルートビューンの2駅）
function routeKeepStops() {
  const keep = new Set();
  if (routeSettings.mode !== 'stations') return keep;
  for (const from of routeSettings.radar.values()) if (from) keep.add(from);
  for (const p of routeSettings.rv) { keep.add(p.a); keep.add(p.b); }
  return keep;
}

// 順番を出したあとの、レーダー・ルートビューン・途中で取る駅のまとめ（route.js の結果の表示と保存で使う）
//   order … 回る順番（チェックイン駅）
//   legs … 区間（自分で「途中で取る」にした駅を、いちばん近い区間に割り当てる）
// 戻り値: { radar: [{ u, rank, stop, leg, near, lat, lon }]（届く駅）, radarNg: [{ u, from }]（届かない駅）,
//          radarAt: Map(チェックイン駅 → [radar の項目]), radarLeg: Map(区間の番号 → [radar の項目]),
//          rv: [{ a, b, units, todo }], passAt: Map(区間の番号 → [{ u, km }]),
//          targets: [この遠征で取る未アクセス駅（レーダー・ルートビューン・途中で取る）] }
function routeExtras(order, legs) {
  const out = { radar: [], radarNg: [], radarAt: new Map(), radarLeg: new Map(), rv: [], passAt: new Map(), targets: [] };
  if (routeSettings.mode !== 'stations') return out;
  const checkins = [...new Set(order)];
  const targets = new Set();
  const use = planRadarUse(order, legs);
  out.radar = use.ok;
  out.radarNg = use.ng;
  for (const r of use.ok) {
    const map = r.stop ? out.radarAt : out.radarLeg;
    const key = r.stop || r.leg;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
    if (!pickDone(r.u)) targets.add(r.u);
  }
  out.rv = rvPairs().filter(p => checkins.includes(p.a) && checkins.includes(p.b));
  for (const p of out.rv) for (const u of p.todo) targets.add(u);
  const pass = passTargets().filter(u => !checkins.includes(u));
  if (legs && legs.length) {
    out.passAt = assignPassToLegs(pass, legs);   // routeplan.js
    for (const u of pass) if (!pickDone(u)) targets.add(u);
  }
  out.targets = [...targets];
  return out;
}

// ---------- 取り方を変える ----------

// その駅の、いまの取り方（'checkin' / 'radar' / 'pass' / 'rv' / null）
function roleOf(u, rvSet) {
  if (routeSettings.picked.has(u)) return 'checkin';
  if (routeSettings.radar.has(u)) return 'radar';
  if (routeSettings.pass.has(u)) return 'pass';
  if ((rvSet || rvUnitSet()).has(u)) return 'rv';
  return null;
}

// チェックイン駅から外す（その駅を使うルートビューンも外し、その駅からのレーダーは「いちばん近い駅」に戻す）
// 戻り値: 見た目が変わる駅
function removeCheckin(u) {
  const changed = [u];
  routeSettings.picked.delete(u);
  const keep = [];
  for (const p of routeSettings.rv) {
    if (p.a === u || p.b === u) changed.push(p.a, p.b, ...rvBetween(p.a, p.b).units);
    else keep.push(p);
  }
  routeSettings.rv = keep;
  for (const [t, from] of routeSettings.radar) if (from === u) routeSettings.radar.set(t, '');
  return changed;
}

function addCheckin(u) {
  routeSettings.radar.delete(u);
  routeSettings.pass.delete(u);
  routeSettings.picked.add(u);
  return [u];
}

function addRadar(u) {
  const changed = routeSettings.picked.has(u) ? removeCheckin(u) : [];
  routeSettings.pass.delete(u);
  routeSettings.radar.set(u, '');
  return [...changed, u];
}

function addPass(u) {
  const changed = routeSettings.picked.has(u) ? removeCheckin(u) : [];
  routeSettings.radar.delete(u);
  routeSettings.pass.add(u);
  return [...changed, u];
}

// 地図の印を押したとき（駅名で足したときも、ここを通る）
//   toggle … もう同じ取り方で入っていたら外す（地図）。false なら「もう入っています」と知らせる（駅名）
function pickStation(u, toggle) {
  const name = MASTER.units[u].name;
  let changed = [];
  if (pickRole === 'checkin') {
    if (routeSettings.picked.has(u)) {
      if (!toggle) { setPickMessage(`${name} は、もうチェックインする駅に入っています。`, ''); return; }
      changed = removeCheckin(u);
      setPickMessage(`${name} をチェックインする駅から外しました。`, '');
    } else {
      changed = addCheckin(u);
      setPickMessage(`${name} をチェックインする駅に入れました。`, 'good');
    }
  } else if (pickRole === 'radar') {
    if (routeSettings.radar.has(u)) {
      if (!toggle) { setPickMessage(`${name} は、もうレーダーで取る駅に入っています。`, ''); return; }
      routeSettings.radar.delete(u);
      changed = [u];
      setPickMessage(`${name} をレーダーで取る駅から外しました。`, '');
    } else {
      changed = addRadar(u);
      setPickMessage(`${name} をレーダーで取る駅に入れました。`, 'good');
    }
  } else if (pickRole === 'pass') {
    if (routeSettings.pass.has(u)) {
      if (!toggle) { setPickMessage(`${name} は、もう途中で取る駅に入っています。`, ''); return; }
      routeSettings.pass.delete(u);
      changed = [u];
      setPickMessage(`${name} を途中で取る駅から外しました。`, '');
    } else {
      changed = addPass(u);
      setPickMessage(`${name} を途中で取る駅に入れました。`, 'good');
    }
  } else {
    // ルートビューン：2駅を順に押す
    if (!rvPending) {
      rvPending = u;
      changed = addCheckin(u);
      setPickMessage(`ルートビューン：${name} を選びました。次に、もう一方の駅を押してください。`, '');
    } else if (rvPending === u) {
      rvPending = null;
      changed = [u];
      setPickMessage('ルートビューンの1つ目の駅の選択をやめました（チェックイン駅には残っています）。', '');
    } else {
      const a = rvPending;
      rvPending = null;
      const between = rvBetween(a, u);
      const aName = MASTER.units[a].name;
      if (between.lines === 0) {
        changed = [a];
        setPickMessage(`${aName} と ${name} を両方通る路線がないため、ルートビューンにできません。`, 'error');
      } else if (between.units.length === 0) {
        changed = [a];
        setPickMessage(`${aName} と ${name} の間に駅がありません（となりの駅です）。`, 'error');
      } else if (routeSettings.rv.some(p => (p.a === a && p.b === u) || (p.a === u && p.b === a))) {
        changed = [a];
        setPickMessage(`${aName}⇔${name} は、もうルートビューンに入っています。`, '');
      } else {
        changed = [a, ...addCheckin(u), ...between.units];
        routeSettings.rv.push({ a, b: u });
        const todo = between.units.filter(v => !pickDone(v)).length;
        setPickMessage(`ルートビューン：${aName}⇔${name} で ${between.units.length} 駅（うち未アクセス ${todo} 駅）を取ります。`, 'good');
      }
    }
  }
  pickChanged();
  restylePick(changed);
}

// 選んだ駅が変わったとき：一覧・路線の欄・数を描き直して、覚えておく
function pickChanged() {
  storePick();
  renderPickedList();
  renderPickLineStations();
  updateRouteCount();   // route.js
}

// ---------- 描画（route.js の renderRoute から呼ばれる） ----------

function renderRoutePick() {
  if (!appState.resolved || routeSettings.mode !== 'stations') return;
  renderPickedList();
  fillPickLines();
  renderPickLineStations();
  drawPickMap();
}

// 一覧の小さなボタン
function pickChip(u, role, onRemove) {
  const unit = MASTER.units[u];
  const b = el('button', `chip picked-chip role-${role}` + (pickDone(u) ? ' picked-done' : ''),
    `${unit.name}${unit.closed ? '（廃駅）' : ''}${pickDone(u) ? '（アクセス済み）' : ''} ✕`);
  b.type = 'button';
  b.title = `${unit.name}（${prefName(unit.pref)}）を外す`;
  b.addEventListener('click', onRemove);
  return b;
}

// 選んだ駅の一覧（チェックイン・レーダー・ルートビューン）
function renderPickedList() {
  const checkins = routeTargets();   // route.js
  const radars = radarTargets();
  const passes = passTargets();
  const pairs = rvPairs();
  const rvTodo = new Set(pairs.flatMap(p => p.todo)).size;
  const box = document.getElementById('routePickedList');
  box.replaceChildren();
  document.getElementById('routePickedCount').textContent =
    `チェックイン ${checkins.length} 駅・レーダー ${radars.length} 駅・ルートビューン ${rvTodo} 駅・途中で取る ${passes.length} 駅`;
  document.getElementById('routePickClear').hidden = routeSettings.picked.size + routeSettings.radar.size + routeSettings.pass.size === 0;
  if (checkins.length + radars.length + passes.length === 0) {
    box.append(el('p', 'muted', 'まだ選んでいません。取り方を選んでから、下の地図・駅名・路線から選んでください。'));
    return;
  }

  // チェックイン
  const g1 = el('div', 'picked-group');
  g1.append(el('div', 'picked-title role-checkin-text', `チェックインする駅（${checkins.length}）`));
  const chips1 = el('div', 'route-picked-list');
  for (const u of checkins.slice(0, PICK_SHOWN_MAX)) {
    chips1.append(pickChip(u, 'checkin', () => { const c = removeCheckin(u); pickChanged(); restylePick(c); }));
  }
  if (checkins.length > PICK_SHOWN_MAX) chips1.append(el('span', 'muted', `ほか ${checkins.length - PICK_SHOWN_MAX} 駅`));
  if (checkins.length === 0) chips1.append(el('span', 'muted', 'まだありません（レーダーやルートビューンは、チェックイン駅から使います）'));
  g1.append(chips1);
  box.append(g1);

  // レーダー（どの駅から取るかを選べる）
  if (radars.length) {
    const g2 = el('div', 'picked-group');
    g2.append(el('div', 'picked-title role-radar-text', `レーダーで取る駅（${radars.length}）`));
    const list = el('div', 'picked-radar-list');
    for (const u of radars.slice(0, PICK_SHOWN_MAX)) {
      const row = el('div', 'picked-radar-row');
      row.append(pickChip(u, 'radar', () => { routeSettings.radar.delete(u); pickChanged(); restylePick([u]); }));
      const sel = el('select', 'picked-radar-from');
      sel.setAttribute('aria-label', `${MASTER.units[u].name} をどの駅から取るか`);
      sel.append(new Option('自動（経路の中で届く場所を探す）', ''));
      for (const c of checkins) sel.append(new Option(`${MASTER.units[c].name} から`, c));
      const chosen = routeSettings.radar.get(u);
      sel.value = chosen && routeSettings.picked.has(chosen) ? chosen : '';
      sel.addEventListener('change', () => { routeSettings.radar.set(u, sel.value); storePick(); renderPickedList(); });
      row.append(sel);
      list.append(row);
    }
    if (radars.length > PICK_SHOWN_MAX) list.append(el('span', 'muted', `ほか ${radars.length - PICK_SHOWN_MAX} 駅`));
    g2.append(list);
    box.append(g2);
  }

  // ルートビューン（区間ごと）
  if (pairs.length) {
    const g3 = el('div', 'picked-group');
    g3.append(el('div', 'picked-title role-rv-text', `ルートビューン（${pairs.length} 区間）`));
    for (const p of pairs) {
      const row = el('div', 'picked-rv-row');
      const del = el('button', 'chip picked-chip role-rv', `${MASTER.units[p.a].name}⇔${MASTER.units[p.b].name} ✕`);
      del.type = 'button';
      del.title = 'このルートビューンを外す（2駅はチェックイン駅に残ります）';
      del.addEventListener('click', () => {
        routeSettings.rv = routeSettings.rv.filter(q => !(q.a === p.a && q.b === p.b));
        pickChanged();
        restylePick(p.units);
      });
      row.append(del, el('span', 'picked-rv-units', p.todo.length
        ? `未アクセス ${p.todo.length} 駅：` + p.todo.map(u => MASTER.units[u].name).join('、')
        : '間の駅はすべてアクセス済みです'));
      g3.append(row);
    }
    box.append(g3);
  }
  // 途中で取る駅
  if (passes.length) {
    const g4 = el('div', 'picked-group');
    g4.append(el('div', 'picked-title role-pass-text', `途中で取る駅（${passes.length}）`));
    const chips4 = el('div', 'route-picked-list');
    for (const u of passes.slice(0, PICK_SHOWN_MAX)) {
      chips4.append(pickChip(u, 'pass', () => { routeSettings.pass.delete(u); pickChanged(); restylePick([u]); }));
    }
    if (passes.length > PICK_SHOWN_MAX) chips4.append(el('span', 'muted', `ほか ${passes.length - PICK_SHOWN_MAX} 駅`));
    g4.append(chips4);
    box.append(g4);
  }
  const closedOut = [...routeSettings.picked, ...routeSettings.radar.keys(), ...routeSettings.pass].filter(u => !pickableAny(u) && MASTER.units[u] && MASTER.units[u].closed).length;
  if (closedOut) box.append(el('p', 'help', `「廃駅も対象にする」を外しているため、選んだ廃駅 ${closedOut} 駅は数に入れていません。`));
}

// ---------- 地図で選ぶ ----------

function pickStyle(u, rvSet) {
  const unit = MASTER.units[u];
  const role = roleOf(u, rvSet);
  if (role === 'checkin') {
    return u === rvPending
      ? { radius: 9, color: cssColor('--rv'), weight: 4, dashArray: null, fillColor: cssColor('--accent'), fillOpacity: 1 }
      : { radius: 8, color: '#ffffff', weight: 2, dashArray: null, fillColor: cssColor('--accent'), fillOpacity: 1 };
  }
  if (role === 'radar') return { radius: 7, color: '#ffffff', weight: 2, dashArray: null, fillColor: cssColor('--radar'), fillOpacity: 1 };
  if (role === 'pass') return { radius: 7, color: '#ffffff', weight: 2, dashArray: null, fillColor: cssColor('--pass'), fillOpacity: 1 };
  if (role === 'rv') return { radius: 6, color: '#ffffff', weight: 1.5, dashArray: null, fillColor: cssColor('--rv'), fillOpacity: pickDone(u) ? 0.6 : 1 };
  // アクセス済み：押して選べるよう、地図の道路にまぎれない濃さにする
  if (pickDone(u)) return { radius: 5, color: '#ffffff', weight: 1.5, dashArray: null, fillColor: cssColor('--muted'), fillOpacity: 0.9 };
  if (unit.closed) return { radius: 5, color: cssColor('--muted'), weight: 2, dashArray: '2 2', fillColor: cssColor('--surface'), fillOpacity: 0.8 };
  return { radius: 6, color: '#ffffff', weight: 1.5, dashArray: null, fillColor: cssColor('--todo'), fillOpacity: 0.95 };
}

// 地図に出す駅か
function pickShown(u, rvSet) {
  return pickable(u) || roleOf(u, rvSet) !== null || (pickDone(u) && pickShowDone);
}

function pickTooltip(u, rvSet) {
  const unit = MASTER.units[u];
  const role = roleOf(u, rvSet);
  return unit.name + (unit.closed ? '（廃駅）' : '') + (pickDone(u) ? '（アクセス済み）' : '') + (role ? `【${ROLE_NAMES[role]}】` : '');
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
  const rvSet = rvUnitSet();
  // アクセス済み → 廃駅 → 未アクセス → ルートビューン → レーダー → チェックイン の順に描き、選んだ駅が上に来るようにする
  // アクセス済みの駅は「アクセス済みの駅も地図に出す」のときだけ（選んだ駅はいつも出す）
  const units = Object.keys(MASTER.units).filter(u => pickShown(u, rvSet));
  const roleRank = { rv: 3, pass: 4, radar: 4, checkin: 5 };
  const rank = u => roleRank[roleOf(u, rvSet)] || (pickDone(u) ? 0 : MASTER.units[u].closed ? 1 : 2);
  units.sort((a, b) => rank(a) - rank(b));
  for (const u of units) {
    const unit = MASTER.units[u];
    const marker = L.circleMarker([unit.lat, unit.lon], pickStyle(u, rvSet));
    marker.bindTooltip(() => pickTooltip(u), { direction: 'top', offset: [0, -4] });
    marker.on('click', () => pickStation(u, true));
    pickLayer.addLayer(marker);
    pickMarkers.set(u, marker);
  }
  // 最初の1回だけ、選んだ駅が入るように範囲を合わせる
  if (!pickMapFitted) {
    pickMapFitted = true;
    const sel = [...routeTargets(), ...radarTargets(), ...passTargets()];
    setTimeout(() => {
      if (!pickLeafletMap) return;
      pickLeafletMap.invalidateSize();
      if (sel.length) pickLeafletMap.fitBounds(L.latLngBounds(sel.map(u => [MASTER.units[u].lat, MASTER.units[u].lon])), { padding: [24, 24], maxZoom: 12 });
    }, 100);
  }
}

// 見た目が変わった駅だけ、印を描き直す（出す・消すが変わるときは、地図全体を描き直す）
function restylePick(units) {
  if (!pickLeafletMap) return;
  const rvSet = rvUnitSet();
  for (const u of new Set(units)) {
    const m = pickMarkers.get(u);
    if (!!m !== pickShown(u, rvSet)) { drawPickMap(); return; }
    if (!m) continue;
    m.setStyle(pickStyle(u, rvSet));
    if (roleOf(u, rvSet)) m.bringToFront();
  }
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
  const roleName = ROLE_NAMES[pickRole];
  const add = u => {
    pickStation(u, false);   // いま選んでいる取り方で入れる（結果は取り方の欄の下に出る）
    say(`${MASTER.units[u].name}（${prefName(MASTER.units[u].pref)}${pickDone(u) ? '・アクセス済み' : ''}）を「${roleName}」で選びました。`, 'good');
    input.value = '';
    choices.replaceChildren();
  };
  if (ok.length === 1) { add(ok[0]); return; }
  // 同じ名前の駅がいくつかあるときは、選んでもらう
  say(`「${text}」は ${ok.length} 駅あります。選ぶ駅を押してください。`, '');
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

// 路線の選択肢（すべての路線。絞り込みの文字があれば、その文字を含む路線だけ）
function fillPickLines() {
  const select = document.getElementById('routePickLine');
  const word = document.getElementById('routePickLineSearch').value.trim();
  const byCd = pickLineStats();
  const lines = [];
  for (const [cd, line] of Object.entries(MASTER.lines)) {
    if (word && !line.name.includes(word)) continue;
    const s = byCd[cd];
    if (!s) continue;
    lines.push({ cd, name: line.name, n: s.remaining.filter(pickable).length, total: s.stations.length });
  }
  lines.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  select.replaceChildren(new Option(lines.length ? `路線を選んでください（${lines.length} 路線）` : '当てはまる路線がありません', ''));
  for (const l of lines) select.append(new Option(`${l.name}（全 ${l.total} 駅・${l.n ? '残り ' + l.n : 'コンプ'}）`, l.cd));
  // 絞り込みで1つに決まったら、その路線を選ぶ
  if (word && lines.length === 1) pickLineCd = lines[0].cd;
  select.value = lines.some(l => l.cd === pickLineCd) ? pickLineCd : '';
  if (select.value !== pickLineCd) { pickLineCd = select.value; }
  renderPickLineStations();
}

// 路線の一覧では、いまの取り方で入れる（ルートビューンを選んでいるときは、チェックインで入れる）
function lineRole() {
  return pickRole === 'rv' ? 'checkin' : pickRole;
}

function setLineStation(u, on) {
  if (!on) {
    const changed = routeSettings.picked.has(u) ? removeCheckin(u) : [u];
    routeSettings.radar.delete(u);
    routeSettings.pass.delete(u);
    return changed;
  }
  const role = lineRole();
  return role === 'radar' ? addRadar(u) : role === 'pass' ? addPass(u) : addCheckin(u);
}

function renderPickLineStations() {
  const box = document.getElementById('routePickLineStations');
  box.replaceChildren();
  if (!pickLineCd || !appState.resolved) return;
  const s = pickLineStats()[pickLineCd];
  if (!s) return;
  // 路線の全駅（路線の並び順）。アクセス済みの駅も選べる（未アクセスの廃駅は「廃駅も対象にする」のときだけ）
  const units = s.stations.filter(pickableAny);
  const todo = units.filter(pickable);
  if (units.length === 0) { box.append(el('p', 'muted', 'この路線に選べる駅はありません。')); return; }

  const roleName = ROLE_NAMES[lineRole()];
  if (pickRole === 'rv') box.append(el('p', 'help', 'ルートビューンは、地図か駅名で2駅を順に選んでください。この一覧では「チェックイン」で入ります。'));
  box.append(el('p', 'help', `全 ${units.length} 駅（うち未アクセス ${todo.length} 駅）。チェックを入れた駅が「${roleName}」で入ります。` +
    (routeSettings.autoPass ? '「乗っている途中で取れる駅には寄らない」がオンなので、全駅を選んでも、途中で取れる駅には寄らない順番になります。' : '')));
  const buttons = el('div', 'buttons');
  const allOn = el('button', '', `全 ${units.length} 駅を選ぶ`);
  allOn.type = 'button';
  allOn.addEventListener('click', () => { const c = units.flatMap(u => setLineStation(u, true)); pickChanged(); restylePick(c); });
  buttons.append(allOn);
  if (todo.length && todo.length < units.length) {
    const todoOn = el('button', '', `未アクセスの ${todo.length} 駅だけ選ぶ`);
    todoOn.type = 'button';
    todoOn.addEventListener('click', () => { const c = todo.flatMap(u => setLineStation(u, true)); pickChanged(); restylePick(c); });
    buttons.append(todoOn);
  }
  const allOff = el('button', '', 'この路線の駅をすべて外す');
  allOff.type = 'button';
  allOff.addEventListener('click', () => { const c = units.flatMap(u => setLineStation(u, false)); pickChanged(); restylePick(c); });
  buttons.append(allOff);
  box.append(buttons);

  const rvSet = rvUnitSet();
  const list = el('div', 'route-pick-stations');
  for (const u of units) {
    const unit = MASTER.units[u];
    const role = roleOf(u, rvSet);
    const label = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = role === 'checkin' || role === 'radar' || role === 'pass';
    cb.addEventListener('change', () => { const c = setLineStation(u, cb.checked); pickChanged(); restylePick(c); });
    if (pickDone(u)) label.classList.add('pick-line-done');
    label.append(cb, ` ${unit.name}${unit.closed ? '（廃駅）' : ''}${pickDone(u) ? '✓' : ''}`);
    if (role) label.append(' ', el('span', `role-tag role-${role}`, ROLE_NAMES[role]));
    list.append(label);
  }
  box.append(list);
}
