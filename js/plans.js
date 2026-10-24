// ============================================================
// 遠征プランの保存（F8）
//
// 巡回ルートで出した順番を「プラン」として、日付つきで保存する。
// 遠征のあとは、各駅がアクセス済みになったかを見て、結果を記録できる。
//
// 保存はブラウザの中（IndexedDB の 'plans'）。共有（sync.js）でほかのデバイスともそろえる。
// メモと同じく、1件ごとに更新日時を持ち、消したプランも「消した」という印を残す。
//
// 中身の形:
// { version: 1, updatedAt: '日時',
//   plans: { プランの番号: {
//     id, name, date: 'YYYY-MM-DD', createdAt, updatedAt, deleted?,
//     round: 出発駅に戻るか, start: 出発駅,
//     stops: [{ u: 駅メモの駅の番号, name: 駅名, pref }],     ← 回る順番
//     legs:  [{ km, rides: [{ line: 路線名, from: 駅名, to: 駅名 }] }],  ← 区間ごとの乗り方
//     totalKm, note: 'メモ',
//     result: { recordedAt, visited: [駅], missed: [駅] } } } }
// ============================================================

const PLAN_KEY = 'plans';
const PLAN_NOTE_DELAY = 800;

let planData = emptyPlanData();
let planNoteTimer = null;
let openPlanId = null;   // 開いているプラン

function emptyPlanData() {
  return { version: 1, updatedAt: null, plans: {} };
}

// ---------- 読み込み・保存 ----------

async function loadPlans() {
  try {
    const saved = await loadValue(PLAN_KEY);
    if (saved && saved.version === 1) planData = saved;
  } catch (e) {
    console.warn('プランを読めませんでした', e);
  }
}

function getPlanData() {
  return planData;
}

// ほかのデバイスとまとめた中身に入れ替える（sync.js から）
async function replacePlanData(data) {
  planData = data;
  await saveValue(PLAN_KEY, planData);
  const editing = document.activeElement && document.activeElement.classList.contains('plan-note');
  if (!editing) renderPlans();
}

// 書き換えた日時を付ける（時計がずれていても、前の日時より必ず新しくする）
function touchPlan(plan) {
  const old = Date.parse(plan.updatedAt) || 0;
  plan.updatedAt = new Date(Math.max(Date.now(), old + 1)).toISOString();
  if (!planData.updatedAt || plan.updatedAt > planData.updatedAt) planData.updatedAt = plan.updatedAt;
}

async function storePlans() {
  await saveValue(PLAN_KEY, planData);
  if (typeof scheduleSync === 'function') scheduleSync();   // sync.js
}

function newPlanId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function todayText() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- プランを作る・直す・消す ----------

// 巡回ルートの結果（routeplan.js の planRoute の戻り値）から、プランを作って保存する
// targets … 回る対象の駅（出発駅がもともとアクセス済みなら入らない）
// extras … レーダー・ルートビューンで取る駅（routepick.js の routeExtras。無ければ省略）
async function addPlanFromRoute(name, date, route, startUnit, round, targets, extras) {
  const accessedNow = appState.resolved ? appState.resolved.accessed : new Set();
  const lineLabel = lc => lc === 'transfer' ? '乗り換え' : lc === 'guess' ? '線路データ無し（推定）' : String(lc).startsWith('closed:') ? lineName(lc) : (MASTER.lines[lc] ? MASTER.lines[lc].name : lc);
  const plan = {
    id: newPlanId(),
    name,
    date,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    round,
    start: startUnit || null,
    stops: route.order.map(u => ({ u, name: MASTER.units[u].name, pref: MASTER.units[u].pref })),
    // 回る対象：チェックインする駅、寄らないことにした駅、レーダー・ルートビューン・途中で取る未アクセス駅
    targets: [...new Set([...route.order.filter(u => targets.has(u)), ...(route.dropped || []), ...(extras ? extras.targets : [])])],
    // 選んだけれど、乗っている途中で取れるので寄らないことにした駅
    dropped: route.dropped || [],
    // レーダーで取る駅（from … どのチェックイン駅から取るか）
    radar: extras ? [...extras.radarFromOf].map(([u, from]) => ({ u, from })) : [],
    // ルートビューン（a・b … 2つのチェックイン駅、units … 間の駅）
    rv: extras ? extras.rv.map(p => ({ a: p.a, b: p.b, units: p.units })) : [],
    legs: route.legs.map((l, i) => ({
      km: Math.round(l.km * 10) / 10,
      rides: l.rides.map(r => ({ line: lineLabel(r.line), from: MASTER.units[r.from].name, to: MASTER.units[r.to].name })),
      // 途中で取れる駅（選んだ駅か、保存したときに未アクセスの駅だけ）
      pass: (l.pass || []).filter(u => targets.has(u) || !accessedNow.has(u)),
      // 自分で「途中で取る」にした駅
      mine: extras && extras.passAt.has(i) ? extras.passAt.get(i).map(p => p.u) : [],
    })),
    totalKm: Math.round(route.totalKm),
    note: '',
    result: null,
  };
  touchPlan(plan);
  planData.plans[plan.id] = plan;
  await storePlans();
  renderPlans();
  return plan.id;
}

// 自分で決めた順番のルート（routeplan.js の planFixedRoute の戻り値）から、プランを作って保存する
// 回る対象は、通る駅のうち、いま未アクセスの駅（途中の駅も含む）
async function addPlanFromMyRoute(name, date, route, note) {
  const accessed = appState.resolved ? appState.resolved.accessed : new Set();
  const plan = {
    id: newPlanId(),
    kind: 'manual',   // 自分で作ったルート
    name,
    date,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    round: false,
    start: route.order[0],
    stops: route.order.map(u => ({ u, name: MASTER.units[u].name, pref: MASTER.units[u].pref })),
    targets: route.passed.filter(u => !accessed.has(u)),
    legs: route.legs.map(l => ({
      km: Math.round(l.km * 10) / 10,
      rides: l.rides.map(r => ({ line: lineName(r.line), from: MASTER.units[r.from].name, to: MASTER.units[r.to].name })),
      // 途中で通る駅（区間の両はしの駅は除く）
      via: [...new Set(l.rides.flatMap(r => r.path))].filter(u => u !== l.from && u !== l.to),
    })),
    totalKm: Math.round(route.totalKm),
    note: note || '',
    result: null,
  };
  touchPlan(plan);
  planData.plans[plan.id] = plan;
  await storePlans();
  renderPlans();
  return plan.id;
}

// 消す（ほかのデバイスにも伝わるよう、「消した」という印だけ残す）
async function deletePlan(id) {
  const old = planData.plans[id];
  if (!old) return;
  const plan = { id, deleted: true, updatedAt: old.updatedAt };
  touchPlan(plan);
  planData.plans[id] = plan;
  await storePlans();
  renderPlans();
}

// 結果を記録する：今アクセス済みの駅を「回れた駅」とする
async function recordPlanResult(id) {
  const plan = planData.plans[id];
  if (!plan || !appState.resolved) return;
  const accessed = appState.resolved.accessed;
  const units = planTargets(plan);
  plan.result = {
    recordedAt: new Date().toISOString(),
    visited: units.filter(u => accessed.has(u)),
    missed: units.filter(u => !accessed.has(u)),
  };
  touchPlan(plan);
  await storePlans();
  renderPlans();
}

// 回る対象の駅（古い形のプランなら、並びの駅すべて）
function planTargets(plan) {
  return plan.targets || [...new Set(plan.stops.map(s => s.u))];
}

// 駅の番号を駅名にする（駅マスタに無ければ、保存したときの駅名。それも無ければ番号のまま）
function planStationName(plan, u) {
  if (MASTER.units[u]) return MASTER.units[u].name;
  const stop = plan.stops.find(s => s.u === u);
  return stop ? stop.name : String(u);
}

// 「レーダー：A、B✓」のような1行（アクセス済みの駅には ✓ を付ける）
//   strong … 太字にする駅（選んだのに寄らないことにした駅）
function planExtraLine(kind, title, units, accessed, plan, strong) {
  const line = el('div', 'route-extra route-extra-' + kind);
  line.append(el('b', '', `${title}：`));
  units.forEach((u, k) => {
    if (k > 0) line.append('、');
    const done = accessed.has(u);
    const cls = [done ? 'route-extra-done' : '', strong && strong.has(u) ? 'route-extra-picked' : ''].join(' ').trim();
    line.append(el('span', cls, planStationName(plan, u) + (done ? '✓' : '')));
  });
  return line;
}

function setPlanNote(id, text, status) {
  const plan = planData.plans[id];
  if (!plan || plan.note === text) return;
  plan.note = text;
  touchPlan(plan);
  status.textContent = '保存中…';
  clearTimeout(planNoteTimer);
  planNoteTimer = setTimeout(async () => {
    try { await storePlans(); status.textContent = '保存しました'; }
    catch (e) { status.textContent = '保存できませんでした'; }
  }, PLAN_NOTE_DELAY);
}

// ---------- 画面（遠征プラン） ----------

function initPlansScreen() { /* いまは準備することなし（描画は renderPlans） */ }

// アドレス（#plans/プランの番号）から開くプランを決める
function selectPlan(id) {
  openPlanId = id || null;
  renderPlans();
}

function activePlans() {
  return Object.values(planData.plans).filter(p => !p.deleted);
}

function renderPlans() {
  const box = document.getElementById('planList');
  if (!box) return;
  box.replaceChildren();
  const plans = activePlans();
  if (plans.length === 0) {
    box.append(el('p', 'panel muted', 'まだプランはありません。「巡回ルート」で順番を考えたあと、「プランとして保存」を押すと、ここに並びます。'));
    return;
  }
  const today = todayText();
  const upcoming = plans.filter(p => p.date >= today).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const past = plans.filter(p => p.date < today).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  if (upcoming.length) { box.append(el('h3', 'plan-section', `これからの遠征（${upcoming.length}）`)); upcoming.forEach(p => box.append(planCard(p))); }
  if (past.length) { box.append(el('h3', 'plan-section', `終わった遠征（${past.length}）`)); past.forEach(p => box.append(planCard(p))); }
}

function formatPlanDate(text) {
  const [y, m, d] = text.split('-').map(Number);
  const w = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${y}/${m}/${d}（${w}）`;
}

// プラン1件分
function planCard(plan) {
  const accessed = appState.resolved ? appState.resolved.accessed : new Set();
  const units = planTargets(plan);
  const done = units.filter(u => accessed.has(u)).length;

  const card = el('details', 'panel plan-card');
  card.open = openPlanId === plan.id;
  card.addEventListener('toggle', () => {
    if (card.open) openPlanId = plan.id;
    else if (openPlanId === plan.id) openPlanId = null;
  });

  const summary = el('summary', 'plan-summary');
  summary.append(
    el('span', 'plan-date', formatPlanDate(plan.date)),
    el('span', 'plan-name', plan.name),
  );
  if (plan.kind === 'manual') summary.append(el('span', 'tag', '自分で作ったルート'));
  summary.append(el('span', 'plan-nums', plan.kind === 'manual'
    ? `立ち寄り ${plan.stops.length} 駅・約 ${plan.totalKm} km・通る未アクセス駅 ${units.length} のうち ${done} 駅アクセス済み`
    : `${units.length} 駅・約 ${plan.totalKm} km・アクセス済み ${done}/${units.length}`));
  card.append(summary);

  // 結果
  if (plan.result) {
    const r = plan.result;
    const when = new Date(r.recordedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const res = el('div', 'plan-result');
    res.append(el('b', '', `結果（${when} に記録）：回れた駅 ${r.visited.length} ／ 回れなかった駅 ${r.missed.length}`));
    if (r.missed.length) {
      res.append(el('div', 'help', '回れなかった駅: ' + r.missed.map(u => planStationName(plan, u)).join('、')));
    }
    card.append(res);
  }

  // ボタン
  const buttons = el('div', 'buttons');
  const recordBtn = el('button', 'primary', plan.result ? '結果を記録し直す' : '結果を記録する');
  recordBtn.type = 'button';
  recordBtn.disabled = !appState.resolved;
  recordBtn.addEventListener('click', () => recordPlanResult(plan.id));
  const delBtn = el('button', '', 'このプランを消す');
  delBtn.type = 'button';
  delBtn.addEventListener('click', () => {
    if (confirm(`「${plan.name}」を消しますか？（ほかのデバイスからも消えます）`)) deletePlan(plan.id);
  });
  buttons.append(recordBtn, delBtn);
  card.append(buttons);
  card.append(el('p', 'help', '遠征のあとに駅メモマップ2のエクスポートを取り込んでから「結果を記録する」を押すと、回れた駅・回れなかった駅が記録されます。'));

  // メモ
  const noteLabel = el('label', 'memo-label');
  const status = el('span', 'memo-status');
  noteLabel.append(el('span', '', 'このプランのメモ'), status);
  const note = el('textarea', 'memo-text plan-note');
  note.rows = 2;
  note.maxLength = 4000;
  note.placeholder = '例: 雨で後半を断念。次回は朝一番から';
  note.value = plan.note || '';
  note.addEventListener('input', () => setPlanNote(plan.id, note.value, status));
  noteLabel.append(note);
  card.append(noteLabel);

  // 回る順番（今アクセス済みかの印つき）
  const list = el('ol', 'route-list plan-stops');
  plan.stops.forEach((s, i) => {
    const li = el('li', 'route-stop' + (accessed.has(s.u) ? ' plan-done' : ''));
    const head = el('div', 'route-stop-head');
    const isStart = i === 0 && plan.start === s.u;
    const isReturn = (plan.round || plan.kind === 'manual') && i === plan.stops.length - 1 && i > 0;
    head.append(
      el('span', 'route-num', isStart ? '出発' : isReturn ? '到着' : String(plan.start ? i : i + 1)),
      el('span', 'route-name', s.name),
      el('small', 'muted', `（${prefName(s.pref)}）`),
    );
    if (accessed.has(s.u) && units.includes(s.u)) head.append(el('span', 'plan-check', '✓ アクセス済み'));
    li.append(head);
    const leg = plan.legs[i - 1];
    if (leg) {
      const rides = el('div', 'route-rides');
      rides.append(el('span', 'route-km', `約 ${leg.km} km`));
      leg.rides.forEach(r => rides.append(el('div', 'route-ride', r.line === '乗り換え' ? `乗り換え（${r.from}→${r.to}）` : `${r.line}：${r.from}→${r.to}`)));
      // 途中で通る、回る対象の駅（自分で作ったルート）
      const viaTargets = (leg.via || []).filter(u => units.includes(u) && MASTER.units[u]);
      if (viaTargets.length) {
        const via = el('div', 'plan-via');
        via.append(el('span', '', `途中の未アクセスだった駅 ${viaTargets.length}：`));
        viaTargets.forEach((u, k) => {
          if (k > 0) via.append('、');
          via.append(el('span', accessed.has(u) ? 'plan-via-done' : '', MASTER.units[u].name + (accessed.has(u) ? '✓' : '')));
        });
        rides.append(via);
      }
      // この区間でルートビューンを使うとき
      const prev = plan.stops[i - 1].u;
      for (const p of plan.rv || []) {
        if ((p.a === prev && p.b === s.u) || (p.b === prev && p.a === s.u)) {
          rides.append(planExtraLine('rv', `ルートビューン（${planStationName(plan, p.a)}⇔${planStationName(plan, p.b)}）`, p.units, accessed, plan));
        }
      }
      // この区間に乗っている途中で取る駅（自動・指定）
      if (leg.pass && leg.pass.length) rides.append(planExtraLine('pass', '途中で取る', leg.pass, accessed, plan, new Set(plan.dropped || [])));
      if (leg.mine && leg.mine.length) rides.append(planExtraLine('pass', '途中で取る（指定）', leg.mine, accessed, plan));
      li.append(rides);
    }
    // この駅からレーダーで取る駅（戻ってきた出発駅では出さない）
    const radarHere = isReturn ? [] : (plan.radar || []).filter(r => r.from === s.u).map(r => r.u);
    if (radarHere.length) li.append(planExtraLine('radar', 'レーダー', radarHere, accessed, plan));
    list.append(li);
  });
  // 順番の中で2駅が続いていないルートビューンは、まとめて出す
  const order = plan.stops.map(s => s.u);
  const apart = (plan.rv || []).filter(p => !routeAdjacent(order, p.a, p.b));   // route.js
  if (apart.length) {
    const box = el('div', 'plan-result');
    for (const p of apart) box.append(planExtraLine('rv', `ルートビューン（${planStationName(plan, p.a)}⇔${planStationName(plan, p.b)}）`, p.units, accessed, plan));
    card.append(box);
  }
  card.append(list);
  return card;
}

// ---------- 共有（sync.js）から使う：まとめ方 ----------

// 1件ごとに、新しく書き換えたほうを残す（消したプランも同じ）
function mergePlanData(local, remote) {
  if (!remote) return local;
  const out = emptyPlanData();
  const keys = new Set([...Object.keys(local.plans || {}), ...Object.keys(remote.plans || {})]);
  for (const k of keys) {
    const a = (local.plans || {})[k], b = (remote.plans || {})[k];
    out.plans[k] = !a ? b : !b ? a : (b.updatedAt > a.updatedAt ? b : a);
  }
  const times = [local.updatedAt, remote.updatedAt].filter(Boolean).sort();
  out.updatedAt = times.length ? times[times.length - 1] : null;
  return out;
}
