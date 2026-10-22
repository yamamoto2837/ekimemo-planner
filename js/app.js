// ============================================================
// アプリ全体のまとめ役
//   ・駅マスタと、保存された進捗を持っておく（appState）
//   ・画面の切り替え（アドレスの # の後ろで決める）
//   ・進捗が変わったら、各画面を描き直す
// ============================================================

const MASTER = window.EKIMEMO_MASTER;

// アプリ全体で使う状態
const appState = {
  progress: null,   // 保存された進捗 { ids, importedAt, masterBuiltAt }
  resolved: null,   // 進捗を駅マスタに当てはめた結果（resolveProgress の戻り値）
};

const SCREENS = ['collect', 'line', 'pref', 'map', 'near', 'import'];

// 路線ごとの集計（progress.js の computeLineStats）。進捗が変わったときだけ作り直す。
let lineStatsCache = null;
let lineStatsFor = null;
function getLineStats() {
  if (!appState.resolved) return null;
  if (lineStatsFor !== appState.resolved) {
    lineStatsCache = computeLineStats(MASTER, appState.resolved.accessed);
    lineStatsFor = appState.resolved;
  }
  return lineStatsCache;
}

// 都道府県ごとの集計（progress.js の computePrefStats）。同じく進捗が変わったときだけ作り直す。
let prefStatsCache = null;
let prefStatsFor = null;
function getPrefStats() {
  if (!appState.resolved) return null;
  if (prefStatsFor !== appState.resolved) {
    prefStatsCache = computePrefStats(MASTER, appState.resolved.accessed);
    prefStatsFor = appState.resolved;
  }
  return prefStatsCache;
}

// 路線詳細へのリンク先（路線コードに記号や日本語が入ることがあるので変換する）
function lineHref(lineCd) {
  return '#line/' + encodeURIComponent(lineCd);
}

// 要素を作る小さな道具（文字は textContent で入れるので安全）
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// 進捗を差し替えて、関係する画面を描き直す
function setProgress(progress) {
  appState.progress = progress;
  appState.resolved = progress ? resolveProgress(progress.ids, MASTER) : null;
  renderSavedStatus();   // import.js
  renderCollect();       // collect.js
  renderLineDetail();    // linedetail.js（表示中の路線を描き直す）
  renderRegion();        // region.js
  fillMapLineOptions();  // map.js（路線の選択肢の「残り○駅」を更新）
  renderMap();           // map.js
  renderNear();          // near.js
}

// 画面の切り替え
function showScreen(name) {
  // 画面の指定が無いとき：進捗があれば先頭のタブ（地域別）、無ければ取り込み画面
  if (!SCREENS.includes(name)) name = appState.progress ? 'pref' : 'import';
  for (const s of SCREENS) document.getElementById(s).hidden = (s !== name);
  // メモが書き換わっているかもしれないので、メモを出す画面は開くたびに描き直す
  if (name === 'collect') renderCollect();
  if (name === 'near') renderNear();
  document.querySelectorAll('.tabs a').forEach(a => {
    if (a.dataset.screen === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}
// アドレスの # の後ろを読む。
// 例: #collect、#line/11101（路線詳細と路線コード）、#pref/13（地域別で東京都を開く）、
//     #map/pref/13（地図で東京都）、#map/line/11101（地図でその路線）
function showScreenFromHash() {
  const [name, ...rest] = location.hash.replace('#', '').split('/');
  if (name === 'map') {
    if (rest.length >= 2) setMapRoute(rest[0], decodeURIComponent(rest.slice(1).join('/')));
    showScreen(name);
    window.scrollTo(0, 0);
    onMapShown();   // 地図は表示されてから大きさを測る
    return;
  }
  if (name === 'line' && rest.length > 0) {
    renderLineDetail(decodeURIComponent(rest.join('/')));
  }
  if (name === 'pref') {
    // 県を開いたり閉じたりするときは、見ている位置を動かさない
    selectPref(rest.length > 0 ? Number(rest[0]) : null);
    showScreen(name);
    return;
  }
  showScreen(name);
  window.scrollTo(0, 0);
}

async function startApp() {
  if (!MASTER) {
    document.querySelector('.app-main').replaceChildren(
      el('p', 'message error', '駅マスタ（master/master.js）を読み込めませんでした。'));
    return;
  }
  document.getElementById('masterInfo').textContent =
    `駅マスタ: ${MASTER.builtAt} 作成（全 ${Object.keys(MASTER.units).length} 駅）`;

  initImportScreen();    // import.js
  initCollectScreen();   // collect.js
  initLineScreen();      // linedetail.js
  initRegionScreen();    // region.js
  initMapScreen();       // map.js
  initNearScreen();      // near.js

  // メモは進捗が無くても使えるので、先に読み込む（memo.js）
  await loadMemos();
  renderMemoList();

  let progress = null;
  try {
    progress = await loadProgress();
  } catch (e) {
    document.getElementById('savedStatus').replaceChildren(
      el('p', 'message error', '保存された進捗を読めませんでした: ' + e.message));
  }
  setProgress(progress);

  window.addEventListener('hashchange', showScreenFromHash);
  showScreenFromHash();
}

// ほかの js ファイルを全部読み込んでから始める
document.addEventListener('DOMContentLoaded', startApp);
