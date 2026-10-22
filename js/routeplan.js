// ============================================================
// 巡回順序の計算（F7 の計算部分）
//
// 1. 線路のつながり（グラフ）を作る
//    ・点 = 駅メモの駅、線 = 接続駅データの隣り合う駅（長さ = 駅間の距離 km）
//    ・同じ駅グループの駅（京成上野と上野など）は、短い乗り換え（0.2km）でつなぐ
//    ・線路のデータが無い駅（新幹線だけの駅など）は、近い駅に「推定」でつなぐ
// 2. 回る駅どうしの「線路に沿った距離」を、ダイクストラ法で求める
// 3. いちばん近い駅へ順に進む方法（最近傍法）で仮の順番を作り、
//    2-opt法（順番の一部を逆にして短くなるか試す）で良くする
// 乗り換え時間や運行本数は考えない（要件定義書の方針）。
// ============================================================

const ROUTE_TRANSFER_KM = 0.2;     // 同じ駅グループの乗り換えの長さ
const ROUTE_GUESS_RATE = 1.3;      // 推定でつなぐときに、直線距離に掛ける倍率
const ROUTE_GUESS_LINKS = 2;       // 推定でつなぐ相手の数
const ROUTE_TWO_OPT_PASSES = 60;   // 2-opt を繰り返す回数の上限

let routeGraphCache = null;

// 2つの地点の距離（km）。日本の範囲なら、この簡単な計算で十分
function routeDistKm(a, b) {
  const dy = (a.lat - b.lat) * 111.0;
  const dx = (a.lon - b.lon) * 111.32 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------- 1. 線路のつながり ----------

function routeGraph() {
  if (routeGraphCache) return routeGraphCache;

  const adj = new Map();   // 駅メモの駅 → Map(となりの駅 → { w: 長さ, line: 路線コード })
  const add = (a, b, w, line) => {
    if (a === b) return;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!adj.has(x)) adj.set(x, new Map());
      const old = adj.get(x).get(y);
      if (!old || w < old.w) adj.get(x).set(y, { w, line });
    }
  };

  // 接続駅データ（隣り合う駅）
  for (const [lc, pairs] of Object.entries(MASTER.joins)) {
    for (const [a, b] of pairs) {
      const sa = MASTER.stations[a], sb = MASTER.stations[b];
      if (sa && sb) add(sa.u, sb.u, routeDistKm(sa, sb), lc);
    }
  }
  // 同じ駅グループどうしの乗り換え
  const byGroup = new Map();
  for (const s of Object.values(MASTER.stations)) {
    if (!byGroup.has(s.g)) byGroup.set(s.g, new Set());
    byGroup.get(s.g).add(s.u);
  }
  for (const set of byGroup.values()) {
    const arr = [...set];
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) add(arr[i], arr[j], ROUTE_TRANSFER_KM, 'transfer');
  }
  // 線路のデータが無い行ける駅は、近い駅に推定でつなぐ
  const linked = [...adj.keys()];
  for (const [u, unit] of Object.entries(MASTER.units)) {
    if (unit.closed || adj.has(u)) continue;
    const near = linked.map(v => ({ v, d: routeDistKm(unit, MASTER.units[v]) }))
      .sort((a, b) => a.d - b.d).slice(0, ROUTE_GUESS_LINKS);
    for (const n of near) add(u, n.v, n.d * ROUTE_GUESS_RATE, 'guess');
  }

  // 速く計算できるよう、番号の並び（CSR 形式）にする
  const ids = [...adj.keys()];
  const index = new Map(ids.map((u, i) => [u, i]));
  const start = new Int32Array(ids.length + 1);
  ids.forEach((u, i) => { start[i + 1] = start[i] + adj.get(u).size; });
  const to = new Int32Array(start[ids.length]);
  const weight = new Float64Array(start[ids.length]);
  const line = new Array(start[ids.length]);
  ids.forEach((u, i) => {
    let k = start[i];
    for (const [v, e] of adj.get(u)) { to[k] = index.get(v); weight[k] = e.w; line[k] = e.line; k++; }
  });
  routeGraphCache = { ids, index, start, to, weight, line };
  return routeGraphCache;
}

// ---------- 2. 線路に沿った距離（ダイクストラ法） ----------

function routeDijkstra(g, src) {
  const n = g.ids.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevEdge = new Int32Array(n).fill(-1);
  const prevNode = new Int32Array(n).fill(-1);
  dist[src] = 0;
  // 小さい順に取り出せる入れ物（二分ヒープ）
  const heapNode = [src], heapDist = [0];
  const push = (v, d) => {
    let i = heapNode.length; heapNode.push(v); heapDist.push(d);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapDist[p] <= heapDist[i]) break;
      [heapNode[p], heapNode[i]] = [heapNode[i], heapNode[p]];
      [heapDist[p], heapDist[i]] = [heapDist[i], heapDist[p]];
      i = p;
    }
  };
  const pop = () => {
    const v = heapNode[0], d = heapDist[0];
    const lastN = heapNode.pop(), lastD = heapDist.pop();
    if (heapNode.length > 0) {
      heapNode[0] = lastN; heapDist[0] = lastD;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heapNode.length && heapDist[l] < heapDist[m]) m = l;
        if (r < heapNode.length && heapDist[r] < heapDist[m]) m = r;
        if (m === i) break;
        [heapNode[m], heapNode[i]] = [heapNode[i], heapNode[m]];
        [heapDist[m], heapDist[i]] = [heapDist[i], heapDist[m]];
        i = m;
      }
    }
    return [v, d];
  };
  while (heapNode.length > 0) {
    const [v, d] = pop();
    if (d > dist[v]) continue;
    for (let k = g.start[v]; k < g.start[v + 1]; k++) {
      const w = g.to[k], nd = d + g.weight[k];
      if (nd < dist[w]) { dist[w] = nd; prevEdge[w] = k; prevNode[w] = v; push(w, nd); }
    }
  }
  return { dist, prevEdge, prevNode };
}

// ---------- 3. 順番を決める ----------

// 並び order の長さ（round が true なら最後から最初へ戻る分も足す）
function routeLength(order, D, round) {
  let sum = 0;
  for (let i = 0; i + 1 < order.length; i++) sum += D[order[i]][order[i + 1]];
  if (round && order.length > 1) sum += D[order[order.length - 1]][order[0]];
  return sum;
}

// 最近傍法：from から始めて、まだ回っていない中で一番近い駅へ進む
function routeNearest(from, m, D) {
  const used = new Uint8Array(m);
  const order = [from];
  used[from] = 1;
  for (let step = 1; step < m; step++) {
    const last = order[order.length - 1];
    let best = -1, bestD = Infinity;
    for (let j = 0; j < m; j++) if (!used[j] && D[last][j] < bestD) { bestD = D[last][j]; best = j; }
    used[best] = 1;
    order.push(best);
  }
  return order;
}

// 2-opt法：order の i〜j を逆向きにして短くなるなら入れ替える。fixFirst なら先頭は動かさない
function routeTwoOpt(order, D, round, fixFirst) {
  const n = order.length;
  const at = (i) => (i < 0 || i >= n) ? -1 : order[i];
  const d = (a, b) => (a < 0 || b < 0) ? 0 : D[a][b];
  for (let pass = 0; pass < ROUTE_TWO_OPT_PASSES; pass++) {
    let improved = false;
    for (let i = fixFirst ? 1 : 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = at(i - 1), b = order[i], c = order[j];
        // 戻ってくるときは、最後の駅の次は最初の駅
        const e = (j + 1 < n) ? order[j + 1] : (round ? order[0] : -1);
        if (round && i === 0) continue;   // 戻ってくるときは、出発駅（先頭）を動かさない
        const delta = d(a, c) + d(b, e) - d(a, b) - d(c, e);
        if (delta < -1e-9) {
          for (let x = i, y = j; x < y; x++, y--) [order[x], order[y]] = [order[y], order[x]];
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return order;
}

// 回る順番を計算する。
//   targets : 回る駅（駅メモの駅の番号）の一覧
//   startUnit : 出発する駅（無ければ null）
//   round : 出発駅に戻ってくるか
// 戻り値: { order: [駅], legs: [区間], totalKm, unreachable: [駅], guessed: [駅] }
function planRoute(targets, startUnit, round) {
  const g = routeGraph();
  // 点の一覧（出発駅があれば先頭に置く）
  const points = [];
  if (startUnit) points.push(startUnit);
  for (const u of targets) if (u !== startUnit && g.index.has(u)) points.push(u);
  const missing = targets.filter(u => !g.index.has(u));

  // 点どうしの線路に沿った距離
  const m = points.length;
  const D = [];
  for (let i = 0; i < m; i++) {
    const r = routeDijkstra(g, g.index.get(points[i]));
    D.push(points.map(u => r.dist[g.index.get(u)]));
  }
  // つながっていない駅を外す（最初の点から行けない駅）
  const reach = [];
  const unreachable = [...missing];
  for (let i = 0; i < m; i++) (isFinite(D[0][i]) ? reach : unreachable).push(i);
  const P = reach.map(i => points[i]);
  const DD = reach.map(i => reach.map(j => D[i][j]));
  const k = P.length;
  if (k === 0) return { order: [], legs: [], totalKm: 0, unreachable: unreachable.map(i => typeof i === 'number' ? points[i] : i), guessed: [] };

  // 順番を決める
  let best = null, bestLen = Infinity;
  const tryFrom = (startIdx, fixFirst) => {
    const order = routeTwoOpt(routeNearest(startIdx, k, DD), DD, round, fixFirst);
    const len = routeLength(order, DD, round);
    if (len < bestLen) { bestLen = len; best = order; }
  };
  if (startUnit) {
    tryFrom(0, true);
  } else {
    // 出発駅が決まっていなければ、いろいろな駅から始めて一番短いものを選ぶ（多いときは間引く）
    const step = Math.max(1, Math.floor(k / 40));
    for (let s = 0; s < k; s += step) tryFrom(s, round);
  }
  if (round && best.length > 1) best.push(best[0]);   // 最後に出発駅へ戻る

  // 区間ごとに、通る駅と乗る路線を求める
  const orderUnits = best.map(i => P[i]);
  const legs = [];
  const guessed = new Set();
  for (let i = 0; i + 1 < orderUnits.length; i++) {
    const from = g.index.get(orderUnits[i]), toIdx = g.index.get(orderUnits[i + 1]);
    const r = routeDijkstra(g, from);
    const edges = [];
    for (let v = toIdx; v !== from; v = r.prevNode[v]) edges.push({ node: v, prev: r.prevNode[v], line: g.line[r.prevEdge[v]], w: g.weight[r.prevEdge[v]] });
    edges.reverse();
    // 同じ路線が続くところは1つにまとめる
    const rides = [];
    for (const e of edges) {
      if (e.line === 'guess') { guessed.add(g.ids[e.node]); guessed.add(g.ids[e.prev]); }
      const last = rides[rides.length - 1];
      if (last && last.line === e.line) { last.to = g.ids[e.node]; last.km += e.w; last.path.push(g.ids[e.node]); }
      else rides.push({ line: e.line, from: g.ids[e.prev], to: g.ids[e.node], km: e.w, path: [g.ids[e.prev], g.ids[e.node]] });
    }
    legs.push({ from: orderUnits[i], to: orderUnits[i + 1], km: r.dist[toIdx], rides });
  }
  return {
    order: orderUnits,
    legs,
    totalKm: legs.reduce((s, l) => s + l.km, 0),
    unreachable: unreachable.map(i => typeof i === 'number' ? points[i] : i),
    guessed: [...guessed],
  };
}
