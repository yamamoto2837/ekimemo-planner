// ============================================================
// 現在地から近い未アクセス駅（F6）
//
// 出先で「いまいる場所の近くに、まだ行っていない駅はあるか」を見る画面。
// ・現在地（スマホの位置情報）か、駅名を基準にする
// ・未アクセス駅（廃駅も含む。「廃駅を非表示」で外せる）を、直線距離の近い順に並べる
// 位置情報はその場の計算に使うだけで、保存も送信もしない。
// ============================================================

const NEAR_LIMITS = [10, 30, 50];
let nearLimit = 30;
let nearBase = null;   // 基準の地点 { lat, lon, label, accuracy }
let nearHideClosed = false;   // 廃駅を出さないか（最初は廃駅も出す）

// ---------- 準備（app.js から呼ばれる） ----------

function initNearScreen() {
  const hideClosed = document.getElementById('nearHideClosed');
  nearHideClosed = hideClosed.checked;
  hideClosed.addEventListener('change', e => { nearHideClosed = e.target.checked; renderNear(); });

  document.getElementById('nearLocate').addEventListener('click', locateHere);
  document.getElementById('nearStationForm').addEventListener('submit', e => {
    e.preventDefault();
    searchByStationName(document.getElementById('nearStationName').value.trim());
  });

  const chips = document.getElementById('nearLimitChips');
  for (const n of NEAR_LIMITS) {
    const b = el('button', 'chip', `${n} 駅`);
    b.type = 'button';
    b.dataset.value = n;
    b.addEventListener('click', () => { nearLimit = n; renderNear(); });
    chips.append(b);
  }
}

// ---------- 基準の地点を決める ----------

function setNearMessage(text, kind) {
  const m = document.getElementById('nearMessage');
  m.textContent = text;
  m.className = 'message' + (kind ? ' ' + kind : '');
}

// 現在地を取る
function locateHere() {
  if (!navigator.geolocation) {
    setNearMessage('このブラウザでは位置情報が使えません。下の「駅名から探す」を使ってください。', 'error');
    return;
  }
  setNearMessage('現在地を調べています…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      nearBase = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        label: '現在地',
        accuracy: pos.coords.accuracy,
      };
      setNearMessage('');
      renderNear();
    },
    err => {
      const reasons = {
        1: '位置情報の利用が許可されていません。ブラウザの設定で、このページに位置情報の利用を許可してください。',
        2: '現在地がわかりませんでした。電波のよい場所で、もう一度試してください。',
        3: '現在地を調べるのに時間がかかりすぎました。もう一度試してください。',
      };
      setNearMessage(reasons[err.code] || '現在地を調べられませんでした。', 'error');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

// 駅名で基準を決める（同じ名前の駅が複数あれば選んでもらう）
function searchByStationName(name) {
  const choices = document.getElementById('nearStationChoices');
  choices.replaceChildren();
  if (!name) return;

  const hits = Object.entries(MASTER.units).filter(([, u]) => u.name === name);
  if (hits.length === 0) {
    setNearMessage(`「${name}」という駅が見つかりません。駅名を確かめてください（「駅」は付けずに入力します）。`, 'error');
    return;
  }
  setNearMessage('');
  if (hits.length === 1) {
    useStationAsBase(hits[0][0]);
    return;
  }
  choices.append(el('p', 'help', `「${name}」は ${hits.length} 駅あります。選んでください。`));
  for (const [id, u] of hits) {
    const line = MASTER.lines[MASTER.stations[u.codes[0]].line];
    const b = el('button', 'chip', `${u.name}（${prefName(u.pref)}${line ? '・' + line.name : ''}）`);
    b.type = 'button';
    b.addEventListener('click', () => { choices.replaceChildren(); useStationAsBase(id); });
    choices.append(b);
  }
}

function useStationAsBase(unitId) {
  const u = MASTER.units[unitId];
  nearBase = { lat: u.lat, lon: u.lon, label: `${u.name}駅（${prefName(u.pref)}）`, accuracy: null, unitId };
  renderNear();
}

// ---------- 距離と方角 ----------

// 2地点の直線距離（メートル）。地球を球として計算する
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 方角（北・北東・東…の8方位）
function directionName(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(deg / 45) % 8];
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

// 基準の地点から近い未アクセス駅を集める（「廃駅を非表示」なら廃駅を除く）。
// 駅メモの駅に駅コードが複数あるとき（乗換駅など）は、一番近い駅コードの位置で測る。
function nearestTodo(base, limit) {
  const accessed = appState.resolved.accessed;
  const list = [];
  for (const [u, unit] of Object.entries(MASTER.units)) {
    if (accessed.has(u) || u === base.unitId) continue;
    if (unit.closed && nearHideClosed) continue;
    let best = null;
    for (const c of unit.codes) {
      const s = MASTER.stations[c];
      const d = distanceMeters(base.lat, base.lon, s.lat, s.lon);
      if (!best || d < best.d) best = { d, lat: s.lat, lon: s.lon };
    }
    list.push({ u, ...best });
  }
  list.sort((a, b) => a.d - b.d);
  return list.slice(0, limit);
}

// ---------- 描画 ----------

function renderNear() {
  const empty = document.getElementById('nearEmpty');
  const body = document.getElementById('nearBody');
  if (!appState.resolved) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  document.querySelectorAll('#nearLimitChips .chip').forEach(b => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.value) === nearLimit));
  });

  const head = document.getElementById('nearBaseInfo');
  const list = document.getElementById('nearList');
  list.replaceChildren();
  if (!nearBase) {
    head.textContent = '「現在地から探す」を押すか、駅名を入れて探してください。';
    return;
  }
  let info = `${nearBase.label}から近い順（直線距離）`;
  if (nearBase.accuracy) info += `　位置の誤差 約 ${formatDistance(nearBase.accuracy)}`;
  head.textContent = info;

  for (const p of nearestTodo(nearBase, nearLimit)) list.append(nearItem(p));
  if (!list.children.length) list.append(el('li', 'muted', '未アクセスの駅はありません。'));
}

// 駅1つ分の行
function nearItem(p) {
  const unit = MASTER.units[p.u];
  const li = el('li', unit.closed ? 'near-item near-closed' : 'near-item');

  const head = el('div', 'near-head');
  const name = el('span', 'near-name', unit.name);
  name.append(el('small', 'muted', `（${prefName(unit.pref)}）`));
  if (unit.closed) name.append(' ', el('span', 'tag', '廃駅'));
  const dist = el('span', 'near-dist', formatDistance(p.d));
  dist.append(el('small', '', ` ${directionName(nearBase.lat, nearBase.lon, p.lat, p.lon)}`));
  head.append(name, dist);

  // 通る路線（押すと路線詳細へ）
  const lines = el('div', 'near-lines');
  const seen = new Set();
  for (const c of unit.codes) {
    const lc = MASTER.stations[c].line;
    if (seen.has(lc) || !MASTER.lines[lc]) continue;
    seen.add(lc);
    if (seen.size > 1) lines.append('、');
    const a = el('a', '', MASTER.lines[lc].name);
    a.href = lineHref(lc);
    lines.append(a);
  }

  // Google マップで経路を調べる（押したときだけ外のサイトを開く）
  const route = el('a', 'near-route', '経路を調べる');
  route.href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=transit`;
  route.target = '_blank';
  route.rel = 'noopener';

  li.append(head, lines);
  const memo = memoView(stationMemo(p.u));   // この駅のメモ（memo.js）
  if (memo) li.append(memo);
  li.append(route);
  return li;
}
