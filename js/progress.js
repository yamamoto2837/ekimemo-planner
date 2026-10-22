// ============================================================
// エクスポート文字列の読み取りと、駅マスタへの当てはめ
// （取り込み画面のほか、この先の一覧・地図の画面でも使う）
// ============================================================

// オブジェクトが、その名前の項目を「自分で」持っているか調べる。
// （"constructor" のような名前のIDが紛れ込んでも誤動作しないように）
function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// エクスポート文字列を読み取って、IDの一覧にする。
// 成功: { ids: ['1132609', ...] }　失敗: { error: '理由' }
function parseExportText(text) {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { error: '貼り付け欄が空です。駅メモマップ2のエクスポート文字列を貼り付けてください。' };
  }
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    return { error: '文字列を読み取れませんでした。最初の [ から最後の ] まで、欠けずに貼り付けたか確認してください。' };
  }
  if (!Array.isArray(data)) {
    return { error: '形式が違います。駅メモマップ2のエクスポート文字列は [ で始まり ] で終わります。' };
  }
  return { ids: data.map(v => String(v).trim()) };
}

// IDを1つ、駅マスタの駅コードに読み替える。見つからなければ null。
// 対応表（aliases）を先に見ること。駅データ.jp と同じ番号でも、
// 駅メモマップ2では別の駅を指すものがあるため。読み替えは1回だけ。
function findStationCode(id, master) {
  if (hasKey(master.aliases, id) && hasKey(master.stations, master.aliases[id])) {
    return { cd: master.aliases[id], viaAlias: true };
  }
  if (hasKey(master.stations, id)) {
    return { cd: id, viaAlias: false };
  }
  return null;
}

// IDの一覧を駅マスタに当てはめて、「駅メモの駅」単位で数える。
function resolveProgress(ids, master) {
  const seenIds = new Set();       // 同じIDが2回出てきたら数えない
  const accessed = new Set();      // アクセス済みの「駅メモの駅」（units の番号）
  const unknownIds = [];           // マスタに無かったID
  let duplicateIds = 0;            // 同じIDの重複
  let viaAlias = 0;                // 対応表で読み替えた数
  let sameStation = 0;             // 別のIDが同じ駅に当たった数

  for (const id of ids) {
    if (seenIds.has(id)) { duplicateIds++; continue; }
    seenIds.add(id);

    const found = findStationCode(id, master);
    if (!found) { unknownIds.push(id); continue; }
    if (found.viaAlias) viaAlias++;

    const unitId = master.stations[found.cd].u;
    if (accessed.has(unitId)) sameStation++;
    accessed.add(unitId);
  }

  const totalStations = Object.keys(master.units).length;
  return {
    idCount: ids.length,
    duplicateIds,
    viaAlias,
    sameStation,
    unknownIds,
    accessed,
    totalStations,
    remaining: totalStations - accessed.size,
  };
}

// 路線ごとに、アクセス済み・残りの「駅メモの駅」を数える。
// 1つの路線に同じ駅メモの駅が2回出てくることはないよう、駅メモの駅単位でまとめる。
// 戻り値: 路線ごとの配列
//   { cd, name, closedLine, stations: [駅メモの駅の番号（路線の並び順）],
//     activeTotal, remainingActive: [...], remainingClosed: [...] }
function computeLineStats(master, accessed) {
  const result = [];
  for (const [cd, line] of Object.entries(master.lines)) {
    const seen = new Set();
    const stations = [];
    for (const sc of line.stations) {
      const u = master.stations[sc].u;
      if (!seen.has(u)) { seen.add(u); stations.push(u); }
    }
    const remainingActive = [];
    const remainingClosed = [];
    let activeTotal = 0;
    for (const u of stations) {
      const closed = master.units[u].closed;
      if (!closed) activeTotal++;
      if (accessed.has(u)) continue;
      (closed ? remainingClosed : remainingActive).push(u);
    }
    // remaining … 廃駅も含めた残り（路線の並び順）。駅メモでは廃駅も近くに行けば取れるので、基本はこちらを使う
    const remaining = stations.filter(u => !accessed.has(u));
    result.push({ cd, name: line.name, closedLine: line.closed, stations, activeTotal, remaining, remainingActive, remainingClosed });
  }
  return result;
}

// 都道府県ごとに、アクセス済み・残りの「駅メモの駅」を数える。
// 駅メモの駅の都道府県は、代表の駅（units の pref）で決める。
// 戻り値: 都道府県コード（1〜47）ごとの配列（0番は使わない）
//   { pref, total, done, remainingActive: [...], remainingClosed: [...] }
function computePrefStats(master, accessed) {
  const result = [];
  for (let p = 0; p <= 47; p++) {
    // remaining … 廃駅も含めた残り
    result.push({ pref: p, total: 0, done: 0, remaining: [], remainingActive: [], remainingClosed: [] });
  }
  for (const [u, unit] of Object.entries(master.units)) {
    const s = result[unit.pref];
    if (!s) continue;
    s.total++;
    if (accessed.has(u)) s.done++;
    else {
      s.remaining.push(u);
      (unit.closed ? s.remainingClosed : s.remainingActive).push(u);
    }
  }
  return result;
}

// 達成率を「67.3%」のような文字にする
function formatRate(done, total) {
  if (total === 0) return '0%';
  return (Math.floor(done / total * 1000) / 10).toFixed(1) + '%';
}

// 「駅メモの駅」の表示名（例: 大槌（三陸鉄道リアス線））
function stationLabel(unitId, master) {
  const unit = master.units[unitId];
  const firstStation = master.stations[unit.codes[0]];
  const line = master.lines[firstStation.line];
  return line ? `${unit.name}（${line.name}）` : unit.name;
}
