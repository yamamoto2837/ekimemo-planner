// ============================================================
// 自分で作るルート（遠征プランの画面の上の欄）
//
// 「境港→米子→鳥取→津山」のように、回りたい駅を順番に入れると、
// 駅と駅の間で乗る路線・距離・途中で通る未アクセス駅を出し、プランとして保存できる。
// 駅と駅の間は、線路に沿っていちばん短い道で考える（routeplan.js の planFixedRoute）。
// 同じ名前の駅がいくつかあるときは、前後の駅に近いほうを選ぶ（選び直せる）。
// ============================================================

let myRouteTokens = null;    // 読み取った駅: [{ text: 入れた文字, candidates: [駅], chosen: 駅 }]
let myRouteResult = null;    // 計算したルート（planFixedRoute の戻り値）
let myRouteNameIndex = null; // 探しやすくした駅名 → [駅メモの駅の番号]

// ---------- 準備（app.js から呼ばれる） ----------

function initMyRoute() {
  document.getElementById('myRouteDate').value = todayText();   // plans.js
  document.getElementById('myRouteCheck').addEventListener('click', checkMyRoute);
  document.getElementById('myRouteSave').addEventListener('click', saveMyRoute);
  // 駅の順番を書き換えたら、もう一度「確かめる」まで保存できないようにする
  document.getElementById('myRouteStations').addEventListener('input', () => {
    myRouteTokens = null;
    myRouteResult = null;
    document.getElementById('myRouteResult').replaceChildren();
    document.getElementById('myRouteSave').disabled = true;
    setMyRouteMessage('', '');
  });
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

// ---------- 確かめる ----------

function checkMyRoute() {
  const text = document.getElementById('myRouteStations').value;
  const names = splitRouteText(text);
  document.getElementById('myRouteSave').disabled = true;
  if (names.length < 2) {
    myRouteTokens = null;
    document.getElementById('myRouteResult').replaceChildren();
    setMyRouteMessage('駅を2つ以上、「→」でつないで入れてください（例: 境港→米子→鳥取→津山）。', 'error');
    return;
  }
  const tokens = names.map(n => {
    const candidates = findStationsByName(n);
    return { text: n, candidates, chosen: candidates.length === 1 ? candidates[0] : null };
  });
  const notFound = tokens.filter(t => t.candidates.length === 0).map(t => `「${t.text}」`);
  if (notFound.length) {
    myRouteTokens = null;
    document.getElementById('myRouteResult').replaceChildren();
    setMyRouteMessage(`${notFound.join('、')} という駅が見つかりません。駅名を確かめてください（駅メモでの名前で入れます）。`, 'error');
    return;
  }
  chooseNearest(tokens);
  myRouteTokens = tokens;
  calcMyRoute();
}

// 選んだ駅で、区間ごとの乗り方を計算して表示する
function calcMyRoute() {
  // 同じ駅が続いたら1つにする
  const units = [];
  for (const t of myRouteTokens) if (units[units.length - 1] !== t.chosen) units.push(t.chosen);
  if (units.length < 2) {
    myRouteResult = null;
    renderMyRoute();
    setMyRouteMessage('ちがう駅を2つ以上入れてください。', 'error');
    return;
  }
  myRouteResult = planFixedRoute(units);   // routeplan.js
  renderMyRoute();
  const broken = myRouteResult.broken.map(i => `${MASTER.units[units[i]].name}→${MASTER.units[units[i + 1]].name}`);
  if (broken.length) {
    setMyRouteMessage(`${broken.join('、')} は線路がつながっていないため、ルートにできません。`, 'error');
    document.getElementById('myRouteSave').disabled = true;
    return;
  }
  setMyRouteMessage('ルートを考えました。中身を確かめてから「プランとして保存」を押してください。', 'good');
  document.getElementById('myRouteSave').disabled = false;
}

function renderMyRoute() {
  const box = document.getElementById('myRouteResult');
  box.replaceChildren();
  if (!myRouteTokens) return;
  const accessed = appState.resolved ? appState.resolved.accessed : new Set();
  const route = myRouteResult;

  if (route) {
    const todo = route.passed.filter(u => !accessed.has(u));
    box.append(el('p', 'detail-count', `約 ${Math.round(route.totalKm)} km・通る駅 ${route.passed.length} 駅（うち未アクセス ${todo.length} 駅）`));
    if (route.guessed.length) {
      box.append(el('p', 'notice', '線路のデータが無い区間や廃止区間は、駅と駅を直線で結んで考えています（「推定」と書いた区間）。'));
    }
  }

  // 駅の並び。同じ名前の駅がいくつかあるときは、選び直せる
  const list = el('ol', 'route-list');
  let legIndex = 0;
  myRouteTokens.forEach((t, i) => {
    if (i > 0 && myRouteTokens[i - 1].chosen === t.chosen) return;   // 続けて同じ駅は1つにまとめた
    const li = el('li', 'route-stop' + (accessed.has(t.chosen) ? ' plan-done' : ''));
    const head = el('div', 'route-stop-head');
    head.append(el('span', 'route-num', legIndex === 0 ? '出発' : String(legIndex)));
    if (t.candidates.length > 1) {
      const sel = el('select', 'myroute-choice');
      sel.setAttribute('aria-label', `「${t.text}」の駅を選ぶ`);
      for (const c of t.candidates) {
        const op = el('option', '', candidateLabel(c));
        op.value = c;
        sel.append(op);
      }
      sel.value = t.chosen;
      sel.addEventListener('change', () => { t.chosen = sel.value; calcMyRoute(); });
      head.append(sel);
    } else {
      head.append(el('span', 'route-name', MASTER.units[t.chosen].name), el('small', 'muted', `（${prefName(MASTER.units[t.chosen].pref)}）`));
    }
    if (accessed.has(t.chosen)) head.append(el('span', 'plan-check', '✓ アクセス済み'));
    li.append(head);

    const leg = route && legIndex > 0 ? route.legs[legIndex - 1] : null;
    if (leg) {
      const rides = el('div', 'route-rides');
      if (!isFinite(leg.km)) {
        rides.append(el('div', 'route-ride guess', '線路がつながっていません'));
      } else {
        rides.append(el('span', 'route-km', `約 ${Math.round(leg.km * 10) / 10} km`));
        for (const r of leg.rides) {
          const guess = r.line === 'guess' || String(r.line).startsWith('closed:');
          rides.append(el('div', 'route-ride' + (guess ? ' guess' : ''), r.line === 'transfer'
            ? `乗り換え（${MASTER.units[r.from].name}→${MASTER.units[r.to].name}）`
            : `${lineName(r.line)}：${MASTER.units[r.from].name}→${MASTER.units[r.to].name}`));   // route.js
        }
        const via = [...new Set(leg.rides.flatMap(r => r.path))].filter(u => u !== leg.from && u !== leg.to && !accessed.has(u));
        if (via.length) rides.append(el('div', 'plan-via', `途中の未アクセス駅 ${via.length}：` + via.map(u => MASTER.units[u].name).join('、')));
      }
      li.append(rides);
    }
    list.append(li);
    legIndex++;
  });
  box.append(list);
}

// ---------- 保存 ----------

async function saveMyRoute() {
  const btn = document.getElementById('myRouteSave');
  const msg = document.getElementById('myRouteSaveMessage');
  if (!myRouteResult || myRouteResult.broken.length) return;
  const dateInput = document.getElementById('myRouteDate');
  if (!dateInput.value) { msg.textContent = '日付を入れてください。'; msg.className = 'message error'; return; }
  const nameInput = document.getElementById('myRouteName');
  const stops = myRouteResult.order.map(u => MASTER.units[u].name);
  // ルート名が空なら「境港→津山」のように、はしの駅で名前を付ける
  const name = nameInput.value.trim() || `${stops[0]}→${stops[stops.length - 1]}`;
  const noteInput = document.getElementById('myRouteNote');
  btn.disabled = true;
  try {
    const id = await addPlanFromMyRoute(name, dateInput.value, myRouteResult, noteInput.value.trim());   // plans.js
    msg.replaceChildren(document.createTextNode(`「${name}」を保存しました。下の一覧に並んでいます。`));
    msg.className = 'message good';
    // 欄を空にして、次のルートを入れられるようにする
    nameInput.value = '';
    noteInput.value = '';
    document.getElementById('myRouteStations').value = '';
    myRouteTokens = null;
    myRouteResult = null;
    document.getElementById('myRouteResult').replaceChildren();
    setMyRouteMessage('', '');
    selectPlan(id);   // plans.js（保存したプランを開いて見せる）
  } catch (e) {
    msg.textContent = '保存できませんでした: ' + e.message;
    msg.className = 'message error';
    btn.disabled = false;
  }
}
