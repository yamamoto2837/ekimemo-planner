// ============================================================
// データ取り込み画面（F1）
//
// 1. 貼り付けた文字列を「読み込む」で確認する（まだ保存しない）
// 2. 結果を見て「この内容で保存する」で保存する
// ============================================================

let pendingIds = null;      // 読み込んだが、まだ保存していないID

// ---------- 小さな道具 ----------

// 数字のカード
function card(value, label, isMain) {
  const c = el('div', isMain ? 'card main' : 'card');
  c.append(el('b', '', String(value)), el('span', '', label));
  return c;
}

function showMessage(target, text, kind) {
  target.textContent = text;
  target.className = 'message' + (kind ? ' ' + kind : '');
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------- 保存されている進捗の表示 ----------

function renderSavedStatus() {
  const box = document.getElementById('savedStatus');
  box.replaceChildren();
  if (!appState.progress) {
    box.append(el('p', 'muted', 'まだ進捗が保存されていません。下の欄にエクスポート文字列を貼り付けてください。'));
    return;
  }
  const r = appState.resolved;
  box.append(el('h3', '', `いま保存されている進捗（${formatDate(appState.progress.importedAt)} に取り込み）`));
  const cards = el('div', 'cards');
  cards.append(
    card(formatRate(r.accessed.size, r.totalStations), '達成率', true),
    card(r.accessed.size, 'アクセス済みの駅'),
    card(r.remaining, '残りの駅'),
    card(r.totalStations, '全駅'),
  );
  box.append(cards);
}

// ---------- 読み込み ----------

function readExport() {
  const readMessage = document.getElementById('readMessage');
  const resultPanel = document.getElementById('resultPanel');
  document.getElementById('saveMessage').textContent = '';

  const parsed = parseExportText(document.getElementById('exportText').value);
  if (parsed.error) {
    showMessage(readMessage, parsed.error, 'error');
    resultPanel.hidden = true;
    pendingIds = null;
    return;
  }
  pendingIds = parsed.ids;
  const r = resolveProgress(parsed.ids, MASTER);
  showMessage(readMessage, `${r.idCount} 件のIDを読み込みました。内容を確かめてから保存してください。`, 'good');
  renderResult(r);
}

function renderResult(r) {
  // 数字のカード
  document.getElementById('resultCards').replaceChildren(
    card(formatRate(r.accessed.size, r.totalStations), '達成率', true),
    card(r.accessed.size, 'アクセス済みの駅'),
    card(r.remaining, '残りの駅'),
    card(r.idCount, '読み込んだID'),
    card(r.unknownIds.length, 'マスタに無いID'),
  );

  // 補足（対応表での読み替え・重複）
  const diffBox = document.getElementById('diffBox');
  diffBox.replaceChildren();
  if (r.viaAlias > 0) diffBox.append(el('p', 'help', `古い番号など ${r.viaAlias} 件は、対応表で今の駅に読み替えました。`));
  if (r.duplicateIds > 0) diffBox.append(el('p', 'help', `同じIDが ${r.duplicateIds} 件重なっていたので、1つとして数えました。`));
  if (r.sameStation > 0) diffBox.append(el('p', 'help', `${r.sameStation} 件は、別のIDと同じ駅に当たったため、1駅として数えました。`));

  // 前回保存した内容との比べ
  if (appState.resolved) {
    const before = appState.resolved.accessed;
    const added = [...r.accessed].filter(u => !before.has(u));
    const lost = [...before].filter(u => !r.accessed.has(u));

    diffBox.append(el('h4', '', '前回の取り込みとの比べ'));
    if (added.length === 0 && lost.length === 0) {
      diffBox.append(el('p', 'help', '前回保存した内容と同じです。'));
    }
    if (added.length > 0) {
      const p = el('p', '');
      p.append(el('span', 'plus', `＋${added.length} 駅`), document.createTextNode(' 新しくアクセスした駅'));
      const list = el('ul', 'station-list');
      added.map(u => stationLabel(u, MASTER)).sort((a, b) => a.localeCompare(b, 'ja'))
        .forEach(name => list.append(el('li', '', name)));
      diffBox.append(p, list);
    }
    if (lost.length > 0) {
      diffBox.append(el('p', 'notice',
        `前回はアクセス済みだった ${lost.length} 駅が、今回の文字列には入っていません。` +
        '貼り付けた文字列が最新のものか、途中で切れていないか確かめてください。'));
    }
  }

  // マスタに無いID（要件定義書の指定により、必ず表示する）
  const unknownBox = document.getElementById('unknownBox');
  unknownBox.replaceChildren();
  if (r.unknownIds.length === 0) {
    unknownBox.append(el('p', '', 'ありません。全部のIDを駅として読めました。'));
  } else {
    unknownBox.append(
      el('p', 'notice', `${r.unknownIds.length} 件のIDが駅マスタにありません。駅マスタが古いか、対応表（data/id_alias.csv）に足りない番号があります。`),
      el('div', 'id-list', r.unknownIds.join(', ')),
    );
  }

  document.getElementById('saveButton').disabled = false;
  document.getElementById('resultPanel').hidden = false;
}

// ---------- 保存 ----------

async function savePending() {
  if (!pendingIds) return;
  const saveButton = document.getElementById('saveButton');
  const saveMessage = document.getElementById('saveMessage');
  saveButton.disabled = true;
  const progress = {
    ids: pendingIds,
    importedAt: new Date().toISOString(),
    masterBuiltAt: MASTER.builtAt,
  };
  try {
    await saveProgress(progress);
    pendingIds = null;
    setProgress(progress);   // app.js：ほかの画面も描き直す
    saveMessage.replaceChildren(document.createTextNode('保存しました。'));
    const link = el('a', '', '取りこぼし回収リストを見る');
    link.href = '#collect';
    saveMessage.append(' ', link);
    saveMessage.className = 'message good';
  } catch (e) {
    saveButton.disabled = false;
    showMessage(saveMessage, '保存できませんでした: ' + e.message, 'error');
  }
}

// ---------- 準備（app.js から呼ばれる） ----------

function initImportScreen() {
  document.getElementById('readButton').addEventListener('click', readExport);
  document.getElementById('clearButton').addEventListener('click', () => {
    const t = document.getElementById('exportText');
    t.value = '';
    t.focus();
  });
  document.getElementById('saveButton').addEventListener('click', savePending);
}
