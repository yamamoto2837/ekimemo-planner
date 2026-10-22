// ============================================================
// デバイス間の共有（GitHub の非公開リポジトリ）
//
// 進捗とメモ・遠征プランを1つのファイル（ekimemo-sync.json）にまとめて、
// 非公開リポジトリに置く。各デバイスは次のときに、このファイルと中身をそろえる。
//   ・アプリを開いたとき、アプリに戻ってきたとき
//   ・進捗やメモを保存したとき（少し待ってから）
// 違う内容があったときのまとめ方：
//   ・メモ … 1件ごとに、新しく書き換えたほうを残す（消したメモも同じ）
//   ・進捗 … あとから取り込んだほうを残す
//
// 接続に使う「鍵（トークン）」は、このデバイスのブラウザ（localStorage）にだけ保存する。
// ============================================================

const SYNC_SETTINGS_KEY = 'ekimemo-sync-settings';
const SYNC_FILE = 'ekimemo-sync.json';
const SYNC_DELAY = 8000;          // 保存してから送るまでの待ち時間（ミリ秒）
const SYNC_RETRY = 3;             // ほかのデバイスと同時に送ったときに、やり直す回数

let syncSettings = null;          // { repo: 'ユーザー名/リポジトリ名', token: '…' }
let syncTimer = null;
let syncRunning = null;           // そろえている途中なら、その処理
const syncState = { lastSyncedAt: null, error: null, busy: false };

// ---------- 設定（このデバイスだけに保存） ----------

function loadSyncSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SYNC_SETTINGS_KEY));
    if (s && s.repo && s.token) syncSettings = s;
    const last = localStorage.getItem(SYNC_SETTINGS_KEY + '-last');
    if (last) syncState.lastSyncedAt = last;
  } catch (e) {
    syncSettings = null;
  }
}

function storeSyncSettings(s) {
  localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(s));
  syncSettings = s;
}

function clearSyncSettings() {
  try {
    localStorage.removeItem(SYNC_SETTINGS_KEY);
    localStorage.removeItem(SYNC_SETTINGS_KEY + '-last');
  } catch (e) { /* 消せなくても先へ進む */ }
  syncSettings = null;
  syncState.lastSyncedAt = null;
  syncState.error = null;
}

function syncEnabled() {
  return syncSettings !== null;
}

// ---------- GitHub とのやりとり ----------

async function githubRequest(path, token, options = {}) {
  let res;
  try {
    res = await fetch('https://api.github.com' + path, {
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      // ※ cache の指定は付けない（ブラウザが余分な情報を足し、GitHub に断られることがあるため）。
      //   古い内容を読まないよう、読むときはアドレスの後ろに日時を付ける（fetchRemoteSync）。
    });
  } catch (e) {
    throw new Error('GitHub につながりませんでした。インターネットにつながっているか確かめてください。');
  }
  return res;
}

// うまくいかなかったときの理由を、わかる言葉にする
function githubErrorMessage(res) {
  if (res.status === 401) return '鍵（トークン）が正しくないか、期限が切れています。新しい鍵を作って、接続し直してください。';
  if (res.status === 403) return '鍵の権限が足りません。鍵の設定で、Contents を「Read and write」にしてください。（しばらく時間をおくと直ることもあります）';
  if (res.status === 404) return 'リポジトリが見つかりません。リポジトリ名と、鍵で選んだリポジトリが合っているか確かめてください。';
  return `GitHub でうまくいきませんでした（番号 ${res.status}）。少し時間をおいて、もう一度試してください。`;
}

// 日本語を含む文字を、GitHub に送る形（base64）にする・戻す
function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

// リポジトリが使えるか確かめる（接続するとき）
async function checkSyncRepo(repo, token) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('リポジトリは「ユーザー名/リポジトリ名」の形で入れてください（例: yourname/ekimemo-data）。');
  }
  if (!token) throw new Error('鍵（トークン）を貼り付けてください。');
  const res = await githubRequest(`/repos/${repo}`, token);
  if (!res.ok) throw new Error(githubErrorMessage(res));
  const info = await res.json();
  if (!info.private) {
    throw new Error('このリポジトリは公開されています。進捗やメモが誰でも見られてしまうので、非公開（Private）のリポジトリを指定してください。');
  }
  if (info.permissions && info.permissions.push === false) {
    throw new Error('この鍵では、リポジトリに書き込めません。鍵の設定で、Contents を「Read and write」にしてください。');
  }
}

// GitHub にあるファイルを読む。無ければ data は null
async function fetchRemoteSync() {
  // 後ろの t=… は、ブラウザに残った古い内容を使わせないための目印
  const res = await githubRequest(`/repos/${syncSettings.repo}/contents/${SYNC_FILE}?t=${Date.now()}`, syncSettings.token);
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(githubErrorMessage(res));
  const file = await res.json();
  let data;
  try {
    data = JSON.parse(base64ToText(file.content));
  } catch (e) {
    throw new Error('GitHub にある共有ファイルを読み取れませんでした。');
  }
  if (!data || data.version !== 1) throw new Error('共有ファイルの形が、このアプリと合いません。');
  return { data, sha: file.sha };
}

// GitHub にファイルを書く。ほかのデバイスが先に書いていたら false
async function pushRemoteSync(payload, sha) {
  const body = {
    message: `進捗・メモをそろえる（${new Date().toLocaleString('ja-JP')}）`,
    content: textToBase64(JSON.stringify(payload, null, 1)),
  };
  if (sha) body.sha = sha;
  const res = await githubRequest(`/repos/${syncSettings.repo}/contents/${SYNC_FILE}`, syncSettings.token, { method: 'PUT', body });
  if (res.status === 409 || res.status === 422) return false;   // 先に書かれていた → 読み直してやり直す
  if (!res.ok) throw new Error(githubErrorMessage(res));
  return true;
}

// ---------- まとめ方 ----------

// メモ：1件ごとに、新しく書き換えたほうを残す
function mergeMemoData(local, remote) {
  if (!remote) return local;
  const out = emptyMemoData();
  for (const kind of ['lines', 'stations']) {
    const keys = new Set([...Object.keys(local[kind] || {}), ...Object.keys(remote[kind] || {})]);
    for (const k of keys) {
      const a = (local[kind] || {})[k];
      const b = (remote[kind] || {})[k];
      out[kind][k] = !a ? b : !b ? a : (b.updatedAt > a.updatedAt ? b : a);
    }
  }
  const times = [local.updatedAt, remote.updatedAt].filter(Boolean).sort();
  out.updatedAt = times.length ? times[times.length - 1] : null;
  return out;
}

// 進捗：あとから取り込んだほうを残す
function mergeProgressData(local, remote) {
  if (!remote) return local;
  if (!local) return remote;
  return remote.importedAt > local.importedAt ? remote : local;
}

// 中身が同じか（項目の並び順の違いは気にしない）
function stableText(value) {
  if (Array.isArray(value)) return '[' + value.map(stableText).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableText(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
function sameSyncContent(a, b) {
  return stableText({ p: a.progress || null, m: a.memos, n: a.plans || null }) === stableText({ p: b.progress || null, m: b.memos, n: b.plans || null });
}

// まとめた結果を、このデバイスに反映する
async function applyMergedSync(progress, memos, plans) {
  if (stableText(progress || null) !== stableText(appState.progress || null)) {
    await saveProgress(progress);
    setProgress(progress);   // app.js：画面を描き直す
  }
  if (stableText(memos) !== stableText(getMemoData())) {
    await replaceMemoData(memos);   // memo.js
    // メモを書いている途中なら、書き込み欄を壊さないよう描き直さない
    const editing = document.activeElement && document.activeElement.classList.contains('memo-text');
    if (!editing) renderLineDetail();
  }
  if (stableText(plans) !== stableText(getPlanData())) {
    await replacePlanData(plans);   // plans.js
  }
}

// ---------- そろえる ----------

// 今すぐそろえる。そろえている途中なら、その終わりを待つ
function syncNow() {
  if (!syncSettings) return Promise.resolve();
  if (syncRunning) return syncRunning;
  clearTimeout(syncTimer);
  syncTimer = null;
  syncState.busy = true;
  renderSyncStatus();

  syncRunning = (async () => {
    try {
      for (let attempt = 1; ; attempt++) {
        const remote = await fetchRemoteSync();
        const memos = mergeMemoData(getMemoData(), remote.data && remote.data.memos);
        const progress = mergeProgressData(appState.progress, remote.data && remote.data.progress);
        const plans = mergePlanData(getPlanData(), remote.data && remote.data.plans);   // plans.js：遠征プラン
        await applyMergedSync(progress, memos, plans);

        const payload = { version: 1, updatedAt: new Date().toISOString(), progress, memos, plans };
        if (remote.data && sameSyncContent(remote.data, payload)) break;   // 送る必要なし
        if (await pushRemoteSync(payload, remote.sha)) break;
        if (attempt >= SYNC_RETRY) {
          throw new Error('ほかのデバイスと同時にそろえようとしたため、送れませんでした。もう一度「今すぐそろえる」を押してください。');
        }
      }
      syncState.lastSyncedAt = new Date().toISOString();
      syncState.error = null;
      try { localStorage.setItem(SYNC_SETTINGS_KEY + '-last', syncState.lastSyncedAt); } catch (e) { /* 気にしない */ }
    } catch (e) {
      syncState.error = e.message;
    } finally {
      syncState.busy = false;
      syncRunning = null;
      renderSyncStatus();
    }
  })();
  return syncRunning;
}

// 少し待ってからそろえる（続けて書き換えたときに、何度も送らないように）
function scheduleSync() {
  if (!syncSettings) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, SYNC_DELAY);
}

// アプリに戻ってきたら読み直す。離れるときは、待たずに送る
document.addEventListener('visibilitychange', () => {
  if (!syncSettings) return;
  if (document.visibilityState === 'visible') {
    syncNow();
  } else {
    flushMemoSave().then(() => { if (syncTimer) syncNow(); });
  }
});

// ---------- 設定欄（データ取り込み画面） ----------

function initSyncScreen() {
  loadSyncSettings();
  document.getElementById('syncConnect').addEventListener('click', connectSync);
  document.getElementById('syncNowButton').addEventListener('click', () => syncNow());
  document.getElementById('syncDisconnect').addEventListener('click', () => {
    if (!confirm('このデバイスの接続をやめますか？（GitHub にある進捗とメモは消えません）')) return;
    clearSyncSettings();
    renderSyncStatus();
  });
  renderSyncStatus();
}

async function connectSync() {
  const repo = document.getElementById('syncRepo').value.trim();
  const tokenInput = document.getElementById('syncToken');
  const token = tokenInput.value.trim();
  const button = document.getElementById('syncConnect');
  const message = document.getElementById('syncMessage');
  button.disabled = true;
  message.className = 'message';
  message.textContent = '接続を確かめています…';
  try {
    await checkSyncRepo(repo, token);
    storeSyncSettings({ repo, token });
    tokenInput.value = '';
    message.textContent = '接続しました。進捗とメモをそろえています…';
    await syncNow();
    message.textContent = syncState.error ? '' : '接続しました。ほかのデバイスでも同じように接続すると、進捗とメモがそろいます。';
    message.className = 'message good';
  } catch (e) {
    message.textContent = e.message;
    message.className = 'message error';
  } finally {
    button.disabled = false;
    renderSyncStatus();
  }
}

function formatSyncTime(iso) {
  return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderSyncStatus() {
  const setup = document.getElementById('syncSetup');
  const connected = document.getElementById('syncConnected');
  const status = document.getElementById('syncStatus');
  const footer = document.getElementById('syncFooter');
  if (!setup) return;

  setup.hidden = syncEnabled();
  connected.hidden = !syncEnabled();
  document.getElementById('syncNowButton').disabled = syncState.busy;

  let text = '';
  let kind = 'muted';
  if (!syncEnabled()) {
    text = 'このデバイスは、まだ共有につながっていません。';
  } else {
    document.getElementById('syncRepoName').textContent = syncSettings.repo;
    if (syncState.busy) text = 'そろえています…';
    else if (syncState.error) { text = 'そろえられませんでした: ' + syncState.error; kind = 'message error'; }
    else if (syncState.lastSyncedAt) { text = `${formatSyncTime(syncState.lastSyncedAt)} にそろえました。`; kind = 'message good'; }
    else text = 'まだ一度もそろえていません。';
  }
  status.textContent = text;
  status.className = kind;
  footer.textContent = syncEnabled() ? '共有: ' + text : '';
}
