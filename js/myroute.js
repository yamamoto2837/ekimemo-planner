// ============================================================
// 自分で作るルート（遠征プランの画面の上の欄）
//
// 「江北→佐世保→伊万里→唐津→赤坂」のように、立ち寄る駅を順番に入れると、
// 駅と駅の間の道の候補（いちばん短い道・未アクセス駅を多く通る道など）を出す（routeplan.js の planRouteCandidates）。
// 候補は「江北→（JR佐世保線）→佐世保→（松浦鉄道西九州線）→伊万里」のように、路線ごとにまとめて書く。
// レーダーで取る駅を入れておくと、選んだ候補の道のどこで使えば何駅目で取れるかを出す（routepick.js の planRadarUseFor）。
// 同じ名前の駅がいくつかあるときは、近い駅を選ぶ（選び直せる）。
// 選んだ候補は、レーダーの予定も含めてプランとして保存できる。
// ============================================================

let myRouteTokens = null;       // 立ち寄る駅: [{ text: 入れた文字, candidates: [駅], chosen: 駅 }]
let myRouteRadarTokens = [];    // レーダーで取る駅（形は同じ）
let myRouteRadarN = 10;         // レーダーで取れる駅の数
let myRouteCands = null;        // ルートの候補: [{ kind, label, route }]
let myRouteSel = 0;             // 選んでいる候補の番号
let myRouteNameIndex = null;    // 探しやすくした駅名 → [駅メモの駅の番号]

// ---------- 準備（app.js から呼ばれる） ----------

function initMyRoute() {
  document.getElementById('myRouteDate').value = todayText();   // plans.js
  document.getElementById('myRouteRadarN').value = myRouteRadarN;
  document.getElementById('myRouteCheck').addEventListener('click', checkMyRoute);
  document.getElementById('myRouteSave').addEventListener('click', saveMyRoute);
  // 駅を書き換えたら、もう一度「候補を出す」まで保存できないようにする
  for (const id of ['myRouteStations', 'myRouteRadar', 'myRouteRadarN']) {
    document.getElementById(id).addEventListener('input', () => {
      myRouteTokens = null;
      myRouteCands = null;
      document.getElementById('myRouteResult').replaceChildren();
      document.getElementById('myRouteSave').disabled = true;
      setMyRouteMessage('', '');
    });
  }
}

function setMyRouteMessage(text, kind) {
  const msg = document.getElementById('myRouteMessage');
  msg.textContent = text;
  msg.className = 'message' + (kind ? ' ' + kind : '');
}

// ---------- 駅名を探す ----------

// 比べやすい形にする（空白を除く、「ヶ・ケ・ヵ」をそろえる、全角の数字・英字を半角に）
function normalizeStationName(s) {
  return s
    .replace(/[\s　]/g, '')
    .replace(/[ヶヵケ]/g, 'ケ')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// かっこの中を除いた名前（「成田空港（第１旅客ターミナル）」→「成田空港」）
function stationBaseName(s) {
  return s.replace(/[（(][^）)]*[）)]/g, '');
}

function buildNameIndex() {
  if (myRouteNameIndex) return myRouteNameIndex;
  const index = new Map();
  const add = (key, u) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    if (!index.get(key).includes(u)) index.get(key).push(u);
  };
  for (const [u, unit] of Object.entries(MASTER.units)) {
    add(normalizeStationName(unit.name), u);
    add(normalizeStationName(stationBaseName(unit.name)), u);
  }
  myRouteNameIndex = index;
  return index;
}

// 1つの駅名から、当てはまる駅の一覧を出す
function findStationsByName(text) {
  const index = buildNameIndex();
  const exact = Object.entries(MASTER.units).filter(([, u]) => u.name === text).map(([id]) => id);
  if (exact.length) return exact;
  const tries = [text];
  if (text.endsWith('駅') && text.length > 1) tries.push(text.slice(0, -1));   // 「米子駅」→「米子」
  for (const t of tries) {
    const hit = index.get(normalizeStationName(t));
    if (hit) return hit;
  }
  return [];
}

// 入れた文字を駅の並びに分ける。区切りは「→」「、」「,」「>」と改行
// 空白は駅名に入ることがある（例: トヨタモビリティ富山 Gスクエア五福前）ので、
// まず全体で探し、見つからないときだけ空白でも区切る
function splitRouteText(text) {
  const parts = text.replace(/->/g, '→').split(/[→⇒＞>、,，\n\r]+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (findStationsByName(p).length || !/[\s　]/.test(p)) out.push(p);
    else out.push(...p.split(/[\s　]+/).filter(Boolean));
  }
  return out;
}

// 同じ名前の駅がいくつかあるとき、前後の駅にいちばん近い駅を選ぶ
function chooseNearest(tokens) {
  const pos = u => MASTER.units[u];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.candidates.length < 2 || t.chosen) continue;
    // 近くの、もう決まっている駅（前の駅は選んだもの、後ろの駅は1つに決まっているもの）
    const refs = [];
    for (let j = i - 1; j >= 0; j--) if (tokens[j].chosen) { refs.push(tokens[j].chosen); break; }
    for (let j = i + 1; j < tokens.length; j++) if (tokens[j].candidates.length === 1) { refs.push(tokens[j].candidates[0]); break; }
    if (refs.length === 0) { t.chosen = t.candidates[0]; continue; }
    let best = null, bestD = Infinity;
    for (const c of t.candidates) {
      const d = refs.reduce((s, r) => s + routeDistKm(pos(c), pos(r)), 0);   // routeplan.js
      if (d < bestD) { bestD = d; best = c; }
    }
    t.chosen = best;
  }
}

// 選び直す欄に出す駅の説明（都道府県と路線）
function candidateLabel(u) {
  const unit = MASTER.units[u];
  const lines = [...new Set(unit.codes.map(c => MASTER.stations[c].line).filter(lc => MASTER.lines[lc]).map(lc => MASTER.lines[lc].name))];
  const lineText = lines.slice(0, 2).join('・') + (lines.length > 2 ? ' ほか' : '');
  return `${unit.name}（${prefName(unit.pref)}・${lineText}）${unit.closed ? '（廃駅）' : ''}`;
}

// ---------- ルートの候補を出す ----------

// 入れた駅名を読み取る。戻り値: { tokens: [{ text, candidates, chosen }], notFound: ['「…」'] }
function readStationTokens(text) {
  const names = splitRouteText(text);
  const tokens = names.map(n => {
    const candidates = findStationsByName(n);
    return { text: n, candidates, chosen: candidates.length === 1 ? candidates[0] : null };
  });
  return { tokens, notFound: tokens.filter(t => t.candidates.length === 0).map(t => `「${t.text}」`) };
}

function checkMyRoute() {
  const resultBox = document.getElementById('myRouteResult');
  document.getElementById('myRouteSave').disabled = true;
  myRouteCands = null;
  const st = readStationTokens(document.getElementById('myRouteStations').value);
  if (st.tokens.length < 2) {
    myRouteTokens = null;
    resultBox.replaceChildren();
    setMyRouteMessage('立ち寄る駅を2つ以上、「→」でつないで入れてください（例: 江北→佐世保→伊万里→唐津→赤坂）。', 'error');
    return;
  }
  if (st.notFound.length) {
    myRouteTokens = null;
    resultBox.replaceChildren();
    setMyRouteMessage(`${st.notFound.join('、')} という駅が見つかりません。駅名を確かめてください（駅メモでの名前で入れます）。`, 'error');
    return;
  }
  // レーダーで取る駅（なくてもよい）
  const rd = readStationTokens(document.getElementById('myRouteRadar').value);
  if (rd.notFound.length) {
    myRouteTokens = null;
    resultBox.replaceChildren();
    setMyRouteMessage(`レーダーで取る駅の ${rd.notFound.join('、')} が見つかりません。駅名を確かめてください。`, 'error');
    return;
  }
  chooseNearest(st.tokens);
  myRouteTokens = st.tokens;
  myRouteRadarTokens = rd.tokens;
  myRouteRadarN = clampInt(document.getElementById('myRouteRadarN').value, 1, 50, 10);   // radar.js
  document.getElementById('myRouteRadarN').value = myRouteRadarN;
  calcMyRoute();
}

// 立ち寄る駅（続けて同じ駅は1つにする）
function myRouteUnits() {
  const units = [];
  for (const t of myRouteTokens) if (units[units.length - 1] !== t.chosen) units.push(t.chosen);
  return units;
}

// 選んだ駅で、ルートの候補を計算して表示する
function calcMyRoute() {
  const units = myRouteUnits();
  if (units.length < 2) {
    myRouteCands = null;
    renderMyRoute();
    setMyRouteMessage('ちがう駅を2つ以上入れてください。', 'error');
    return;
  }
  const accessed = appState.resolved ? appState.resolved.accessed : new Set();
  const res = planRouteCandidates(units, accessed);   // routeplan.js
  if (res.broken) {
    myRouteCands = null;
    renderMyRoute();
    const broken = res.broken.broken.map(i => `${MASTER.units[units[i]].name}→${MASTER.units[units[i + 1]].name}`);
    setMyRouteMessage(`${broken.join('、')} は線路がつながっていないため、ルートにできません。`, 'error');
    document.getElementById('myRouteSave').disabled = true;
    return;
  }
  myRouteCands = res.candidates;
  myRouteSel = 0;
  chooseRadarNearest(units);
  renderMyRoute();
  setMyRouteMessage(`ルートの候補を ${myRouteCands.length} 本出しました。使う候補を選んでから「プランとして保存」を押してください。`, 'good');
  document.getElementById('myRouteSave').disabled = false;
}

// レーダーで取る駅に同じ名前の駅がいくつかあるときは、立ち寄る駅にいちばん近い駅を選ぶ
function chooseRadarNearest(units) {
  for (const t of myRouteRadarTokens) {
    if (t.chosen || t.candidates.length === 0) continue;
    let best = t.candidates[0], bestD = Infinity;
    for (const c of t.candidates) {
      for (const u of units) {
        const d = routeDistKm(MASTER.units[c], MASTER.units[u]);
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    t.chosen = best;
  }
}

// いま選んでいる候補
function myRouteSelected() {
  return myRouteCands && myRouteCands[myRouteSel] ? myRouteCands[myRouteSel] : null;
}

// 選んでいる候補でのレーダーの予定（routepick.js の planRadarUseFor）
// その道を通る駅や、乗っている途中で取れる駅は、レーダーがいらないので passing に分ける
function myRouteRadarPlan(route) {
  const all = [...new Set(myRouteRadarTokens.map(t => t.chosen).filter(Boolean))];
  const along = new Set(route.along);
  const passing = all.filter(u => along.has(u));
  const targets = all.filter(u => !along.has(u));
  if (!targets.length) return { ok: [], ng: [], passing };
  return { ...planRadarUseFor(targets, route.order, route.legs, myRouteRadarN, null), passing };
}

function renderMyRoute() {
  const box = document.getElementById('myRouteResult');
  box.replaceChildren();
  if (!myRouteTokens) return;
  const accessed = appState.resolved ? appState.resolved.accessed : new Set();

  // 同じ名前の駅がいくつかあるときに、選び直す欄
  const ambiguous = [...myRouteTokens.map(t => ({ t, kind: 'stop' })), ...myRouteRadarTokens.map(t => ({ t, kind: 'radar' }))]
    .filter(x => x.t.candidates.length > 1);
  if (ambiguous.length) {
    const amb = el('div', 'myroute-amb');
    amb.append(el('p', 'help', '同じ名前の駅がいくつかあるので、近い駅を選んでいます。違うときは選び直してください。'));
    for (const { t, kind } of ambiguous) {
      const sel = el('select', 'myroute-choice');
      sel.setAttribute('aria-label', `「${t.text}」の駅を選ぶ`);
      for (const c of t.candidates) {
        const op = el('option', '', (kind === 'radar' ? 'レーダー：' : '') + candidateLabel(c));
        op.value = c;
        sel.append(op);
      }
      sel.value = t.chosen;
      sel.addEventListener('change', () => { t.chosen = sel.value; if (kind === 'stop') calcMyRoute(); else renderMyRoute(); });
      amb.append(sel);
    }
    box.append(amb);
  }
  if (!myRouteCands) return;

  // 候補の一覧（押すと選べる）
  const list = el('div', 'myroute-cands');
  myRouteCands.forEach((c, i) => {
    const b = el('button', 'myroute-cand' + (i === myRouteSel ? ' selected' : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(i === myRouteSel));
    const todo = c.route.along.filter(u => !accessed.has(u)).length;
    b.append(
      el('span', 'myroute-cand-label', `${i + 1}. ${c.label}`),
      el('span', 'myroute-cand-sum', routeLineSummary(c.route)),   // routeplan.js
      el('span', 'myroute-cand-nums', `約 ${Math.round(c.route.totalKm)} km・通る未アクセス駅 ${todo} 駅（乗っている途中で取れる駅を含む）`),
    );
    b.addEventListener('click', () => { myRouteSel = i; renderMyRoute(); });
    list.append(b);
  });
  box.append(list);

  const cand = myRouteSelected();
  const route = cand.route;
  const radar = myRouteRadarPlan(route);
  if (route.guessed.length) {
    box.append(el('p', 'notice', '線路のデータが無い区間や廃止区間は、駅と駅を直線で結んで考えています（「推定」と書いた区間）。'));
  }

  // レーダーの予定（経路の順番どおり、使う場所ごと）
  if (radar.ok.length || radar.ng.length || radar.passing.length) {
    const rbox = el('div', 'myroute-radar');
    rbox.append(el('h4', 'role-radar-text', `レーダーの予定（レーダー ${myRouteRadarN} 駅）`));
    const groups = [];
    for (const r of radar.ok) {
      const last = groups[groups.length - 1];
      if (last && last.near === r.near) last.items.push(r);
      else groups.push({ near: r.near, items: [r] });
    }
    for (const gr of groups) {
      const line = el('div', 'route-extra route-extra-radar');
      line.append(el('b', '', `${MASTER.units[gr.near].name}から：`));
      gr.items.sort((a, b) => a.rank - b.rank).forEach((r, k) => {
        if (k > 0) line.append('、');
        const done = accessed.has(r.u);
        line.append(el('span', done ? 'route-extra-done' : '', MASTER.units[r.u].name + (done ? '✓' : '')), el('small', 'muted', `（${r.rank}駅目）`));
      });
      rbox.append(line);
    }
    if (radar.passing.length) {
      rbox.append(el('p', 'help', `この道を通るか、乗っている途中で取れるので、レーダーはいりません：${radar.passing.map(u => MASTER.units[u].name).join('、')}`));
    }
    if (radar.ng.length) {
      rbox.append(el('p', 'notice', `レーダー ${myRouteRadarN} 駅では、この道のどこからも届きません：${radar.ng.map(r => MASTER.units[r.u].name).join('、')}。駅数を増やすか、別の候補や立ち寄る駅を変えてください。`));
    }
    box.append(rbox);
  }

  // 選んだ候補の中身（区間ごとの乗り方）
  const stops = el('ol', 'route-list');
  route.order.forEach((u, i) => {
    const li = el('li', 'route-stop' + (accessed.has(u) ? ' plan-done' : ''));
    const head = el('div', 'route-stop-head');
    head.append(el('span', 'route-num', i === 0 ? '出発' : i === route.order.length - 1 ? '到着' : String(i)));
    head.append(el('span', 'route-name', MASTER.units[u].name), el('small', 'muted', `（${prefName(MASTER.units[u].pref)}）`));
    if (accessed.has(u)) head.append(el('span', 'plan-check', '✓ アクセス済み'));
    li.append(head);
    const leg = i > 0 ? route.legs[i - 1] : null;
    if (leg) {
      const rides = el('div', 'route-rides');
      rides.append(el('span', 'route-km', `約 ${Math.round(leg.km * 10) / 10} km`));
      for (const r of leg.rides) {
        const guess = r.line === 'guess' || String(r.line).startsWith('closed:');
        rides.append(el('div', 'route-ride' + (guess ? ' guess' : ''), r.line === 'transfer'
          ? `乗り換え（${MASTER.units[r.from].name}→${MASTER.units[r.to].name}）`
          : `${lineName(r.line)}：${MASTER.units[r.from].name}→${MASTER.units[r.to].name}`));   // route.js
      }
      const via = passAlongRides(leg.rides).filter(v => v !== leg.from && v !== leg.to && !accessed.has(v));
      if (via.length) rides.append(el('div', 'plan-via', `途中の未アクセス駅 ${via.length}：` + via.map(v => MASTER.units[v].name).join('、')));
      const legRadar = radar.ok.filter(r => !r.stop && r.leg === i - 1);
      if (legRadar.length) radarExtraLines(legRadar, accessed, v => MASTER.units[v].name, false).forEach(x => rides.append(x));   // route.js
      li.append(rides);
    }
    const here = radar.ok.filter(r => r.stop === u);
    if (here.length) radarExtraLines(here, accessed, v => MASTER.units[v].name, true).forEach(x => li.append(x));
    stops.append(li);
  });
  box.append(stops);
}

// ---------- 保存 ----------

async function saveMyRoute() {
  const btn = document.getElementById('myRouteSave');
  const msg = document.getElementById('myRouteSaveMessage');
  const cand = myRouteSelected();
  if (!cand) return;
  const route = cand.route;
  const dateInput = document.getElementById('myRouteDate');
  if (!dateInput.value) { msg.textContent = '日付を入れてください。'; msg.className = 'message error'; return; }
  const nameInput = document.getElementById('myRouteName');
  const stops = route.order.map(u => MASTER.units[u].name);
  // ルート名が空なら「江北→赤坂」のように、はしの駅で名前を付ける
  const name = nameInput.value.trim() || `${stops[0]}→${stops[stops.length - 1]}`;
  const noteInput = document.getElementById('myRouteNote');
  btn.disabled = true;
  try {
    const radar = myRouteRadarPlan(route);
    const id = await addPlanFromMyRoute(name, dateInput.value, route, noteInput.value.trim(), {   // plans.js
      summary: routeLineSummary(route),
      radar: radar.ok,
      radarN: myRouteRadarN,
    });
    msg.replaceChildren(document.createTextNode(`「${name}」を保存しました。下の一覧に並んでいます。`));
    msg.className = 'message good';
    // 欄を空にして、次のルートを入れられるようにする
    nameInput.value = '';
    noteInput.value = '';
    document.getElementById('myRouteStations').value = '';
    document.getElementById('myRouteRadar').value = '';
    myRouteTokens = null;
    myRouteCands = null;
    document.getElementById('myRouteResult').replaceChildren();
    setMyRouteMessage('', '');
    selectPlan(id);   // plans.js（保存したプランを開いて見せる）
  } catch (e) {
    msg.textContent = '保存できませんでした: ' + e.message;
    msg.className = 'message error';
    btn.disabled = false;
  }
}
