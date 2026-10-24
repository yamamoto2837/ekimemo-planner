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
  // 廃駅には接続駅データが無いので、路線の駅の並び順どおりに、となりの駅と直線でつなぐ
  // （駅メモでは廃駅も、近くに行けば取れる）。路線は「closed:路線コード」として区別する
  for (const [lc, line] of Object.entries(MASTER.lines)) {
    const order = [];
    for (const sc of line.stations) {
      const u = MASTER.stations[sc].u;
      if (order[order.length - 1] !== u) order.push(u);
    }
    for (let i = 0; i + 1 < order.length; i++) {
      const a = order[i], b = order[i + 1];
      if (!MASTER.units[a].closed && !MASTER.units[b].closed) continue;   // 現役どうしは接続駅データでつながっている
      if (adj.has(a) && adj.get(a).has(b)) continue;
      add(a, b, routeDistKm(MASTER.units[a], MASTER.units[b]) * ROUTE_GUESS_RATE, 'closed:' + lc);
    }
  }
  // それでも線路のデータが無い駅（新幹線だけの駅など）は、近い駅に推定でつなぐ
  const linked = [...adj.keys()];
  for (const [u, unit] of Object.entries(MASTER.units)) {
    if (adj.has(u)) continue;
    const near = linked.map(v => ({ v, d: routeDistKm(unit, MASTER.units[v]) }))
      .sort((a, b) => a.d - b.d).slice(0, ROUTE_GUESS_LINKS);
    for (const n of near) add(u, n.v, n.d * ROUTE_GUESS_RATE, 'guess');
  }
  // ほかの線路と一か所もつながっていない駅のかたまり（廃線だけの駅など）は、
  // いちばん大きなかたまりの、いちばん近い駅に推定でつなぐ（離れすぎている島などはつながない）
  linkIsolatedGroups(adj, add);

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

const ROUTE_ISOLATED_MAX_KM = 20;   // つながっていないかたまりを推定でつなぐ、いちばん遠い距離

// つながっている駅のかたまり（連結成分）を求め、小さいかたまりを大きいかたまりにつなぐ
function linkIsolatedGroups(adj, add) {
  const groupOf = new Map();
  const groups = [];
  for (const start of adj.keys()) {
    if (groupOf.has(start)) continue;
    const id = groups.length;
    const members = [start];
    groupOf.set(start, id);
    for (let k = 0; k < members.length; k++) {
      for (const v of adj.get(members[k]).keys()) {
        if (!groupOf.has(v)) { groupOf.set(v, id); members.push(v); }
      }
    }
    groups.push(members);
  }
  if (groups.length < 2) return;
  const mainId = groups.reduce((best, g, i) => g.length > groups[best].length ? i : best, 0);
  const main = groups[mainId];
  groups.forEach((g, i) => {
    if (i === mainId) return;
    // このかたまりの駅と、大きなかたまりの駅のうち、いちばん近い組を探す
    let best = null;
    for (const u of g) {
      const a = MASTER.units[u];
      for (const v of main) {
        const b = MASTER.units[v];
        if (Math.abs(a.lat - b.lat) > 0.2 || Math.abs(a.lon - b.lon) > 0.25) continue;   // 遠い駅は計算しない
        const d = routeDistKm(a, b);
        if (!best || d < best.d) best = { u, v, d };
      }
    }
    if (best && best.d <= ROUTE_ISOLATED_MAX_KM) add(best.u, best.v, best.d * ROUTE_GUESS_RATE, 'guess');
  });
}

// ---------- 2. 線路に沿った距離（ダイクストラ法） ----------

// target を渡すと、その駅までの道が決まった時点で探すのをやめる（速くなる）
// target が Set のときは、その中の駅すべての道が決まった時点でやめる
// weight を渡すと、線の長さの代わりにその重み（Float64Array）で考える（ルートの候補を出すとき）
function routeDijkstra(g, src, target, weight) {
  const W = weight || g.weight;
  let left = target instanceof Set ? new Set(target) : null;
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
    if (v === target) break;
    if (left && left.delete(v) && left.size === 0) break;
    for (let k = g.start[v]; k < g.start[v + 1]; k++) {
      const w = g.to[k], nd = d + W[k];
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
  const pointIdx = new Set(points.map(u => g.index.get(u)));
  for (let i = 0; i < m; i++) {
    const r = routeDijkstra(g, g.index.get(points[i]), pointIdx);   // 回る駅すべての距離が決まったらやめる
    D.push(points.map(u => r.dist[g.index.get(u)]));
  }
  // つながっていない駅を外す。出発駅があれば出発駅から行けない駅、
  // 無ければ「いちばん多くの駅に行ける駅」から行けない駅
  let base = 0;
  if (!startUnit) {
    let bestCount = -1;
    for (let i = 0; i < m; i++) {
      const c = D[i].filter(isFinite).length;
      if (c > bestCount) { bestCount = c; base = i; }
    }
  }
  const reach = [];
  const unreachable = [...missing];
  for (let i = 0; i < m; i++) (isFinite(D[base][i]) ? reach : unreachable).push(i);
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
  const { legs, guessed } = routeLegs(g, orderUnits);
  return {
    order: orderUnits,
    legs,
    totalKm: legs.reduce((s, l) => s + l.km, 0),
    unreachable: unreachable.map(i => typeof i === 'number' ? points[i] : i),
    guessed: [...guessed],
  };
}

// 並び orderUnits の、となりどうしの区間ごとに、線路に沿っていちばん短い道を求める。
// 戻り値: { legs: [{ from, to, km, rides: [{ line, from, to, km, path }] }], guessed: Set, broken: [区間の番号] }
//   broken … 線路がつながっていない区間（km が Infinity になる）
//   weight … 道を選ぶときの重み（省くと線の長さ）。km は重みにかかわらず、本当の長さで出す
function routeLegs(g, orderUnits, weight) {
  const legs = [];
  const guessed = new Set();
  const broken = [];
  for (let i = 0; i + 1 < orderUnits.length; i++) {
    const from = g.index.get(orderUnits[i]), toIdx = g.index.get(orderUnits[i + 1]);
    if (from === undefined || toIdx === undefined) { broken.push(i); legs.push({ from: orderUnits[i], to: orderUnits[i + 1], km: Infinity, rides: [] }); continue; }
    const r = routeDijkstra(g, from, toIdx, weight);
    if (!isFinite(r.dist[toIdx])) { broken.push(i); legs.push({ from: orderUnits[i], to: orderUnits[i + 1], km: Infinity, rides: [] }); continue; }
    const edges = [];
    for (let v = toIdx; v !== from; v = r.prevNode[v]) edges.push({ node: v, prev: r.prevNode[v], line: g.line[r.prevEdge[v]], w: g.weight[r.prevEdge[v]] });
    edges.reverse();
    // 同じ路線が続くところは1つにまとめる
    const rides = [];
    for (const e of edges) {
      if (e.line === 'guess' || String(e.line).startsWith('closed:')) { guessed.add(g.ids[e.node]); guessed.add(g.ids[e.prev]); }
      const last = rides[rides.length - 1];
      if (last && last.line === e.line) { last.to = g.ids[e.node]; last.km += e.w; last.path.push(g.ids[e.node]); }
      else rides.push({ line: e.line, from: g.ids[e.prev], to: g.ids[e.node], km: e.w, path: [g.ids[e.prev], g.ids[e.node]] });
    }
    legs.push({ from: orderUnits[i], to: orderUnits[i + 1], km: edges.reduce((s, e) => s + e.w, 0), rides });
  }
  return { legs, guessed, broken };
}

// ---------- 5. ルートの候補（自分で作るルート） ----------
//
// 立ち寄る駅の順番は決めたまま、区間（立ち寄る駅と駅の間）ごとに道の選び方を変えて、候補を何本か出す。
//   ・いちばん短い道
//   ・未アクセス駅を多く通る道 … 「別の道」にすると、増える距離のわりに未アクセス駅が多く増える区間だけ、別の道にする
//   ・○○→○○ を別の路線で … 1つの区間だけ「別の道」にしたもの
// 区間の「別の道」は、いちばん短い道で通った線をなるべく避けて選んだ道（長すぎるもの・推定のつなぎを使うものは除く）。

const ROUTE_AVOID_RATE = 3;         // 別の道を探すとき、いちばん短い道の線を何倍の長さとして数えるか（一部だけ同じ道も出せるよう、ゆるめにする）
const ROUTE_ALT_MAX_RATE = 3;       // 別の道は、いちばん短い道の何倍の長さまでにするか
const ROUTE_ALT_MIN_EXTRA_KM = 15;  // 短い区間でも、これだけは長くてよい
const ROUTE_TODO_PER_KM = 0.5;      // 増える距離 1km あたり、未アクセス駅がこれだけ増えれば「多く通る道」に使う
const ROUTE_MAX_CANDIDATES = 5;     // 候補の数の上限

// 通った道すじの印（同じ道の候補を1つにまとめるため）
function routeSignature(route) {
  return route.legs.map(l => l.rides.map(r => r.path.join(',')).join('|')).join('/');
}

// 区間に乗っている途中で取れる駅のうち、未アクセスの駅の数
function legTodoCount(leg, accessed) {
  return passAlongRides(leg.rides).filter(u => !accessed.has(u)).length;
}

// 区間の「別の道」（無ければ null）
function routeAltLeg(g, leg) {
  if (!isFinite(leg.km)) return null;
  const used = new Set();
  for (const r of leg.rides) for (let i = 0; i + 1 < r.path.length; i++) { used.add(r.path[i] + '>' + r.path[i + 1]); used.add(r.path[i + 1] + '>' + r.path[i]); }
  const w = new Float64Array(g.weight);
  for (let v = 0; v < g.ids.length; v++) {
    for (let k = g.start[v]; k < g.start[v + 1]; k++) {
      if (g.line[k] !== 'transfer' && used.has(g.ids[v] + '>' + g.ids[g.to[k]])) w[k] *= ROUTE_AVOID_RATE;
    }
  }
  const alt = routeLegs(g, [leg.from, leg.to], w).legs[0];
  if (!alt || !isFinite(alt.km)) return null;
  if (alt.km > Math.max(leg.km * ROUTE_ALT_MAX_RATE, leg.km + ROUTE_ALT_MIN_EXTRA_KM)) return null;
  if (alt.rides.some(r => r.line === 'guess') && !leg.rides.some(r => r.line === 'guess')) return null;
  if (alt.rides.map(r => r.path.join(',')).join('|') === leg.rides.map(r => r.path.join(',')).join('|')) return null;
  return alt;
}

// 区間を並べて、ルートの形（planFixedRoute と同じ形）にする
function buildFixedRoute(units, legs) {
  const guessed = new Set();
  for (const l of legs) for (const r of l.rides) {
    if (r.line === 'guess' || String(r.line).startsWith('closed:')) for (const u of r.path) guessed.add(u);
  }
  const passed = [], along = [];
  const s1 = new Set(), s2 = new Set();
  units.forEach((u, i) => {
    if (!s1.has(u)) { s1.add(u); passed.push(u); }
    if (!s2.has(u)) { s2.add(u); along.push(u); }
    const leg = legs[i];
    if (!leg) return;
    for (const r of leg.rides) for (const v of r.path) if (!s1.has(v)) { s1.add(v); passed.push(v); }
    for (const v of passAlongRides(leg.rides)) if (!s2.has(v)) { s2.add(v); along.push(v); }
  });
  return { order: units, legs, totalKm: legs.reduce((s, l) => s + l.km, 0), guessed: [...guessed], broken: [], passed, along };
}

// ルートの候補を出す。units … 立ち寄る駅（順番どおり）
// 戻り値: { broken: つながらないときの planFixedRoute の結果 or null, candidates: [{ kind, label, route }] }
function planRouteCandidates(units, accessed) {
  const g = routeGraph();
  const shortest = planFixedRoute(units);
  if (shortest.broken.length) return { broken: shortest, candidates: [] };

  const out = [];
  const seen = new Set();
  const push = (kind, label, route) => {
    const sig = routeSignature(route);
    if (seen.has(sig) || out.length >= ROUTE_MAX_CANDIDATES) return;
    seen.add(sig);
    out.push({ kind, label, route });
  };
  push('short', 'いちばん短い道', shortest);

  // 区間ごとの「別の道」と、増える距離・増える未アクセス駅
  const alts = shortest.legs.map(leg => {
    const alt = routeAltLeg(g, leg);
    if (!alt) return null;
    const extraKm = alt.km - leg.km;
    const extraTodo = legTodoCount(alt, accessed) - legTodoCount(leg, accessed);
    return { alt, extraKm, extraTodo };
  });

  // 未アクセス駅を多く通る道（ルート全体で増えるときだけ）
  const todoLegs = shortest.legs.map((leg, i) => {
    const a = alts[i];
    if (!a || a.extraTodo <= 0) return leg;
    return a.extraKm <= 0 || a.extraTodo / a.extraKm >= ROUTE_TODO_PER_KM ? a.alt : leg;
  });
  if (todoLegs.some((l, i) => l !== shortest.legs[i])) {
    const route = buildFixedRoute(units, todoLegs);
    if (route.along.filter(u => !accessed.has(u)).length > shortest.along.filter(u => !accessed.has(u)).length) push('todo', '未アクセス駅を多く通る道', route);
  }

  // 1つの区間だけ別の道にした候補（ルート全体で、通る未アクセス駅が増えるものだけ。増える数が多い順）
  const todoOf = route => route.along.filter(u => !accessed.has(u)).length;
  const baseTodo = todoOf(shortest);
  const singles = [];
  alts.forEach((a, i) => {
    if (!a) return;
    const legs = shortest.legs.slice();
    legs[i] = a.alt;
    const route = buildFixedRoute(units, legs);
    const gain = todoOf(route) - baseTodo;
    if (gain > 0) singles.push({ i, route, gain, km: route.totalKm });
  });
  singles.sort((x, y) => y.gain - x.gain || x.km - y.km);
  for (const s of singles) {
    push('alt', `${MASTER.units[units[s.i]].name}→${MASTER.units[units[s.i + 1]].name} を別の路線で`, s.route);
  }
  return { broken: null, candidates: out };
}

// 路線ごとにまとめた書き方：「江北→（JR佐世保線）→佐世保→（松浦鉄道西九州線）→伊万里」
// 同じ路線が続くところ（「JR筑肥線(…)」のように区間が分かれていても同じ名前）は1つにまとめる
function routeLineBase(lc) {
  if (lc === 'guess') return '線路データ無し（推定）';
  if (String(lc).startsWith('closed:')) {
    const real = lc.slice(7);
    return (MASTER.lines[real] ? MASTER.lines[real].name : real).replace(/[（(][^）)]*[）)]$/, '') + '（廃止区間）';
  }
  const name = MASTER.lines[lc] ? MASTER.lines[lc].name : String(lc);
  return name.replace(/[（(][^）)]*[）)]$/, '');
}

// 立ち寄る駅（区間の境め）では、同じ路線でもまとめずに区切る（折り返しても分かるように）
function routeLineSummary(route) {
  const segs = [];
  for (const l of route.legs) {
    let first = true;
    for (const r of l.rides) {
      if (r.line === 'transfer') continue;   // 同じ駅グループの乗り換えは書かない
      const name = routeLineBase(r.line);
      const last = segs[segs.length - 1];
      if (last && last.name === name && !first) last.to = r.to;
      else segs.push({ name, from: r.from, to: r.to });
      first = false;
    }
  }
  if (segs.length === 0) return route.order.map(u => MASTER.units[u].name).join('→');
  // 前の区切りの終わりと次の始まりが違う駅（乗り換え）なら「A・B」と書く
  return segs.map((s, i) => {
    const prevTo = i > 0 ? segs[i - 1].to : null;
    const head = i === 0 ? MASTER.units[s.from].name
      : (MASTER.units[prevTo].name === MASTER.units[s.from].name ? '' : '・' + MASTER.units[s.from].name);
    return head + `→（${s.name}）→` + MASTER.units[s.to].name;
  }).join('');
}

// ---------- 4. 乗っている途中で取れる駅 ----------
//
// 駅メモでは、チェックインした場所からいちばん近い駅が取れる。
// そこで、区間の道すじ（駅と駅を直線で結んだ線）の上に 0.3km おきに点を置き、
// 点ごとに「いちばん近い駅」を調べる。出てきた駅は、その区間に乗っている途中で取れる駅とみなす。
// 線路の形のデータは無いので、線路が大きく曲がっている所では、実際とずれることがある。

const PASS_STEP_KM = 0.3;   // 点を置く間隔

// 駅と駅の間（1本の線）の途中で、いちばん近い駅になる駅（両はしの駅は除く）
// 同じ線は何度も調べることになるので、1回調べたら覚えておく
const passSegCache = new Map();

function passAlongSegment(ua, ub) {
  const key = ua + '>' + ub;
  if (passSegCache.has(key)) return passSegCache.get(key);
  const a = MASTER.units[ua], b = MASTER.units[ub];
  const out = [];
  const steps = Math.max(1, Math.ceil(routeDistKm(a, b) / PASS_STEP_KM));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const near = radarNearest(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t, 1);   // radarplan.js
    if (near.length && out[out.length - 1] !== near[0].u) out.push(near[0].u);
  }
  passSegCache.set(key, out);
  return out;
}

// 区間の乗り方（rides）に沿って、途中で取れる駅を順に集める（両はしの駅も入る）
// 線路データの無い「推定」のつなぎは、実際には乗れないので調べない
function passAlongRides(rides) {
  const out = [];
  const seen = new Set();
  const add = u => { if (!seen.has(u)) { seen.add(u); out.push(u); } };
  for (const r of rides) {
    if (r.line === 'guess') { add(r.from); add(r.to); continue; }
    for (let i = 0; i + 1 < r.path.length; i++) {
      add(r.path[i]);
      for (const u of passAlongSegment(r.path[i], r.path[i + 1])) add(u);
      add(r.path[i + 1]);
    }
  }
  return out;
}

// 2駅の間の、いちばん短い道で途中に取れる駅（両はしの駅も入る）。つながっていなければ null
function passBetween(g, a, b) {
  const { legs, broken } = routeLegs(g, [a, b]);
  if (broken.length) return null;
  return new Set(passAlongRides(legs[0].rides));
}

// 回る順番から、ほかの区間の途中で取れる駅を外す（その駅には寄らない）。
//   plan … planRoute の戻り値
//   keep … 外さない駅（出発駅、レーダーを使う駅、ルートビューンの2駅など）
// 戻り値: 新しい plan（dropped: [外した駅] を足したもの）
function dropPassStops(plan, keep, round) {
  const g = routeGraph();
  // 出発駅に戻るときは、最後の「戻ってきた出発駅」を除いて考える
  const core = round && plan.order.length > 1 ? plan.order.slice(0, -1) : plan.order.slice();
  const dropped = [];
  for (let i = 0; i < core.length && core.length > 1;) {
    const t = core[i];
    if (keep.has(t)) { i++; continue; }
    const n = core.length;
    const prev = i > 0 ? core[i - 1] : (round ? core[n - 1] : null);
    const next = i < n - 1 ? core[i + 1] : (round ? core[0] : null);
    let ok = false;
    if (prev && next && prev !== next) {
      // 前の駅から次の駅へ、t に寄らずに進んでも、途中で t が取れるか
      const s = passBetween(g, prev, next);
      ok = !!(s && s.has(t));
    } else if (prev || next) {
      // 端の駅：となりの駅と、そのまた先の駅の区間の途中で t が取れるか
      const nb = prev || next;
      const j = core.indexOf(nb);
      const nb2 = prev ? core[j - 1] : core[j + 1];
      if (nb2) { const s = passBetween(g, nb2, nb); ok = !!(s && s.has(t)); }
    }
    if (ok) { dropped.push(t); core.splice(i, 1); }
    else i++;
  }
  if (dropped.length === 0) return { ...plan, dropped };
  const order = round && core.length > 1 ? [...core, core[0]] : core;
  const { legs, guessed } = routeLegs(g, order);
  return {
    ...plan,
    order,
    legs,
    totalKm: legs.reduce((s, l) => s + (isFinite(l.km) ? l.km : 0), 0),
    guessed: [...new Set([...plan.guessed, ...guessed])],
    dropped,
  };
}

// 2駅の間の線の長さ（グラフから探す。見つからなければ直線距離）
function routeEdgeKm(g, a, b, line) {
  const i = g.index.get(a), j = g.index.get(b);
  if (i !== undefined && j !== undefined) {
    for (let k = g.start[i]; k < g.start[i + 1]; k++) if (g.to[k] === j && g.line[k] === line) return g.weight[k];
    for (let k = g.start[i]; k < g.start[i + 1]; k++) if (g.to[k] === j) return g.weight[k];
  }
  return routeDistKm(MASTER.units[a], MASTER.units[b]);
}

// 道すじはそのままに、立ち寄る駅を「出発駅・到着駅・乗換駅・折り返す駅・keep の駅」に置き直す。
//   乗換駅 … 路線が変わる駅（「JR筑肥線(…)」のように区間が分かれていても、同じ名前の路線は1本とみなす）
//   折り返す駅 … 同じ線を引き返す駅
//   keep … 立ち寄る駅として残す駅（レーダーを使う駅として選んだ駅、ルートビューンの2駅など）
// 戻り値: 新しい plan（order と legs を置き直したもの。removed: 立ち寄らなくなった駅）
function splitAtTransfers(plan, keep) {
  if (plan.order.length < 2 || plan.legs.some(l => !isFinite(l.km))) return { ...plan, removed: [] };
  const g = routeGraph();
  // 道すじを、駅から駅への線の並びにする
  const edges = [];
  for (const l of plan.legs) for (const r of l.rides) {
    for (let i = 0; i + 1 < r.path.length; i++) edges.push({ a: r.path[i], b: r.path[i + 1], line: r.line });
  }
  if (edges.length === 0) return { ...plan, removed: [] };
  const base = e => e.line === 'transfer' ? null : routeLineBase(e.line);
  // 区切る場所（edges の番号 i の「終わりの駅」で区切る）
  const cut = new Set();
  let lastBase = null, lastIdx = -1;
  for (let i = 0; i < edges.length; i++) {
    const b = base(edges[i]);
    if (b === null) continue;
    if (lastBase !== null && b !== lastBase) cut.add(lastIdx);   // 路線が変わる：前の路線の終わりの駅で区切る
    lastBase = b; lastIdx = i;
  }
  for (let i = 0; i + 1 < edges.length; i++) {
    if (edges[i].a === edges[i + 1].b) cut.add(i);               // 引き返す：折り返す駅で区切る
    if (keep.has(edges[i].b)) cut.add(i);
  }
  // 区切った場所ごとに、区間を作り直す
  const order = [edges[0].a];
  const legs = [];
  let cur = [];
  const flush = () => {
    const rides = [];
    let km = 0;
    for (const e of cur) {
      const w = routeEdgeKm(g, e.a, e.b, e.line);
      km += w;
      const last = rides[rides.length - 1];
      if (last && last.line === e.line) { last.to = e.b; last.km += w; last.path.push(e.b); }
      else rides.push({ line: e.line, from: e.a, to: e.b, km: w, path: [e.a, e.b] });
    }
    legs.push({ from: cur[0].a, to: cur[cur.length - 1].b, km, rides });
    order.push(cur[cur.length - 1].b);
    cur = [];
  };
  edges.forEach((e, i) => {
    cur.push(e);
    if (cut.has(i) || i === edges.length - 1) flush();
  });
  // 乗り換えの線だけの区間（同じ駅グループの乗り換え）は、前の区間につなげる
  for (let i = legs.length - 1; i > 0; i--) {
    if (legs[i].rides.every(r => r.line === 'transfer')) {
      legs[i - 1].rides.push(...legs[i].rides);
      legs[i - 1].to = legs[i].to;
      legs[i - 1].km += legs[i].km;
      legs.splice(i, 1);
      order.splice(i, 1);
    }
  }
  const inOrder = new Set(order);
  const removed = [...new Set(plan.order)].filter(u => !inOrder.has(u));
  return { ...plan, order, legs, totalKm: legs.reduce((s, l) => s + l.km, 0), removed };
}

// 区間ごとに、途中で取れる駅（両はしの駅を除く）を leg.pass に入れる
function addLegPass(legs) {
  for (const l of legs) {
    l.pass = isFinite(l.km) ? passAlongRides(l.rides).filter(u => u !== l.from && u !== l.to) : [];
  }
  return legs;
}

// 地点 p から、区間の道すじ（駅を結んだ線）までの、いちばん近い距離（km）
function distToLegKm(p, leg) {
  let best = Infinity;
  for (const r of leg.rides) {
    for (let i = 0; i + 1 < r.path.length; i++) {
      const a = MASTER.units[r.path[i]], b = MASTER.units[r.path[i + 1]];
      // 小さな範囲なので、平らな地図とみなして点と線分の距離を求める
      const kx = 111.32 * Math.cos(p.lat * Math.PI / 180), ky = 111.0;
      const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
      const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const x = ax + dx * t, y = ay + dy * t;
      best = Math.min(best, Math.sqrt(x * x + y * y));
    }
  }
  return best;
}

// 自分で「途中で取る」にした駅を、いちばん近い区間に割り当てる
// 戻り値: Map(区間の番号 → [{ u, km: 道すじからの距離 }])
function assignPassToLegs(units, legs) {
  const out = new Map();
  for (const u of units) {
    let best = -1, bestKm = Infinity;
    legs.forEach((l, i) => {
      if (!isFinite(l.km)) return;
      const d = distToLegKm(MASTER.units[u], l);
      if (d < bestKm) { bestKm = d; best = i; }
    });
    if (best < 0) continue;
    if (!out.has(best)) out.set(best, []);
    out.get(best).push({ u, km: bestKm });
  }
  return out;
}

// 自分で決めた順番（駅の並び）のまま、区間ごとの乗り方を求める。
// 戻り値: { order, legs, totalKm, guessed: [駅], broken: [区間の番号], passed: [通る駅すべて（順番どおり・重なり無し）] }
//   weight … 道を選ぶときの重み（省くと、いちばん短い道）
//   along … 乗っている途中で取れる駅も含めた、通る駅すべて（順番どおり・重なり無し）
function planFixedRoute(units, weight) {
  const g = routeGraph();
  const { legs, guessed, broken } = routeLegs(g, units, weight);
  const passed = [];
  const seen = new Set();
  const addPassed = u => { if (!seen.has(u)) { seen.add(u); passed.push(u); } };
  units.forEach((u, i) => {
    addPassed(u);
    const leg = legs[i];
    if (leg) for (const r of leg.rides) for (const v of r.path) addPassed(v);
  });
  const along = [];
  const seenAlong = new Set();
  units.forEach((u, i) => {
    if (!seenAlong.has(u)) { seenAlong.add(u); along.push(u); }
    const leg = legs[i];
    if (leg && isFinite(leg.km)) for (const v of passAlongRides(leg.rides)) if (!seenAlong.has(v)) { seenAlong.add(v); along.push(v); }
  });
  return {
    order: units,
    legs,
    totalKm: legs.reduce((s, l) => s + (isFinite(l.km) ? l.km : 0), 0),
    guessed: [...guessed],
    broken,
    passed,
    along,
  };
}
