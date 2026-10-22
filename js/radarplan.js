// ============================================================
// レーダー圏の計算（F9 の計算部分）
//
// 駅メモのレーダーは「いる場所から近い順に n 駅」を取る、という前提で、
// 未アクセスの駅を一番多く取れる立ち位置を探す。
//
// 1. 立つ場所の候補を作る：選んだ都道府県の駅と、線路の上（駅と駅のあいだを約1kmごと）
// 2. 候補ごとに、近い n 駅を求める（アクセス済みの駅も n 駅のうちに数える）
// 3. 未アクセスの駅が一番多く入る候補を選び、その駅を「取れた」として除いて、また選ぶ
//    （これを、おすすめする地点の数だけ繰り返す）
// ============================================================

const RADAR_STEP_KM = 1.0;        // 線路の上の候補を置く間隔
const RADAR_CELL_DEG = 0.1;       // 近い駅を速く探すためのマス目の大きさ（約10km）

let radarIndexCache = null;

// 2地点の距離（km）
function radarDistKm(lat1, lon1, lat2, lon2) {
  const dy = (lat1 - lat2) * 111.0;
  const dx = (lon1 - lon2) * 111.32 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

// 全部の駅メモの駅を、マス目に分けて入れておく（近い駅を速く探すため）
function radarIndex() {
  if (radarIndexCache) return radarIndexCache;
  const cells = new Map();
  const key = (i, j) => i + ',' + j;
  for (const [u, unit] of Object.entries(MASTER.units)) {
    const i = Math.floor(unit.lat / RADAR_CELL_DEG), j = Math.floor(unit.lon / RADAR_CELL_DEG);
    const k = key(i, j);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(u);
  }
  radarIndexCache = { cells, key };
  return radarIndexCache;
}

// 地点 (lat, lon) から近い順に n 駅。戻り値: [{ u, d }]（近い順）
function radarNearest(lat, lon, n) {
  const { cells, key } = radarIndex();
  const ci = Math.floor(lat / RADAR_CELL_DEG), cj = Math.floor(lon / RADAR_CELL_DEG);
  const found = [];
  // 自分のマスから、まわりのマスへ少しずつ広げて探す
  for (let r = 0; r < 60; r++) {
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;   // 外周のマスだけ
        const list = cells.get(key(i, j));
        if (!list) continue;
        for (const u of list) {
          const unit = MASTER.units[u];
          found.push({ u, d: radarDistKm(lat, lon, unit.lat, unit.lon) });
        }
      }
    }
    // n 駅見つかり、まだ見ていないマスの駅がそれより遠いことが確かなら終わり
    if (found.length >= n) {
      found.sort((a, b) => a.d - b.d);
      const safeKm = r * RADAR_CELL_DEG * 111.32 * Math.cos(lat * Math.PI / 180);
      if (found[n - 1].d <= safeKm) return found.slice(0, n);
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, n);
}

// 立つ場所の候補（選んだ都道府県の駅と、線路の上の地点）
function radarCandidates(prefs) {
  const list = [];
  for (const [u, unit] of Object.entries(MASTER.units)) {
    if (prefs.has(unit.pref)) list.push({ lat: unit.lat, lon: unit.lon, kind: 'station', u });
  }
  const seen = new Set();
  for (const [lc, pairs] of Object.entries(MASTER.joins)) {
    for (const [a, b] of pairs) {
      const sa = MASTER.stations[a], sb = MASTER.stations[b];
      if (!sa || !sb || sa.u === sb.u) continue;
      if (!prefs.has(MASTER.units[sa.u].pref) && !prefs.has(MASTER.units[sb.u].pref)) continue;
      const pairKey = sa.u < sb.u ? sa.u + '|' + sb.u : sb.u + '|' + sa.u;
      if (seen.has(pairKey)) continue;   // 同じ区間を何度も入れない（並行する路線など）
      seen.add(pairKey);
      const len = radarDistKm(sa.lat, sa.lon, sb.lat, sb.lon);
      const steps = Math.floor(len / RADAR_STEP_KM);
      for (let s = 1; s <= steps; s++) {
        const t = s / (steps + 1);
        list.push({ lat: sa.lat + (sb.lat - sa.lat) * t, lon: sa.lon + (sb.lon - sa.lon) * t, kind: 'line', line: lc, a: sa.u, b: sb.u, t });
      }
    }
  }
  return list;
}

// おすすめの立ち位置を求める。
//   prefs : 都道府県の Set、n : レーダーの駅数、count : おすすめする地点の数
//   isTarget(u) : 取りたい駅（未アクセス）なら true
// 戻り値: { picks: [{ point, nearest, gained: [駅], radiusKm }], targetCount, candidateCount }
function planRadar(prefs, n, count, isTarget) {
  const cands = radarCandidates(prefs);
  // 候補ごとに、近い n 駅と、その中の取りたい駅
  for (const c of cands) {
    c.nearest = radarNearest(c.lat, c.lon, n);
    c.targets = c.nearest.filter(x => isTarget(x.u)).map(x => x.u);
    c.radiusKm = c.nearest.length ? c.nearest[c.nearest.length - 1].d : 0;
  }
  const allTargets = new Set();
  for (const c of cands) for (const u of c.targets) if (prefs.has(MASTER.units[u].pref)) allTargets.add(u);

  const gotten = new Set();
  const picks = [];
  for (let k = 0; k < count; k++) {
    let best = null, bestScore = 0;
    for (const c of cands) {
      let score = 0;
      for (const u of c.targets) if (!gotten.has(u)) score++;
      // 同じ数なら、届く範囲が狭い（駅が集まっている）ほうを選ぶ
      if (score > bestScore || (score === bestScore && score > 0 && c.radiusKm < best.radiusKm)) { best = c; bestScore = score; }
    }
    if (!best) break;
    const gained = best.targets.filter(u => !gotten.has(u));
    gained.forEach(u => gotten.add(u));
    picks.push({ point: best, nearest: best.nearest, gained, radiusKm: best.radiusKm });
  }
  return { picks, targetCount: allTargets.size, gottenCount: gotten.size, candidateCount: cands.length };
}
