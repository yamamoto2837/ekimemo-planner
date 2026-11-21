// ============================================================
// 行程表（遠征プランごと）
//
// 乗車（出発・到着時刻、駅、路線、列車名）と、宿泊・食事・観光・その他の予定を、時刻順に並べる。
//   ・プランの道すじから、乗車の並びを下書きとして作れる
//   ・時刻は自分で入れる（各乗車の「乗換案内で調べる」で Yahoo!乗換案内を開き、調べた時刻を書き写す）
//   ・宿泊を区切りに「1日目・2日目…」と分ける
//   ・乗り換え時間が短い・時刻が重なる・時刻の順番が前後する・乗る駅が前の到着駅と違う、をお知らせする
//   ・乗車ごとに、取れる未アクセス駅とレーダーの予定を出す
// 中身はプランの itinerary に入れて保存する（plans.js。共有もプランと一緒）。
//   itinerary: { items: [{ id, type, … }] }
//     type 'ride'  … { dep, arr, from, to, fromU, toU, line, train, note }
//     type 'stay'・'meal'・'sight'・'other' … { start, end, title, place, note }
// ============================================================

const ITIN_TYPES = {
  ride: '乗車',
  stay: '宿泊',
  meal: '食事',
  sight: '観光',
  other: 'その他',
};
const ITIN_MIN_TRANSFER = 5;   // これより短い乗り換え（分）はお知らせする
const ITIN_SAVE_DELAY = 800;   // 書いてから保存するまで（ミリ秒）

const itinMode = new Map();    // プランの番号 → 'view'（見る）か 'edit'（直す）
let itinSaveTimer = null;

// ---------- 時刻・日付 ----------

// 'HH:MM' → 分（無ければ null）
function itinMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// 遠征の日付（plan.date）から数えて day 日目の日付
function itinDate(plan, day) {
  const [y, m, d] = (plan.date || todayText()).split('-').map(Number);   // plans.js
  return new Date(y, m - 1, d + day - 1);
}

function itinDateText(date) {
  return `${date.getMonth() + 1}/${date.getDate()}（${'日月火水木金土'[date.getDay()]}）`;
}

// Yahoo!乗換案内を、その日・その区間・出発時刻で開くアドレス
function itinTransitUrl(from, to, date, time) {
  const q = new URLSearchParams({ from, to, y: String(date.getFullYear()), m: String(date.getMonth() + 1).padStart(2, '0'), d: String(date.getDate()).padStart(2, '0'), type: '1' });
  const t = itinMin(time);
  if (t !== null) {
    q.set('hh', String(Math.floor(t / 60)).padStart(2, '0'));
    q.set('m1', String(Math.floor((t % 60) / 10)));
    q.set('m2', String(t % 10));
  }
  return 'https://transit.yahoo.co.jp/search/result?' + q.toString();
}

function itinNewId() {
  return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------- 下書き ----------

// プランの道すじから、乗車の並びを作る（同じ名前の路線が続く所は1つにまとめる。乗り換えの歩きは入れない）
function itinDraftFromPlan(plan) {
  const base = name => String(name).replace(/（廃止区間・直線で推定）$/, '').replace(/[（(][^）)]*[）)]$/, '');
  const rides = [];
  let cur = plan.stops && plan.stops[0] ? plan.stops[0].u : null;
  for (const leg of plan.legs || []) {
    for (const r of leg.rides || []) {
      const toU = nearestUnitByName(r.to, cur);   // plans.js
      if (r.line === '乗り換え') { cur = toU || cur; continue; }
      const last = rides[rides.length - 1];
      if (last && base(last.line) === base(r.line) && last.to === r.from) {
        last.to = r.to; last.toU = toU; last.line = base(r.line);
      } else {
        rides.push({ id: itinNewId(), type: 'ride', dep: '', arr: '', from: r.from, to: r.to, fromU: cur, toU, line: base(r.line), train: '', note: '' });
      }
      cur = toU || cur;
    }
  }
  return rides;
}

// ---------- 保存 ----------

function itinSave(plan) {
  touchPlan(plan);   // plans.js
  clearTimeout(itinSaveTimer);
  itinSaveTimer = setTimeout(() => { storePlans().catch(e => console.warn('行程表を保存できませんでした', e)); }, ITIN_SAVE_DELAY);
}

// ---------- 乗車で取れる駅 ----------

const itinStationsCache = new Map();

// 乗車（fromU → toU）で、通る駅と乗っている途中で取れる駅、その区間で使うレーダー
function itinRideInfo(plan, item) {
  if (!item.fromU || !item.toU) return null;
  const seq = [];
  for (const p of planPaths(plan)) for (const u of p) if (seq[seq.length - 1] !== u) seq.push(u);   // plans.js
  const i = seq.indexOf(item.fromU);
  const j = i < 0 ? -1 : seq.indexOf(item.toU, i + 1);
  if (i < 0 || j < 0) return null;
  const slice = seq.slice(i, j + 1);
  const key = slice.join(',');
  let along = itinStationsCache.get(key);
  if (!along) {
    const set = new Set();
    for (let k = 0; k < slice.length; k++) {
      set.add(slice[k]);
      if (k + 1 < slice.length && MASTER.units[slice[k]] && MASTER.units[slice[k + 1]]) {
        for (const v of passAlongSegment(slice[k], slice[k + 1])) set.add(v);   // routeplan.js
      }
    }
    along = [...set];
    itinStationsCache.set(key, along);
  }
  const inSlice = new Set(slice);
  const radar = (plan.radar || []).filter(r => r.rank && (inSlice.has(r.near) || inSlice.has(r.stop)) && r.near !== item.fromU);
  return { along, radar };
}

// ---------- 確かめる ----------

// 項目ごとのお知らせ（項目の番号 → [文]）と、乗車の間の待ち時間（項目の番号 → 分）
function itinChecks(items) {
  const warn = new Map(), wait = new Map();
  const add = (id, text) => { if (!warn.has(id)) warn.set(id, []); warn.get(id).push(text); };
  let prev = null;   // 同じ日の、時刻のある前の項目
  let prevRide = null;
  for (const it of items) {
    const isRide = it.type === 'ride';
    let s = itinMin(isRide ? it.dep : it.start), e = itinMin(isRide ? it.arr : it.end);
    if (isRide && (s === null || e === null)) add(it.id, '時刻が入っていません');
    if (s !== null && e !== null && e < s) e += 24 * 60;   // 日をまたぐ
    if (prev && s !== null) {
      if (s < prev.end) {
        if (isRide && prevRide === prev.it) add(it.id, `前の列車の到着（${prev.it.arr}）より前に出発します`);
        else add(it.id, `前の予定（${ITIN_TYPES[prev.it.type]}・〜${prev.endText}）と時刻が重なっています`);
      } else if (isRide && prevRide === prev.it) {
        const w = s - prev.end;
        wait.set(it.id, w);
        if (w < ITIN_MIN_TRANSFER) add(it.id, `乗り換えが ${w} 分しかありません`);
      }
    }
    if (isRide && prevRide && it.from && prevRide.to && it.from !== prevRide.to) {
      add(it.id, `前に降りる駅（${prevRide.to}）と、乗る駅（${it.from}）が違います`);
    }
    if (s !== null) {
      const end = e !== null ? e : s;
      prev = { it, end, endText: (isRide ? it.arr : it.end) || (isRide ? it.dep : it.start) };
    }
    if (isRide) prevRide = it;
    if (it.type === 'stay') { prev = null; prevRide = null; }   // 泊まったら次の日
  }
  return { warn, wait };
}

// ---------- 画面 ----------

// プランのカードに入れる「行程表」の欄
function itinSection(plan) {
  const box = el('details', 'itin');
  box.open = !!plan.itinerary;
  box.append(el('summary', 'itin-title', plan.itinerary ? `行程表（${plan.itinerary.items.length} 件）` : '行程表を作る'));
  const body = el('div', 'itin-body');
  box.append(body);
  renderItinBody(body, plan);
  return box;
}

function renderItinBody(body, plan) {
  body.replaceChildren();
  if (!plan.itinerary) {
    body.append(el('p', 'help', '乗車・宿泊・食事などの予定を、時刻順に並べた行程表を作れます。時刻は、各乗車の「乗換案内で調べる」で調べて書き写してください。'));
    const buttons = el('div', 'buttons');
    const draft = el('button', 'primary', '道すじから下書きを作る');
    draft.type = 'button';
    draft.addEventListener('click', () => {
      plan.itinerary = { items: itinDraftFromPlan(plan) };
      itinMode.set(plan.id, 'edit');
      itinSave(plan);
      renderItinBody(body, plan);
      itinRefreshTitle(body, plan);
    });
    const empty = el('button', '', '何もない行程表を作る');
    empty.type = 'button';
    empty.addEventListener('click', () => {
      plan.itinerary = { items: [] };
      itinMode.set(plan.id, 'edit');
      itinSave(plan);
      renderItinBody(body, plan);
      itinRefreshTitle(body, plan);
    });
    buttons.append(draft, empty);
    body.append(buttons);
    return;
  }

  const mode = itinMode.get(plan.id) || (plan.itinerary.items.some(it => it.type !== 'ride' || it.dep) ? 'view' : 'edit');
  // 見る・直すの切り替えと、印刷
  const bar = el('div', 'itin-bar itin-controls');
  for (const [m, label] of [['view', '見る'], ['edit', '直す']]) {
    const b = el('button', 'chip', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(mode === m));
    b.addEventListener('click', () => { itinMode.set(plan.id, m); renderItinBody(body, plan); });
    bar.append(b);
  }
  const print = el('button', '', '行程表を印刷する');
  print.type = 'button';
  print.addEventListener('click', () => itinPrint(body, plan));
  bar.append(print);
  body.append(bar);

  const checks = itinChecks(plan.itinerary.items);
  const list = el('div', 'itin-list');
  body.append(list);
  if (mode === 'edit') renderItinEdit(list, body, plan, checks);
  else renderItinView(list, plan, checks);

  if (mode === 'edit') {
    const tail = el('div', 'itin-add itin-controls');
    tail.append(el('span', 'muted', '最後に足す：'));
    for (const [type, label] of Object.entries(ITIN_TYPES)) {
      const b = el('button', 'memo-button', '＋' + label);
      b.type = 'button';
      b.addEventListener('click', () => itinInsert(body, plan, plan.itinerary.items.length, type));
      tail.append(b);
    }
    const del = el('button', 'memo-button', '行程表を消す');
    del.type = 'button';
    del.addEventListener('click', () => {
      if (!confirm('この行程表を消しますか？（プランは残ります）')) return;
      delete plan.itinerary;
      itinSave(plan);
      renderItinBody(body, plan);
      itinRefreshTitle(body, plan);
    });
    tail.append(del);
    body.append(tail);
  }
}

function itinRefreshTitle(body, plan) {
  const t = body.parentElement && body.parentElement.querySelector('.itin-title');
  if (t) t.textContent = plan.itinerary ? `行程表（${plan.itinerary.items.length} 件）` : '行程表を作る';
}

// 新しい項目を、index の位置に入れる
function itinInsert(body, plan, index, type) {
  const items = plan.itinerary.items;
  let it;
  if (type === 'ride') {
    // 前の乗車の降りる駅を、乗る駅にしておく
    const prevRide = items.slice(0, index).reverse().find(x => x.type === 'ride');
    it = { id: itinNewId(), type, dep: '', arr: '', from: prevRide ? prevRide.to : '', to: '', fromU: prevRide ? prevRide.toU : null, toU: null, line: '', train: '', note: '' };
  } else {
    it = { id: itinNewId(), type, start: '', end: '', title: '', place: '', note: '' };
  }
  items.splice(index, 0, it);
  itinSave(plan);
  renderItinBody(body, plan);
  itinRefreshTitle(body, plan);
}

// 日の見出し（1日目 11/1（日））を入れながら、項目を並べる
function itinEachWithDays(plan, fn) {
  let day = 1;
  plan.itinerary.items.forEach((it, i) => {
    fn(it, i, day, i === 0 || plan.itinerary.items[i - 1].type === 'stay');
    if (it.type === 'stay') day++;
  });
  return day;
}

function itinDayHead(plan, day) {
  return el('h4', 'itin-day', `${day}日目　${itinDateText(itinDate(plan, day))}`);
}

function itinWarnBox(checks, id) {
  const w = checks.warn.get(id);
  if (!w) return null;
  const box = el('div', 'itin-warn');
  w.forEach(t => box.append(el('div', '', '⚠ ' + t)));
  return box;
}

// ---------- 見る ----------

function renderItinView(list, plan, checks) {
  const accessed = appState.resolved ? appState.resolved.accessed : new Set();
  if (plan.itinerary.items.length === 0) {
    list.append(el('p', 'muted', 'まだ予定がありません。「直す」から足してください。'));
    return;
  }
  const firstRide = plan.itinerary.items.find(x => x.type === 'ride');
  itinEachWithDays(plan, (it, i, day, newDay) => {
    if (newDay) list.append(itinDayHead(plan, day));
    if (checks.wait.has(it.id)) list.append(el('div', 'itin-wait', `乗り換え・待ち ${checks.wait.get(it.id)} 分`));
    const row = el('div', 'itin-row itin-' + it.type);
    if (it.type === 'ride') {
      row.append(el('span', 'itin-time', `${it.dep || '--:--'} → ${it.arr || '--:--'}`));
      const main = el('div', 'itin-main');
      main.append(el('span', 'itin-tag', '乗車'), el('b', '', `${it.from || '？'} →（${[it.line, it.train].filter(Boolean).join('・') || '路線未入力'}）→ ${it.to || '？'}`));
      if (it.note) main.append(el('div', 'itin-note', it.note));
      // この乗車で取れる駅・レーダー
      const info = itinRideInfo(plan, it);
      if (info) {
        // 乗る駅は、前の乗車で取れているので数えない（最初の乗車だけは数える）
        const todo = info.along.filter(u => !accessed.has(u) && (it === firstRide || u !== it.fromU));
        if (todo.length) main.append(el('div', 'itin-get', `取れる未アクセス駅 ${todo.length}：` + todo.map(u => MASTER.units[u].name).join('、')));
        if (info.radar.length) radarExtraLines(info.radar, accessed, u => planStationName(plan, u), false).forEach(x => main.append(x));   // route.js
      }
      row.append(main);
    } else {
      row.append(el('span', 'itin-time', it.start ? `${it.start}${it.end ? ' – ' + it.end : ''}` : '時刻なし'));
      const main = el('div', 'itin-main');
      main.append(el('span', 'itin-tag', ITIN_TYPES[it.type]), el('b', '', it.title || '（名前なし）'));
      if (it.place) main.append(el('span', 'muted', `　${it.place}`));
      if (it.note) main.append(el('div', 'itin-note', it.note));
      row.append(main);
    }
    list.append(row);
    const w = itinWarnBox(checks, it.id);
    if (w) list.append(w);
  });
}

// ---------- 直す ----------

function itinInput(type, value, placeholder, label, onInput, cls) {
  const inp = el('input', 'itin-input' + (cls ? ' ' + cls : ''));
  inp.type = type;
  inp.value = value || '';
  if (placeholder) inp.placeholder = placeholder;
  inp.setAttribute('aria-label', label);
  inp.addEventListener('input', () => onInput(inp.value));
  return inp;
}

function renderItinEdit(list, body, plan, checks) {
  const items = plan.itinerary.items;
  if (items.length === 0) list.append(el('p', 'muted', 'まだ予定がありません。下の「最後に足す」から足してください。'));
  // 書き換えたとき：保存して、お知らせだけ描き直す（入力中の欄は描き直さない）
  const changed = () => {
    itinSave(plan);
    const c = itinChecks(items);
    list.querySelectorAll('.itin-warn').forEach(x => x.remove());
    list.querySelectorAll('.itin-edit-row').forEach(row => {
      const w = itinWarnBox(c, row.dataset.id);
      if (w) row.append(w);
    });
  };
  itinEachWithDays(plan, (it, i, day, newDay) => {
    if (newDay) list.append(itinDayHead(plan, day));
    const row = el('div', 'itin-edit-row itin-' + it.type);
    row.dataset.id = it.id;
    const fields = el('div', 'itin-fields');
    fields.append(el('span', 'itin-tag', ITIN_TYPES[it.type]));
    if (it.type === 'ride') {
      const link = el('a', 'memo-button itin-transit', '乗換案内で調べる');
      link.target = '_blank';
      link.rel = 'noopener';
      const updateLink = () => { link.href = itinTransitUrl(it.from || '', it.to || '', itinDate(plan, day), it.dep); };
      updateLink();
      fields.append(
        itinInput('time', it.dep, '', '出発時刻', v => { it.dep = v; updateLink(); changed(); }, 'itin-t'),
        el('span', '', '→'),
        itinInput('time', it.arr, '', '到着時刻', v => { it.arr = v; changed(); }, 'itin-t'),
        itinInput('text', it.from, '乗る駅', '乗る駅', v => { it.from = v.trim(); it.fromU = nearestUnitByName(it.from, it.fromU) || null; updateLink(); changed(); }),
        el('span', '', '→'),
        itinInput('text', it.to, '降りる駅', '降りる駅', v => { it.to = v.trim(); it.toU = nearestUnitByName(it.to, it.fromU) || null; updateLink(); changed(); }),
        itinInput('text', it.line, '路線', '路線', v => { it.line = v; changed(); }),
        itinInput('text', it.train, '列車名（例: 快速 シーサイドライナー）', '列車名', v => { it.train = v; changed(); }),
        itinInput('text', it.note, 'メモ', 'メモ', v => { it.note = v; changed(); }, 'itin-wide'),
        link,
      );
    } else {
      fields.append(
        itinInput('time', it.start, '', it.type === 'stay' ? 'チェックイン' : '始まり', v => { it.start = v; changed(); }, 'itin-t'),
        el('span', '', '–'),
        itinInput('time', it.end, '', '終わり', v => { it.end = v; changed(); }, 'itin-t'),
        itinInput('text', it.title, it.type === 'stay' ? '宿の名前' : it.type === 'meal' ? 'お店・食べるもの' : '名前', '名前', v => { it.title = v; changed(); }),
        itinInput('text', it.place, '場所', '場所', v => { it.place = v; changed(); }),
        itinInput('text', it.note, 'メモ', 'メモ', v => { it.note = v; changed(); }, 'itin-wide'),
      );
      if (it.type === 'stay') fields.append(el('span', 'muted itin-hint', '（この後は次の日になります）'));
    }
    row.append(fields);

    // 動かす・消す・この後に足す
    const ctl = el('div', 'itin-row-ctl itin-controls');
    const mk = (text, title, fn, disabled) => {
      const b = el('button', 'memo-button', text);
      b.type = 'button';
      b.title = title;
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      return b;
    };
    ctl.append(
      mk('↑', '上へ', () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; itinSave(plan); renderItinBody(body, plan); }, i === 0),
      mk('↓', '下へ', () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; itinSave(plan); renderItinBody(body, plan); }, i === items.length - 1),
      mk('✕', '消す', () => { items.splice(i, 1); itinSave(plan); renderItinBody(body, plan); itinRefreshTitle(body, plan); }),
    );
    const sel = el('select', 'itin-insert');
    sel.setAttribute('aria-label', 'この後に予定を足す');
    sel.append(new Option('＋この後に足す…', ''));
    for (const [type, label] of Object.entries(ITIN_TYPES)) sel.append(new Option(label, type));
    sel.addEventListener('change', () => { if (sel.value) itinInsert(body, plan, i + 1, sel.value); });
    ctl.append(sel);
    row.append(ctl);
    const w = itinWarnBox(checks, it.id);
    if (w) row.append(w);
    list.append(row);
  });
}

// ---------- 印刷 ----------

// 行程表だけを印刷する（見る表示にしてから）
function itinPrint(body, plan) {
  itinMode.set(plan.id, 'view');
  renderItinBody(body, plan);
  const target = body.closest('.itin');
  target.classList.add('itin-print-target');
  document.body.classList.add('itin-printing');
  const head = el('div', 'itin-print-head');
  head.append(el('h2', '', plan.name), el('p', '', `${formatPlanDate(plan.date)} 出発` + (plan.summary ? `　${plan.summary}` : '')));   // plans.js
  target.prepend(head);
  const done = () => {
    document.body.classList.remove('itin-printing');
    target.classList.remove('itin-print-target');
    head.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000);   // afterprint が来ないブラウザ向け
}
