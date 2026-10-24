// ============================================================
// 線路の形（master/shapes.js）を使って、地図の線を線路どおりに描く
//
// master/shapes.js は tools/build-shapes.ps1 が作る。
// 「国土数値情報（鉄道データ）」（国土交通省）を加工して作成（CC BY 4.0）。
// 駅メモの駅の組（番号の小さい駅>大きい駅）ごとに、線路の形が入っている。
// 形が無い組（廃線など）は、これまでどおり駅と駅を直線で結ぶ。
// ============================================================

const shapeCache = new Map();   // 駅の組 → [[緯度, 経度], …]（番号の小さい駅 → 大きい駅の向き）

// 2駅の間の線路の形（a → b の向き）。無ければ null
function shapeBetween(a, b) {
  const S = window.EKIMEMO_SHAPES;
  if (!S || !S.edges) return null;
  const rev = !(a < b);   // 駅の番号は数字だけなので、文字の比べ方で小さい・大きいが決まる
  const key = rev ? b + '>' + a : a + '>' + b;
  let pts = shapeCache.get(key);
  if (pts === undefined) {
    const code = S.edges[key];
    pts = null;
    if (code) {
      // 「緯度×10万, 経度×10万」の差分を足し戻す
      const nums = code.split(',').map(Number);
      pts = [];
      let lat = 0, lon = 0;
      for (let i = 0; i + 1 < nums.length; i += 2) {
        lat += nums[i]; lon += nums[i + 1];
        pts.push([lat / 100000, lon / 100000]);
      }
    }
    shapeCache.set(key, pts);
  }
  if (!pts) return null;
  return rev ? pts.slice().reverse() : pts;
}

// 駅の並び（駅メモの駅の番号）を、線路の形に沿った点の並びにする
function pathLatLngs(units) {
  const out = [];
  let prev = null;
  for (const u of units) {
    const unit = MASTER.units[u];
    if (!unit) continue;
    if (prev === null) { out.push([unit.lat, unit.lon]); prev = u; continue; }
    if (u === prev) continue;
    const shape = shapeBetween(prev, u);
    if (shape) for (const p of shape) out.push(p);
    else out.push([unit.lat, unit.lon]);   // 形が無ければ直線
    prev = u;
  }
  return out;
}
