// ============================================================
// 進捗の保存（ブラウザの中の IndexedDB を使う）
//
// 保存するのは、エクスポートのID（駅メモマップ2の番号）そのもの。
// 駅マスタを更新しても、保存したIDから読み直せるようにするため。
// ============================================================

const DB_NAME = 'ekimemo-planner';   // データベースの名前
const DB_VERSION = 1;
const STORE_NAME = 'progress';       // 進捗を入れる場所
const PROGRESS_KEY = 'current';      // 最新の進捗を入れるときの名前

// データベースを開く（初めてのときは作る）
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('このブラウザでは保存機能（IndexedDB）が使えません。'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 保存されている進捗を読む。無ければ null を返す。
// 中身: { ids: [...], importedAt: '日時', masterBuiltAt: '駅マスタの作成日時' }
async function loadProgress() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(PROGRESS_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

// 進捗を保存する（前の内容は上書きされる）
async function saveProgress(progress) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(progress, PROGRESS_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
