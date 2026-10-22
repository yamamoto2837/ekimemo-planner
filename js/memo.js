// ============================================================
// メモ（路線ごと・駅ごと）
//
// 保存はブラウザの中（IndexedDB の 'memos'）。
// あとでデバイス間の共有（GitHub）に使えるよう、次のように持つ。
//   ・1件ごとに「最後に書き換えた日時（updatedAt）」を持つ → 共有のとき新しいほうを残せる
//   ・消したメモも「空の文字」として残す → ほかのデバイスにも消したことが伝わる
//   ・路線名・駅名も一緒に持つ → 駅マスタが変わって番号が合わなくなっても、どのメモかわかる
//
// 中身の形:
// { version: 1, updatedAt: '日時',
//   lines:    { 路線コード:       { text, name, updatedAt } },
//   stations: { 駅メモの駅の番号: { text, name, updatedAt } } }
// ============================================================

const MEMO_KEY = 'memos';
const MEMO_MAX_LENGTH = 2000;    // 1件の長さの上限（文字）
const MEMO_SAVE_DELAY = 500;     // 打ち終わってから保存するまでの待ち時間（ミリ秒）

let memoData = emptyMemoData();
let memoSaveTimer = null;
let memoSaveCallbacks = [];      // 保存が終わったら知らせる先
let memoChanged = false;         // 前に保存してから書き換わったか（共有で送るかどうかに使う）

function emptyMemoData() {
  return { version: 1, updatedAt: null, lines: {}, stations: {} };
}

// ---------- 読み込み（app.js から呼ばれる） ----------

async function loadMemos() {
  try {
    const saved = await loadValue(MEMO_KEY);
    if (saved && saved.version === 1) memoData = saved;
  } catch (e) {
    console.warn('メモを読めませんでした', e);
  }
}

// ---------- 読む・書く ----------

function memoStore(kind) {
  return kind === 'line' ? memoData.lines : memoData.stations;
}

// メモの文字（無ければ空の文字）
function getMemo(kind, key) {
  const m = memoStore(kind)[key];
  return m ? m.text : '';
}
function lineMemo(lineCd) { return getMemo('line', lineCd); }
function stationMemo(unitId) { return getMemo('station', unitId); }

// メモを書き換える。保存は少し待ってからまとめて行う。
// done(ok) … 保存が終わったときに呼ばれる（ok が false なら保存できなかった）
function setMemo(kind, key, text, name, done) {
  const store = memoStore(kind);
  const old = store[key];
  if (done) memoSaveCallbacks.push(done);
  if ((!old && text === '') || (old && old.text === text)) {
    scheduleMemoSave();
    return;
  }
  // 日時は「今」。ただし、デバイスの時計がずれていても書き直しが負けないよう、
  // それまでのメモの日時より必ず新しくする
  const oldTime = old ? Date.parse(old.updatedAt) || 0 : 0;
  const now = new Date(Math.max(Date.now(), oldTime + 1)).toISOString();
  store[key] = { text, name, updatedAt: now };
  if (!memoData.updatedAt || now > memoData.updatedAt) memoData.updatedAt = now;
  memoChanged = true;
  scheduleMemoSave();
}

function scheduleMemoSave() {
  clearTimeout(memoSaveTimer);
  memoSaveTimer = setTimeout(flushMemoSave, MEMO_SAVE_DELAY);
}

// 待たずに今すぐ保存する
async function flushMemoSave() {
  clearTimeout(memoSaveTimer);
  memoSaveTimer = null;
  const callbacks = memoSaveCallbacks;
  memoSaveCallbacks = [];
  const changed = memoChanged;
  memoChanged = false;
  let ok = true;
  try {
    await saveValue(MEMO_KEY, memoData);
  } catch (e) {
    ok = false;
    console.warn('メモを保存できませんでした', e);
  }
  callbacks.forEach(cb => cb(ok));
  if (typeof renderMemoList === 'function') renderMemoList();   // linedetail.js の一覧
  if (!ok) memoChanged = memoChanged || changed;   // 保存できなかったら、次にもう一度
  if (ok && changed && typeof scheduleSync === 'function') scheduleSync();   // sync.js：ほかのデバイスへ
}

// ---------- 共有（sync.js）から使う ----------

function getMemoData() {
  return memoData;
}

// ほかのデバイスとまとめた中身に入れ替えて保存する
async function replaceMemoData(data) {
  memoData = data;
  await saveValue(MEMO_KEY, memoData);
  renderMemoList();
}

// 画面を閉じたり、ほかのアプリに切り替えたりするときは、待たずに保存する
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && memoSaveTimer) flushMemoSave();
});
window.addEventListener('pagehide', () => { if (memoSaveTimer) flushMemoSave(); });

// 中身のあるメモの一覧（新しい順）
function memoEntries(kind) {
  return Object.entries(memoStore(kind))
    .filter(([, m]) => m.text.trim() !== '')
    .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
}

// ---------- 書き込み欄（どの画面でも使う部品） ----------

// kind: 'line' か 'station'、key: 路線コードか駅メモの駅の番号、name: 路線名か駅名
function memoEditor(kind, key, name, labelText, placeholder) {
  const box = el('div', 'memo-editor');
  const label = el('label', 'memo-label');
  label.append(el('span', '', labelText));
  const status = el('span', 'memo-status');
  label.append(status);

  const textarea = el('textarea', 'memo-text');
  textarea.rows = 2;
  textarea.maxLength = MEMO_MAX_LENGTH;
  textarea.placeholder = placeholder || '';
  textarea.value = getMemo(kind, key);
  label.append(textarea);
  box.append(label);

  // 書いた量に合わせて欄の高さを変える
  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 2 + 'px';
  };
  textarea.addEventListener('input', () => {
    status.textContent = '保存中…';
    status.className = 'memo-status';
    setMemo(kind, key, textarea.value, name, ok => {
      status.textContent = ok ? '保存しました' : '保存できませんでした';
      status.className = 'memo-status ' + (ok ? 'good' : 'error');
    });
    grow();
  });
  // 画面に出てから高さを合わせる
  requestAnimationFrame(grow);
  return { box, textarea };
}

// 書いてあるメモを表示する部品（無ければ null）
function memoView(text) {
  if (!text || text.trim() === '') return null;
  return el('div', 'memo-view', text);
}
