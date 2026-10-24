# ============================================================
# 線路の形を作る（master/shapes.js）
#
# 国土数値情報（鉄道データ）の線路の形（data/n02/N02-24_RailroadSection.geojson）を使い、
# 駅マスタ（master/master.js）の「隣り合う駅と駅の間」ごとに、線路の上をたどった形を取り出す。
#
# 取り出し方:
#   1. 鉄道データの線路を、点と点をつないだ道（ネットワーク）にする
#   2. 隣り合う駅の組ごとに、駅の近く（SNAP_M 以内）の線路から、もう一方の駅の近くの線路まで、
#      線路の上をいちばん短くたどる（同じ名前の路線の線路を優先し、別の路線は OTHER_RATE 倍の長さとして数える）
#   3. たどった長さが直線の MAX_RATE 倍 + MAX_EXTRA_KM を超えるときは、合っていないとみなして使わない（直線のまま）
#   4. SIMPLIFY_M より細かい曲がりを間引き、整数（緯度・経度 × 10万）の差分にして保存する
#
# 使い方: powershell -ExecutionPolicy Bypass -File tools\build-shapes.ps1
# 駅マスタを作り直したあとにも、もう一度動かす（駅の番号ごとに形を持つため）。
# ============================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$masterPath = Join-Path $root 'master\master.js'
$geoPath = Join-Path $root 'data\n02\N02-24_RailroadSection.geojson'
$outPath = Join-Path $root 'master\shapes.js'

if (-not (Test-Path $geoPath)) { throw "鉄道データが見つかりません: $geoPath（国土数値情報 N02-24_GML.zip の UTF-8 フォルダの中のファイル）" }

$code = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

public static class ShapeBuilder
{
    const double SNAP_M = 400;        // 駅から、この距離までの線路の点を、たどり始め・たどり終わりにしてよい
    const double OTHER_RATE = 1.6;    // 別の名前の路線の線路は、何倍の長さとして数えるか
    const double MAX_RATE = 2.0;      // 直線の何倍までの長さなら、合っているとみなすか
    const double MAX_EXTRA_KM = 1.5;  // （その上に、これだけは長くてよい）
    const double SIMPLIFY_M = 12;     // これより細かい曲がりは間引く
    const double CELL = 0.01;         // 近い点を速く探すためのマス目（度）

    // 線路の点
    static List<double> nLat = new List<double>();
    static List<double> nLon = new List<double>();
    static Dictionary<long, int> nodeOf = new Dictionary<long, int>();
    static List<List<int>> adjTo = new List<List<int>>();
    static List<List<int>> adjLine = new List<List<int>>();
    static List<string> n02Names = new List<string>();
    static Dictionary<string, int> n02NameId = new Dictionary<string, int>();
    static Dictionary<long, List<int>> grid = new Dictionary<long, List<int>>();

    static double Dist(double lat1, double lon1, double lat2, double lon2)
    {
        double dy = (lat1 - lat2) * 111000.0;
        double dx = (lon1 - lon2) * 111320.0 * Math.Cos((lat1 + lat2) / 2 * Math.PI / 180);
        return Math.Sqrt(dx * dx + dy * dy);
    }

    static long CellKey(int i, int j) { return ((long)i << 32) ^ (uint)j; }

    static int Node(double lon, double lat)
    {
        long key = ((long)Math.Round(lon * 100000)) * 100000000L + (long)Math.Round(lat * 100000);
        int id;
        if (nodeOf.TryGetValue(key, out id)) return id;
        id = nLat.Count;
        nodeOf[key] = id;
        nLat.Add(lat); nLon.Add(lon);
        adjTo.Add(new List<int>()); adjLine.Add(new List<int>());
        long ck = CellKey((int)Math.Floor(lat / CELL), (int)Math.Floor(lon / CELL));
        List<int> cell;
        if (!grid.TryGetValue(ck, out cell)) { cell = new List<int>(); grid[ck] = cell; }
        cell.Add(id);
        return id;
    }

    static void LoadNetwork(string geoPath)
    {
        var ser = new JavaScriptSerializer();
        ser.MaxJsonLength = int.MaxValue;
        var geo = (Dictionary<string, object>)ser.DeserializeObject(File.ReadAllText(geoPath, Encoding.UTF8));
        foreach (object fo in (object[])geo["features"])
        {
            var f = (Dictionary<string, object>)fo;
            var props = (Dictionary<string, object>)f["properties"];
            string name = props["N02_003"] as string ?? "";
            int lineId;
            if (!n02NameId.TryGetValue(name, out lineId)) { lineId = n02Names.Count; n02NameId[name] = lineId; n02Names.Add(name); }
            var geom = (Dictionary<string, object>)f["geometry"];
            var coords = (object[])geom["coordinates"];
            int prev = -1;
            foreach (object co in coords)
            {
                var c = (object[])co;
                int id = Node(Convert.ToDouble(c[0]), Convert.ToDouble(c[1]));
                if (prev >= 0 && prev != id)
                {
                    adjTo[prev].Add(id); adjLine[prev].Add(lineId);
                    adjTo[id].Add(prev); adjLine[id].Add(lineId);
                }
                prev = id;
            }
        }
    }

    // 地点の近く（m 以内）の線路の点
    static List<int> Near(double lat, double lon, double m)
    {
        var res = new List<int>();
        int ci = (int)Math.Floor(lat / CELL), cj = (int)Math.Floor(lon / CELL);
        for (int i = ci - 1; i <= ci + 1; i++)
            for (int j = cj - 1; j <= cj + 1; j++)
            {
                List<int> cell;
                if (!grid.TryGetValue(CellKey(i, j), out cell)) continue;
                foreach (int n in cell) if (Dist(lat, lon, nLat[n], nLon[n]) <= m) res.Add(n);
            }
        return res;
    }

    // 駅 A の近くから駅 B の近くまで、線路の上をたどる。見つからなければ null
    static List<int> Trace(double aLat, double aLon, double bLat, double bLon, HashSet<int> prefer, out double realM)
    {
        realM = 0;
        double straight = Dist(aLat, aLon, bLat, bLon);
        double limit = (straight * MAX_RATE + MAX_EXTRA_KM * 1000) * OTHER_RATE;
        var starts = Near(aLat, aLon, SNAP_M);
        var goals = Near(bLat, bLon, SNAP_M);
        if (starts.Count == 0 || goals.Count == 0) return null;
        var goalExtra = new Dictionary<int, double>();
        foreach (int g in goals) goalExtra[g] = Dist(bLat, bLon, nLat[g], nLon[g]);

        var dist = new Dictionary<int, double>();
        var prev = new Dictionary<int, int>();
        var heap = new SortedSet<Tuple<double, int>>();
        foreach (int s in starts)
        {
            double d0 = Dist(aLat, aLon, nLat[s], nLon[s]);
            dist[s] = d0; prev[s] = -1;
            heap.Add(Tuple.Create(d0, s));
        }
        double best = double.MaxValue; int bestNode = -1;
        while (heap.Count > 0)
        {
            var top = heap.Min; heap.Remove(top);
            double d = top.Item1; int v = top.Item2;
            if (d > dist[v]) continue;
            if (d >= best || d > limit) break;
            double ge;
            if (goalExtra.TryGetValue(v, out ge) && d + ge < best) { best = d + ge; bestNode = v; }
            var to = adjTo[v]; var ln = adjLine[v];
            for (int k = 0; k < to.Count; k++)
            {
                int w = to[k];
                double len = Dist(nLat[v], nLon[v], nLat[w], nLon[w]);
                double nd = d + len * (prefer.Contains(ln[k]) ? 1.0 : OTHER_RATE);
                double old;
                if (!dist.TryGetValue(w, out old) || nd < old)
                {
                    if (dist.ContainsKey(w)) heap.Remove(Tuple.Create(old, w));
                    dist[w] = nd; prev[w] = v;
                    heap.Add(Tuple.Create(nd, w));
                }
            }
        }
        if (bestNode < 0) return null;
        var path = new List<int>();
        for (int v = bestNode; v >= 0; v = prev[v]) path.Add(v);
        path.Reverse();
        // 本当の長さ（駅から線路まで・線路から駅までも含む）
        realM = Dist(aLat, aLon, nLat[path[0]], nLon[path[0]]) + goalExtra[bestNode];
        for (int i = 0; i + 1 < path.Count; i++) realM += Dist(nLat[path[i]], nLon[path[i]], nLat[path[i + 1]], nLon[path[i + 1]]);
        if (realM > straight * MAX_RATE + MAX_EXTRA_KM * 1000) return null;
        return path;
    }

    // 細かい曲がりを間引く（ダグラス・ポーカー法）
    static void Simplify(List<double[]> pts, int s, int e, bool[] keep)
    {
        if (e <= s + 1) return;
        double maxD = -1; int idx = -1;
        double lat0 = pts[s][0];
        double kx = 111320.0 * Math.Cos(lat0 * Math.PI / 180), ky = 111000.0;
        double ax = pts[s][1] * kx, ay = pts[s][0] * ky, bx = pts[e][1] * kx, by = pts[e][0] * ky;
        double dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        for (int i = s + 1; i < e; i++)
        {
            double px = pts[i][1] * kx, py = pts[i][0] * ky;
            double t = len2 > 0 ? Math.Max(0, Math.Min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
            double qx = ax + dx * t - px, qy = ay + dy * t - py;
            double dd = Math.Sqrt(qx * qx + qy * qy);
            if (dd > maxD) { maxD = dd; idx = i; }
        }
        if (maxD > SIMPLIFY_M) { keep[idx] = true; Simplify(pts, s, idx, keep); Simplify(pts, idx, e, keep); }
    }

    public static string Run(string masterPath, string geoPath, string outPath)
    {
        var log = new StringBuilder();
        LoadNetwork(geoPath);
        log.AppendLine("線路の点: " + nLat.Count + "、路線名: " + n02Names.Count);

        string text = File.ReadAllText(masterPath, Encoding.UTF8);
        int p = text.IndexOf("window.EKIMEMO_MASTER = ");
        string json = text.Substring(p + "window.EKIMEMO_MASTER = ".Length).Trim().TrimEnd(';');
        var ser = new JavaScriptSerializer();
        ser.MaxJsonLength = int.MaxValue;
        var master = (Dictionary<string, object>)ser.DeserializeObject(json);
        var stations = (Dictionary<string, object>)master["stations"];
        var lines = (Dictionary<string, object>)master["lines"];
        var joins = (Dictionary<string, object>)master["joins"];

        var outEdges = new SortedDictionary<string, string>(StringComparer.Ordinal);
        var outPrefer = new Dictionary<string, bool>();
        int total = 0, ok = 0, noLine = 0, tooLong = 0;
        var samples = new List<string>();
        foreach (var kv in joins)
        {
            string lc = kv.Key;
            string lname = lines.ContainsKey(lc) ? (string)((Dictionary<string, object>)lines[lc])["name"] : "";
            // 同じ名前とみなす鉄道データの路線（鉄道データの路線名が、駅メモの路線名に含まれるもの）
            var prefer = new HashSet<int>();
            for (int i = 0; i < n02Names.Count; i++)
            {
                string nm = n02Names[i];
                if (nm.Length >= 2 && lname.Contains(nm)) prefer.Add(i);
                else if (nm.EndsWith("線") && nm.Length >= 3 && lname.Contains(nm.Substring(0, nm.Length - 1))) prefer.Add(i);
            }
            foreach (object po in (object[])kv.Value)
            {
                var pair = (object[])po;
                string sa = pair[0].ToString(), sb = pair[1].ToString();
                if (!stations.ContainsKey(sa) || !stations.ContainsKey(sb)) continue;
                var A = (Dictionary<string, object>)stations[sa];
                var B = (Dictionary<string, object>)stations[sb];
                string ua = A["u"].ToString(), ub = B["u"].ToString();
                if (ua == ub) continue;
                // 駅メモの駅の組で1つ（向きは、番号の小さい駅 → 大きい駅）
                bool swap = string.CompareOrdinal(ua, ub) > 0;
                string key = swap ? ub + ">" + ua : ua + ">" + ub;
                bool hasPrefer = prefer.Count > 0;
                if (outEdges.ContainsKey(key) && (outPrefer[key] || !hasPrefer)) continue;
                total++;
                double aLat = Convert.ToDouble(A["lat"]), aLon = Convert.ToDouble(A["lon"]);
                double bLat = Convert.ToDouble(B["lat"]), bLon = Convert.ToDouble(B["lon"]);
                double realM;
                var path = Trace(aLat, aLon, bLat, bLon, prefer, out realM);
                if (path == null)
                {
                    if (Near(aLat, aLon, SNAP_M).Count == 0 || Near(bLat, bLon, SNAP_M).Count == 0) noLine++; else tooLong++;
                    if (samples.Count < 40) samples.Add(lname + "：" + A["name"] + "→" + B["name"]);
                    continue;
                }
                ok++;
                // 駅 → 線路 → 駅 の点の並び
                var pts = new List<double[]>();
                pts.Add(new double[] { aLat, aLon });
                foreach (int n in path) pts.Add(new double[] { nLat[n], nLon[n] });
                pts.Add(new double[] { bLat, bLon });
                var keep = new bool[pts.Count];
                keep[0] = true; keep[pts.Count - 1] = true;
                Simplify(pts, 0, pts.Count - 1, keep);
                var kept = new List<double[]>();
                for (int i = 0; i < pts.Count; i++) if (keep[i]) kept.Add(pts[i]);
                if (swap) kept.Reverse();
                // 整数（× 10万）の差分にする
                var sb2 = new StringBuilder();
                long plat = 0, plon = 0;
                for (int i = 0; i < kept.Count; i++)
                {
                    long ilat = (long)Math.Round(kept[i][0] * 100000), ilon = (long)Math.Round(kept[i][1] * 100000);
                    if (i > 0) sb2.Append(',');
                    sb2.Append(ilat - plat).Append(',').Append(ilon - plon);
                    plat = ilat; plon = ilon;
                }
                outEdges[key] = sb2.ToString();
                outPrefer[key] = hasPrefer;
            }
        }

        var o = new StringBuilder();
        o.AppendLine("// 自動生成ファイル（tools/build-shapes.ps1）。手で編集しないこと。");
        o.AppendLine("// 「国土数値情報（鉄道データ）」（国土交通省）を加工して作成（CC BY 4.0）");
        o.AppendLine("// 駅メモの駅の組（番号の小さい駅>大きい駅）ごとの線路の形。");
        o.AppendLine("// 値は「緯度×10万, 経度×10万」の差分を並べたもの（最初の2つはそのままの値）。");
        o.Append("window.EKIMEMO_SHAPES = {\"builtAt\":\"").Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm")).Append("\",\"source\":\"N02-24\",\"edges\":{");
        bool first = true;
        foreach (var e in outEdges)
        {
            if (!first) o.Append(',');
            first = false;
            o.Append('"').Append(e.Key).Append("\":\"").Append(e.Value).Append('"');
        }
        o.AppendLine("}};");
        File.WriteAllText(outPath, o.ToString(), new UTF8Encoding(false));

        log.AppendLine("駅と駅の間: " + total + "、線路の形が取れた: " + ok + "（" + (total > 0 ? (ok * 1000 / total / 10.0) : 0) + "%）");
        log.AppendLine("  近くに線路が無い（廃線・データに無い路線など）: " + noLine);
        log.AppendLine("  線路をたどると長すぎる（合っていない）: " + tooLong);
        log.AppendLine("取れなかった例:");
        foreach (string s in samples) log.AppendLine("  " + s);
        return log.ToString();
    }
}
'@

Add-Type -TypeDefinition $code -Language CSharp -ReferencedAssemblies System.Web.Extensions
$sw = [Diagnostics.Stopwatch]::StartNew()
$result = [ShapeBuilder]::Run($masterPath, $geoPath, $outPath)
$sw.Stop()
Write-Output $result
$size = (Get-Item $outPath).Length
Write-Output ("書き出し: master\shapes.js（{0:N0} バイト）・{1:N1} 秒" -f $size, $sw.Elapsed.TotalSeconds)
