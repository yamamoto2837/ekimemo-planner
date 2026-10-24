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
  picked: new Set(),  // 駅を選ぶときの、チェックインする駅（駅メモの駅の番号）。回る順番はこの駅で考える
  radar: new Map(),   // レーダーで取る駅 → どのチェックイン駅から取るか（'' なら、いちばん近い駅）
  rv: [],             // ルートビューン：[{ a, b }]（2つのチェックイン駅の間の駅を取る）
  pass: new Set(),    // 自分で「途中で取る」にした駅（寄らずに、乗っている途中で取る）
  autoPass: true,     // 乗っている途中で取れる駅には寄らない（自動で調べる）
  radarN: 10,         // レーダーで取れる駅の数（いる場所から近い順に何駅まで取れるか）
  splitTransfers: true, // 立ち寄る駅を、乗換駅・折り返す駅にまとめる
  prefs: new Set(),   // 選んだ都道府県
  round: false,       // 出発駅に戻ってくるか
  withClosed: true,   // 廃駅も対象にする（駅メモでは廃駅も、近くに行けば取れる）
};
let routeLeafletMap = null;
let routeLayerGroup = null;
let routeMapDiv = null;   // 順番の結果の地図の入れ物（使い回す）

// ---------- 準備（app.js から呼ばれる） ----------

function initRouteScreen() {
  document.getElementById('routeRun').addEventListener('click', runRoute);
  document.getElementById('routeRound').addEventListener('change', e => { routeSettings.round = e.target.checked; });
  const closedBox = document.getElementById('routeClosed');
  closedBox.checked = routeSettings.withClosed;
  closedBox.addEventListener('change', e => { routeSettings.withClosed = e.target.checked; renderRoutePrefs(); renderRoutePick(); });
  document.getElementById('routeStartForm').addEventListener('submit', e => { e.preventDefault(); runRoute(); });
  document.getElementById('routeClearPrefs').addEventListener('click', () => { routeSettings.prefs.clear(); renderRoutePrefs(); });
  initRoutePick();   // routepick.js（駅を1つずつ選ぶ欄。覚えていた設定もここで戻る）
  const autoPass = document.getElementById('routeAutoPass');
  autoPass.checked = routeSettings.autoPass;
  autoPass.addEventListener('change', () => { routeSettings.autoPass = autoPass.checked; storePick(); });
  const split = document.getElementById('routeSplitTransfers');
  split.checked = routeSettings.splitTransfers;
  split.addEventListener('change', () => { routeSettings.splitTransfers = split.checked; storePick(); });
  const radarN = document.getElementById('routeRadarN');
  radarN.value = routeSettings.radarN;
  radarN.addEventListener('change', () => {
    routeSettings.radarN = clampInt(radarN.value, 1, 50, 10);   // radar.js
    radarN.value = routeSettings.radarN;
    storePick();
  });
}

// 回る駅の一覧
//   駅を選ぶとき … 選んだ駅（アクセス済みの駅も選べる。「廃駅も対象にする」を外したときは、未アクセスの廃駅を除く）
//   都道府県で選ぶとき … 選んだ都道府県の未アクセス駅（「廃駅も対象にする」なら廃駅も）
function routeTargets() {
  if (!appState.resolved) return [];
  if (routeSettings.mode === 'stations') {
    const accessed = appState.resolved.accessed;
    return [...routeSettings.picked].filter(u => MASTER.units[u] &&
      (accessed.has(u) || routeSettings.withClosed || !MASTER.units[u].closed));
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
      // 乗っている途中で取れる駅には寄らない（出発駅・レーダーを使う駅・ルートビューンの2駅は残す）
      const keep = routeKeepStops();   // routepick.js
      if (start.unit) keep.add(start.unit);
      if (routeSettings.autoPass) {
        plan = dropPassStops(plan, keep, routeSettings.round);   // routeplan.js
      } else {
        plan.dropped = [];
      }
      // 立ち寄る駅を、乗換駅・折り返す駅に置き直す（道すじは変えない）
      // 「寄らない」がオフのときは、選んだ駅にも立ち寄る
      if (routeSettings.splitTransfers) {
        const keep2 = routeSettings.autoPass ? keep : new Set([...keep, ...plan.order]);
        const before = plan.dropped;
        plan = splitAtTransfers(plan, keep2);   // routeplan.js
        plan.dropped = [...new Set([...before, ...plan.removed.filter(u => targets.includes(u))])];
      }
      addLegPass(plan.legs);   // routeplan.js（区間ごとの、途中で取れる駅）
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

  // 回る駅の数（出発駅も対象なら数に入れる）
  const visitCount = new Set(plan.order.filter(u => targetSet.has(u))).size;
  // レーダー・ルートビューン・途中で取る駅（routepick.js。都道府県で選ぶときは空）
  const extras = routeExtras(plan.order, plan.legs);
  const accessed = appState.resolved.accessed;
  const dropped = new Set(plan.dropped || []);
  // 区間の途中で取れる駅のうち、表示する駅（選んだ駅か、未アクセスの駅）
  const legPassShown = leg => (leg.pass || []).filter(u => targetSet.has(u) || !accessed.has(u));
  const passTodo = new Set(plan.legs.flatMap(l => legPassShown(l)).filter(u => !accessed.has(u)));
  const head = el('div', 'panel');
  head.append(el('h3', '', routeSettings.mode === 'stations' ? `${visitCount} 駅にチェックインする順番` : `${visitCount} 駅を回る順番`));
  head.append(el('p', 'detail-count', `線路に沿った距離 約 ${Math.round(plan.totalKm)} km`));
  head.append(el('p', 'plan-line-summary', routeLineSummary(plan)));   // routeplan.js（路線ごとにまとめた書き方）
  if (dropped.size) {
    head.append(el('p', 'help', `乗っている途中で取れるため、次の ${dropped.size} 駅には寄らない順番にしました（「途中で取る」として区間に並べています）：${[...dropped].map(u => MASTER.units[u].name).join('、')}`));
  }
  if (routeSettings.mode === 'stations') {
    const ciTodo = new Set(plan.order.filter(u => !accessed.has(u))).size;
    const radarTodo = extras.radar.filter(r => !accessed.has(r.u)).length;
    const rvTodo = new Set(extras.rv.flatMap(p => p.todo)).size;
    const manualPass = [...extras.passAt.values()].flat().map(p => p.u).filter(u => !accessed.has(u));
    const passAll = new Set([...passTodo, ...manualPass]);
    const all = new Set([...plan.order.filter(u => !accessed.has(u)), ...extras.targets, ...passAll]);
    head.append(el('p', 'route-take',
      `この遠征で取れる未アクセス駅：チェックイン ${ciTodo}・レーダー ${radarTodo}・ルートビューン ${rvTodo}・途中で取る ${passAll.size}（合計 ${all.size} 駅）`));
    // レーダーで届かない駅
    if (extras.radarNg.length) {
      head.append(el('p', 'notice', `レーダー ${routeSettings.radarN} 駅では届かないため、次の駅は取れません（使う駅を決めた駅は、その駅から届きません）：` +
        extras.radarNg.map(r => MASTER.units[r.u].name + (r.from ? `（${MASTER.units[r.from].name} から）` : '')).join('、') +
        '。レーダーの駅数を増やすか、チェックインする駅や「途中で取る」に変えてください。'));
    }
    // ルートビューンの2駅が、順番の中で続いていないとき
    const apart = extras.rv.filter(p => !routeAdjacent(plan.order, p.a, p.b));
    if (apart.length) {
      head.append(el('p', 'notice', `ルートビューンの ${apart.map(p => `${MASTER.units[p.a].name}⇔${MASTER.units[p.b].name}`).join('、')} は、順番の中で2駅が続いていません。間に別の駅へ寄る順番になっています。`));
    }
  } else if (passTodo.size) {
    head.append(el('p', 'route-take', `乗っている途中で取れる未アクセス駅：${passTodo.size} 駅`));
  }
  if (passTodo.size || dropped.size) {
    head.append(el('p', 'help', '「途中で取る」は、駅と駅を直線で結んだ線の近くで、いちばん近い駅になる駅です。線路が大きく曲がっている所では、実際とずれることがあります。'));
  }
  head.append(el('p', 'help', '乗り換え時間や運行本数は考えていません。机の上で計画を立てるための目安です。'));
  if (plan.guessed.length > 0) {
    head.append(el('p', 'notice', `線路のデータが無い駅（新幹線だけの駅や廃駅など）を含むため、${plan.guessed.length} 駅の前後は、近くの駅から直線で推定しています。`));
  }
  if (plan.unreachable.length > 0) {
    head.append(el('p', 'notice', `線路でつながっていないため、次の駅は順番に入れていません: ${plan.unreachable.map(u => MASTER.units[u] ? MASTER.units[u].name : u).join('、')}`));
  }
  box.append(head);

  // このルートで埋まる駅（gain.js）：立ち寄る駅・途中で取る駅・レーダー・ルートビューン
  const gainUnits = [
    ...plan.order, ...dropped, ...extras.targets,
    ...plan.legs.flatMap(l => l.pass || []),
    ...[...extras.passAt.values()].flat().map(p => p.u),
  ];
  const gainPanel = el('div', 'panel');
  gainPanel.append(gainView(gainUnits));
  box.append(gainPanel);

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
      const id = await addPlanFromRoute(name, dateInput.value, plan, startUnit, routeSettings.round, targetSet, extras);
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

  // 地図（地図の入れ物は使い回す。作り直すと、地図の部品が描きかけのままエラーになることがあるため）
  const mapPanel = el('div', 'panel');
  if (!routeMapDiv) {
    routeMapDiv = el('div', 'route-map');
    routeMapDiv.id = 'routeMapView';
  }
  mapPanel.append(routeMapDiv);
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
    if (appState.resolved.accessed.has(u)) headRow.append(el('span', 'plan-check', '✓ アクセス済み'));
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
      // この区間でルートビューンを使うとき
      for (const p of extras.rv) {
        if (!((p.a === plan.order[i - 1] && p.b === u) || (p.b === plan.order[i - 1] && p.a === u))) continue;
        rides.append(routeExtraLine('rv', `ルートビューン（${MASTER.units[p.a].name}⇔${MASTER.units[p.b].name}）`, p.units, accessed));
      }
      // この区間に乗っている途中で取れる駅（自動）と、自分で「途中で取る」にした駅
      const auto = legPassShown(leg);
      if (auto.length) rides.append(routeExtraLine('pass', '途中で取る', auto, accessed, dropped));
      // この区間に乗っている途中で使うレーダー
      if (extras.radarLeg.has(i - 1)) radarExtraLines(extras.radarLeg.get(i - 1), accessed, u2 => MASTER.units[u2].name, false).forEach(x => rides.append(x));
      const mine = extras.passAt.get(i - 1) || [];
      if (mine.length) {
        const line = routeExtraLine('pass', '途中で取る（指定）', mine.map(p => p.u), accessed);
        const far = mine.filter(p => p.km > 2);
        if (far.length) line.append(el('span', 'muted', `（線路から離れた駅：${far.map(p => `${MASTER.units[p.u].name} 約 ${p.km.toFixed(1)} km`).join('、')}）`));
        rides.append(line);
      }
      li.append(rides);
    }
    // この駅からレーダーで取る駅（戻ってきた出発駅では出さない）
    if (!isReturn && extras.radarAt.has(u)) radarExtraLines(extras.radarAt.get(u), accessed, u2 => MASTER.units[u2].name, true).forEach(x => li.append(x));
    const memo = memoView(stationMemo(u));
    if (memo) li.append(memo);
    list.append(li);
  });
  box.append(list);

  drawRouteMap(plan, startUnit, extras);
}

// 順番の中で、2駅がとなり合っているか（出発駅に戻るときは、最後と最初もとなり）
function routeAdjacent(order, a, b) {
  for (let i = 0; i + 1 < order.length; i++) {
    if ((order[i] === a && order[i + 1] === b) || (order[i] === b && order[i + 1] === a)) return true;
  }
  return false;
}

// レーダーで取る駅を、使う場所ごとに「レーダー（有田付近で使う）：三代橋 3駅目、黒川 5駅目」の行にする
//   items … [{ u, rank, near }]、nameOf … 駅の番号 → 駅名、atStop … チェックイン駅で使うか
function radarExtraLines(items, accessed, nameOf, atStop) {
  const groups = new Map();
  for (const r of items) {
    if (!groups.has(r.near)) groups.set(r.near, []);
    groups.get(r.near).push(r);
  }
  const lines = [];
  for (const [near, list] of groups) {
    list.sort((a, b) => a.rank - b.rank);
    const line = el('div', 'route-extra route-extra-radar');
    line.append(el('b', '', `レーダー（${nameOf(near)}${atStop ? '' : ' 付近'}で使う・${list[list.length - 1].rank} 駅分）：`));
    list.forEach((r, k) => {
      if (k > 0) line.append('、');
      const done = accessed.has(r.u);
      line.append(el('span', done ? 'route-extra-done' : '', nameOf(r.u) + (done ? '✓' : '')), el('small', 'muted', ` ${r.rank}駅目`));
    });
    lines.push(line);
  }
  return lines;
}

// 「レーダー：A、B✓」のような1行（kind は 'radar'・'rv'・'pass'。アクセス済みの駅には ✓ を付ける）
//   strong … 太字にする駅（選んだのに寄らないことにした駅）
function routeExtraLine(kind, title, units, accessed, strong) {
  const line = el('div', 'route-extra route-extra-' + kind);
  line.append(el('b', '', `${title}：`));
  units.forEach((u, k) => {
    if (k > 0) line.append('、');
    const done = accessed.has(u);
    const cls = [done ? 'route-extra-done' : '', strong && strong.has(u) ? 'route-extra-picked' : ''].join(' ').trim();
    line.append(el('span', cls, MASTER.units[u].name + (done ? '✓' : '')));
  });
  return line;
}

// 地図に、番号と通る道すじを描く
function drawRouteMap(plan, startUnit, extras) {
  if (!window.L) {
    document.getElementById('routeMapView').replaceChildren(el('p', 'message error map-error', '地図の部品を読み込めませんでした。'));
    return;
  }
  // 地図は1回だけ作り、2回目からは描いた印を消して描き直す
  if (!routeLeafletMap) {
    routeLeafletMap = L.map(routeMapDiv, { preferCanvas: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(routeLeafletMap);
    routeLayerGroup = L.layerGroup().addTo(routeLeafletMap);
  } else {
    routeLayerGroup.clearLayers();
  }

  // 道すじ（通る駅を順につなぐ）
  const pts = [];
  for (const leg of plan.legs) for (const r of leg.rides) for (const u of r.path) {
    const unit = MASTER.units[u];
    pts.push([unit.lat, unit.lon]);
  }
  if (pts.length > 1) L.polyline(pts, { color: cssColor('--accent'), weight: 3, opacity: 0.7 }).addTo(routeLayerGroup);

  // ルートビューン（緑）とレーダー（紫。取るチェックイン駅と点線で結ぶ）で取る駅
  if (extras) {
    for (const p of extras.rv) for (const u of p.units) {
      const unit = MASTER.units[u];
      L.circleMarker([unit.lat, unit.lon], { radius: 5, color: '#ffffff', weight: 1.5, fillColor: cssColor('--rv'), fillOpacity: 0.95 })
        .bindTooltip(`${unit.name}（ルートビューン）`).addTo(routeLayerGroup);
    }
    for (const r of extras.radar) {
      const unit = MASTER.units[r.u];
      L.polyline([[r.lat, r.lon], [unit.lat, unit.lon]], { color: cssColor('--radar'), weight: 1.5, dashArray: '4 4', opacity: 0.8 }).addTo(routeLayerGroup);
      L.circleMarker([unit.lat, unit.lon], { radius: 6, color: '#ffffff', weight: 1.5, fillColor: cssColor('--radar'), fillOpacity: 0.95 })
        .bindTooltip(`${unit.name}（${MASTER.units[r.near].name}${r.stop ? '' : '付近'}でレーダー・${r.rank}駅目）`).addTo(routeLayerGroup);
    }
    // 届かない駅（灰色の点線の輪）
    for (const r of extras.radarNg) {
      const unit = MASTER.units[r.u];
      L.circleMarker([unit.lat, unit.lon], { radius: 6, color: cssColor('--radar'), weight: 2, dashArray: '2 2', fillColor: cssColor('--surface'), fillOpacity: 0.8 })
        .bindTooltip(`${unit.name}（レーダーが届きません）`).addTo(routeLayerGroup);
    }
  }
  // 途中で取る駅（オレンジ）：寄らないことにした駅と、自分で「途中で取る」にした駅
  const passUnits = new Set([...(plan.dropped || []), ...(extras ? [...extras.passAt.values()].flat().map(p => p.u) : [])]);
  for (const u of passUnits) {
    const unit = MASTER.units[u];
    L.circleMarker([unit.lat, unit.lon], { radius: 6, color: '#ffffff', weight: 1.5, fillColor: cssColor('--pass'), fillOpacity: 0.95 })
      .bindTooltip(`${unit.name}（途中で取る）`).addTo(routeLayerGroup);
  }

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
