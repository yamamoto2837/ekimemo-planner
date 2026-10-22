# ============================================================
# 駅マスタ構築スクリプト（要件定義書 ステップ3）
#
# 駅データ.jp の CSV（駅・路線・接続駅）を読み込み、
# アプリが読み込むデータファイル master/master.js を作る。
#
# 実行方法（プロジェクトのフォルダで）:
#   powershell -ExecutionPolicy Bypass -File tools\build-master.ps1
#
# 駅マスタを月次で更新するときは、data フォルダに新しい CSV を置いて
# もう一度実行するだけでよい（ファイル名の日付が新しいものを自動で使う）。
# ============================================================

$ErrorActionPreference = 'Stop'
$root    = Split-Path $PSScriptRoot -Parent
$dataDir = Join-Path $root 'data'
$outDir  = Join-Path $root 'master'

# ------------------------------------------------------------
# 1. 入力ファイルを探す（同じ種類が複数あれば名前が一番新しいもの）
# ------------------------------------------------------------
function Find-Latest($pattern) {
  $f = Get-ChildItem $dataDir -Filter $pattern | Sort-Object Name | Select-Object -Last 1
  if (-not $f) { throw "data フォルダに $pattern が見つかりません" }
  return $f
}
$stationFile = Find-Latest 'station*.csv'
$lineFile    = Find-Latest 'line*.csv'
$joinFile    = Find-Latest 'join*.csv'
$aliasFile   = Join-Path $dataDir 'id_alias.csv'
$extraFile   = Join-Path $dataDir 'extra_stations.csv'   # 駅データ.jp に無い駅（手で管理する）

Write-Host "駅データ   : $($stationFile.Name)"
Write-Host "路線データ : $($lineFile.Name)"
Write-Host "接続駅データ: $($joinFile.Name)"

$stationRows = Import-Csv $stationFile.FullName -Encoding UTF8
$lineRows    = Import-Csv $lineFile.FullName    -Encoding UTF8
$joinRows    = Import-Csv $joinFile.FullName    -Encoding UTF8
$aliasRows   = @()
if (Test-Path $aliasFile) { $aliasRows = Import-Csv $aliasFile -Encoding UTF8 }
$extraRows   = @()
if (Test-Path $extraFile) { $extraRows = Import-Csv $extraFile -Encoding UTF8 }

# ------------------------------------------------------------
# 2. 絞り込み
#    e_status: 0=運用中 / 1=運用前 / 2=廃止
#    運用前(1)は駅メモ未登録なので外す。廃止(2)は駅メモに残っている
#    場合があるので残し、closed（廃駅フラグ）を立てる。
# ------------------------------------------------------------
$excludedCount = @($stationRows | Where-Object { $_.e_status -eq '1' }).Count
$stationRows   = @($stationRows | Where-Object { $_.e_status -ne '1' })
$lineRows      = @($lineRows    | Where-Object { $_.e_status -ne '1' })

# ------------------------------------------------------------
# 2b. 駅メモに無い駅を外す（data/excluded_stations.csv）
#     駅データ.jp にはあるが駅メモには無い駅（古い廃駅、ケーブルカーなど）。
#     駅メモにあるとわかったら、この表から行を消せば対象に戻る。
#     駅データ.jp に新しく載った駅は、この表に無い限り対象に入る。
# ------------------------------------------------------------
$excludedFile = Join-Path $dataDir 'excluded_stations.csv'
$excluded = @{}
if (Test-Path $excludedFile) { Import-Csv $excludedFile -Encoding UTF8 | ForEach-Object { $excluded[$_.station_cd] = $_.reason } }
$excludedHit = @($stationRows | Where-Object { $excluded.ContainsKey($_.station_cd) }).Count
if ($excludedHit -ne $excluded.Count) { Write-Warning "excluded_stations.csv のうち $($excluded.Count - $excludedHit) 件が駅データに見つかりません" }
$stationRows = @($stationRows | Where-Object { -not $excluded.ContainsKey($_.station_cd) })

# 外した駅をはさむ接続は、両隣の駅どうしを直接つなぐ（路線が途中で切れないように）
$neighbors = @{}   # "路線|外した駅" → 隣の駅の一覧
foreach ($j in $joinRows) {
  foreach ($pair in @(@($j.station_cd1, $j.station_cd2), @($j.station_cd2, $j.station_cd1))) {
    if (-not $excluded.ContainsKey($pair[0])) { continue }
    $k = "$($j.line_cd)|$($pair[0])"
    if (-not $neighbors.ContainsKey($k)) { $neighbors[$k] = New-Object System.Collections.ArrayList }
    [void]$neighbors[$k].Add($pair[1])
  }
}
$bridgeJoins = New-Object System.Collections.ArrayList
foreach ($k in $neighbors.Keys) {
  $n = @($neighbors[$k] | Where-Object { -not $excluded.ContainsKey($_) })
  if ($n.Count -eq 2) { [void]$bridgeJoins.Add([pscustomobject]@{ line_cd = ($k -split '\|')[0]; station_cd1 = $n[0]; station_cd2 = $n[1] }) }
}
$joinRows = @($joinRows) + @($bridgeJoins)

# ------------------------------------------------------------
# 3. 駅（駅コード単位）
# ------------------------------------------------------------
$stations = @{}
foreach ($r in $stationRows) {
  $stations[$r.station_cd] = [ordered]@{
    g      = $r.station_g_cd          # 駅グループコード（名寄せのキー）
    name   = $r.station_name
    line   = $r.line_cd
    pref   = [int]$r.pref_cd
    lat    = [double]$r.lat
    lon    = [double]$r.lon
    closed = ($r.e_status -eq '2')
  }
}

# ※ 駅データ.jp の駅グループ（station_g_cd）は各駅の g に残す。
#   乗換できる駅のまとまりとして使うが、数える単位には使わない（4c を参照）。

# ------------------------------------------------------------
# 4b. 追加駅（data/extra_stations.csv）
#     駅データ.jp に載っていない駅（新幹線だけの駅、昔の廃線の駅、BRTなど）。
#     駅コードは駅メモマップ2の4桁IDをそのまま使い、1駅で1グループとする。
#     路線名が駅データ.jp の路線と同じならその路線に入れ、
#     違えば「x:路線名」という新しい路線を作る。
# ------------------------------------------------------------
$lineRowByCd = @{}; $lineByName = @{}
foreach ($l in $lineRows) {
  $lineRowByCd[$l.line_cd] = $l
  if (-not $lineByName.ContainsKey($l.line_name)) { $lineByName[$l.line_name] = $l.line_cd }
}
$extraByLine = @{}   # 路線コード → 追加駅の駅コード一覧
foreach ($x in $extraRows) {
  if ($stations.ContainsKey($x.cd)) { Write-Warning "追加駅 $($x.cd) は駅データ.jp に既にあります"; continue }
  $ln = $x.line_name
  if (-not $ln) { $ln = '路線不明（追加駅）' }
  $lcd = $(if ($lineByName.ContainsKey($ln)) { $lineByName[$ln] } else { "x:$ln" })
  $stations[$x.cd] = [ordered]@{
    g      = $x.cd
    name   = $x.name
    line   = $lcd
    pref   = [int]$x.pref_cd
    lat    = [double]$x.lat
    lon    = [double]$x.lon
    closed = ($x.closed -eq '1')
    extra  = $true            # 追加駅の印
  }
  if (-not $extraByLine.ContainsKey($lcd)) { $extraByLine[$lcd] = New-Object System.Collections.ArrayList }
  [void]$extraByLine[$lcd].Add($x.cd)
}

# ------------------------------------------------------------
# 4c. 駅メモの駅（数える単位 = units）
#     駅メモは駅名が違えば別の駅として数える（名古屋と名鉄名古屋は別）。
#     そこで「駅データ.jp の駅グループ ＋ 駅名」を1駅とする。
#     この決まりに合わない駅は data/unit_override.csv で直す。
#       join_cd が空   → その駅だけで1駅にする（同名でも駅メモでは別の駅）
#       join_cd がある → join_cd の駅と同じ1駅にする（表記違い・旧JR山田線など）
#     1駅の番号（unit の id）は、含まれる駅コードのうち一番小さいもの。
# ------------------------------------------------------------
$overrideFile = Join-Path $dataDir 'unit_override.csv'
$overrideRows = @()
if (Test-Path $overrideFile) { $overrideRows = Import-Csv $overrideFile -Encoding UTF8 }

$unitKey = @{}
foreach ($cd in @($stations.Keys)) {
  $s = $stations[$cd]
  $unitKey[$cd] = $(if ($s.extra) { "x|$cd" } else { "$($s.g)|$($s.name)" })
}
# 先に「別の駅にする」、次に「まとめる」を当てはめる
foreach ($o in $overrideRows) {
  if ($o.join_cd) { continue }
  if ($unitKey.ContainsKey($o.station_cd)) { $unitKey[$o.station_cd] = "s|$($o.station_cd)" }
  else { Write-Warning "unit_override.csv の駅コード $($o.station_cd) がマスタにありません" }
}
foreach ($o in $overrideRows) {
  if (-not $o.join_cd) { continue }
  if ($unitKey.ContainsKey($o.station_cd) -and $unitKey.ContainsKey($o.join_cd)) { $unitKey[$o.station_cd] = $unitKey[$o.join_cd] }
  else { Write-Warning "unit_override.csv の $($o.station_cd) → $($o.join_cd) がマスタにありません" }
}

$keyCodes = @{}
foreach ($cd in @($stations.Keys)) {
  $k = $unitKey[$cd]
  if (-not $keyCodes.ContainsKey($k)) { $keyCodes[$k] = New-Object System.Collections.ArrayList }
  [void]$keyCodes[$k].Add($cd)
}
$units = @{}
foreach ($k in $keyCodes.Keys) {
  $codes = @($keyCodes[$k] | Sort-Object)
  $unitId = $codes[0]
  $rep = $stations[$unitId]
  $codeList = New-Object System.Collections.ArrayList
  foreach ($c in $codes) { [void]$codeList.Add($c); $stations[$c]['u'] = $unitId }
  $units[$unitId] = [ordered]@{
    name   = $rep.name
    pref   = $rep.pref
    lat    = $rep.lat
    lon    = $rep.lon
    closed = (@($codes | Where-Object { -not $stations[$_].closed }).Count -eq 0)   # 全部廃止なら廃駅
    codes  = $codeList
  }
}

# ------------------------------------------------------------
# 5. 接続駅（隣り合う駅の組）
#    マスタに無い駅（無料版に含まれない新幹線駅など）を含む行は読み飛ばす。
# ------------------------------------------------------------
$joins = @{}        # 路線コード → [[駅A, 駅B], ...]
$skippedJoin = 0
foreach ($j in $joinRows) {
  if (-not $stations.ContainsKey($j.station_cd1) -or -not $stations.ContainsKey($j.station_cd2)) {
    $skippedJoin++; continue
  }
  if (-not $joins.ContainsKey($j.line_cd)) { $joins[$j.line_cd] = New-Object System.Collections.ArrayList }
  [void]$joins[$j.line_cd].Add(@($j.station_cd1, $j.station_cd2))
}

# ------------------------------------------------------------
# 6. 路線ごとの駅順
#    基本は e_sort（駅データの並び順）。
#    一本道の路線は、接続駅データを端からたどった順を正とし、
#    接続駅データに載らない廃駅は e_sort で直前の駅の後ろに差し込む。
#    分岐・環状の路線は e_sort の順をそのまま使う。
# ------------------------------------------------------------
$stationsByLine = @{}
foreach ($r in $stationRows) {
  if (-not $stationsByLine.ContainsKey($r.line_cd)) { $stationsByLine[$r.line_cd] = New-Object System.Collections.ArrayList }
  [void]$stationsByLine[$r.line_cd].Add($r)
}

$lines = @{}
$shapeCount = @{ path = 0; branch = 0; loop = 0; nojoin = 0 }
$reordered  = New-Object System.Collections.ArrayList   # e_sort と接続順が食い違った路線

foreach ($l in $lineRows) {
  $cd = $l.line_cd
  if (-not $stationsByLine.ContainsKey($cd)) { continue }   # 駅が1つも無い路線は載せない

  # e_sort 順（同じ値なら駅コード順）
  $base = @($stationsByLine[$cd] | Sort-Object { [long]$_.e_sort }, station_cd | ForEach-Object { $_.station_cd })

  # 接続駅データから隣接表を作る
  $adj = @{}
  if ($joins.ContainsKey($cd)) {
    foreach ($pair in $joins[$cd]) {
      $a = $pair[0]; $b = $pair[1]
      if (-not $adj.ContainsKey($a)) { $adj[$a] = New-Object System.Collections.ArrayList }
      if (-not $adj.ContainsKey($b)) { $adj[$b] = New-Object System.Collections.ArrayList }
      if (-not $adj[$a].Contains($b)) { [void]$adj[$a].Add($b) }
      if (-not $adj[$b].Contains($a)) { [void]$adj[$b].Add($a) }
    }
  }

  # 路線の形を判定する
  $shape = 'nojoin'
  if ($adj.Count -gt 0) {
    $ends     = @($adj.Keys | Where-Object { $adj[$_].Count -eq 1 })
    $branches = @($adj.Keys | Where-Object { $adj[$_].Count -ge 3 })
    if ($branches.Count -gt 0 -or $ends.Count -gt 2) { $shape = 'branch' }
    elseif ($ends.Count -eq 0) { $shape = 'loop' }
    else { $shape = 'path' }
  }

  $order = $base
  if ($shape -eq 'path') {
    # e_sort で先に出てくる側の端からたどる
    $start = $base | Where-Object { $adj.ContainsKey($_) -and $adj[$_].Count -eq 1 } | Select-Object -First 1
    $walk = New-Object System.Collections.ArrayList
    $prev = $null; $cur = $start
    while ($cur) {
      [void]$walk.Add($cur)
      $next = $adj[$cur] | Where-Object { $_ -ne $prev } | Select-Object -First 1
      $prev = $cur; $cur = $next
    }
    # たどれた駅数が接続データの駅数と一致すれば一本道として採用
    if ($walk.Count -eq $adj.Count) {
      $activeBase = @($base | Where-Object { $adj.ContainsKey($_) })
      if (($activeBase -join ',') -ne ($walk -join ',')) { [void]$reordered.Add("$cd $($l.line_name)") }

      # 接続データに無い駅（廃駅）を、e_sort で直前にある駅の後ろへ差し込む
      $result = New-Object System.Collections.ArrayList
      $pending = @{}       # 直前の駅コード → 後ろに入れる駅の一覧
      $head = New-Object System.Collections.ArrayList
      $lastActive = $null
      foreach ($s in $base) {
        if ($adj.ContainsKey($s)) { $lastActive = $s; continue }
        if ($lastActive) {
          if (-not $pending.ContainsKey($lastActive)) { $pending[$lastActive] = New-Object System.Collections.ArrayList }
          [void]$pending[$lastActive].Add($s)
        } else { [void]$head.Add($s) }
      }
      foreach ($s in $head) { [void]$result.Add($s) }
      foreach ($s in $walk) {
        [void]$result.Add($s)
        if ($pending.ContainsKey($s)) { foreach ($p in $pending[$s]) { [void]$result.Add($p) } }
      }
      $order = @($result)
    } else {
      $shape = 'branch'
    }
  }
  $shapeCount[$shape]++

  $lines[$cd] = [ordered]@{
    name     = $l.line_name
    company  = $l.company_cd
    closed   = ($l.e_status -eq '2')
    shape    = $shape          # path=一本道 / branch=分岐あり / loop=環状 / nojoin=接続データなし
    stations = @($order)
  }
}

# ------------------------------------------------------------
# 6b. 追加駅を路線の駅順に入れる
#     既にある路線：いちばん近い駅のすぐ後ろに差し込む。
#     新しい路線　：端の駅から「まだ並べていない中で一番近い駅」を順につなぐ。
#     どちらも推定なので、路線に estimated（並び順は推定）の印を付ける。
# ------------------------------------------------------------
function DistKm($a, $b) { $dx = ($a.lon - $b.lon) * 91; $dy = ($a.lat - $b.lat) * 111; [math]::Sqrt($dx * $dx + $dy * $dy) }

foreach ($lcd in $extraByLine.Keys) {
  $codes = @($extraByLine[$lcd])
  if ($lines.ContainsKey($lcd)) {
    $list = New-Object System.Collections.ArrayList
    foreach ($s in $lines[$lcd].stations) { [void]$list.Add($s) }
    foreach ($c in $codes) {
      $best = $null; $bestD = [double]::MaxValue
      foreach ($s in $list) { $d = DistKm $stations[$c] $stations[$s]; if ($d -lt $bestD) { $bestD = $d; $best = $s } }
      $list.Insert($list.IndexOf($best) + 1, $c)
    }
    $lines[$lcd].stations = @($list)
    $lines[$lcd].estimated = $true
  } else {
    # 端の駅＝全体の中心から一番遠い駅
    $cLat = ($codes | % { $stations[$_].lat } | Measure-Object -Average).Average
    $cLon = ($codes | % { $stations[$_].lon } | Measure-Object -Average).Average
    $center = @{ lat = $cLat; lon = $cLon }
    $start = $codes | Sort-Object { - (DistKm $stations[$_] $center) } | Select-Object -First 1
    $order = New-Object System.Collections.ArrayList; [void]$order.Add($start)
    $left = New-Object System.Collections.ArrayList; $codes | ? { $_ -ne $start } | % { [void]$left.Add($_) }
    while ($left.Count -gt 0) {
      $last = $stations[$order[$order.Count - 1]]
      $next = $left | Sort-Object { DistKm $stations[$_] $last } | Select-Object -First 1
      [void]$order.Add($next); $left.Remove($next)
    }
    $row = $lineRowByCd[$lcd]
    $lines[$lcd] = [ordered]@{
      name      = $(if ($row) { $row.line_name } else { $lcd.Substring(2) })
      company   = $(if ($row) { $row.company_cd } else { '' })
      closed    = $(if ($row) { $row.e_status -eq '2' } else { @($codes | ? { -not $stations[$_].closed }).Count -eq 0 })
      shape     = 'nojoin'
      estimated = $true
      stations  = @($order)
    }
    $shapeCount['nojoin']++
  }
}

# ------------------------------------------------------------
# 7. 旧コードの対応表（data/id_alias.csv）
#    エクスポートに残っている古い駅コードを、今の駅コードへ読み替える。
#    読み替えは駅コードを探すより先に行うこと（1122903 のように、駅データ.jp と
#    マップ2で同じ番号が別の駅を指すものがあるため）。読み替えは1回だけ。
# ------------------------------------------------------------
$aliases = [ordered]@{}
foreach ($a in $aliasRows) {
  if (-not $stations.ContainsKey($a.new_cd)) { Write-Warning "対応表の new_cd $($a.new_cd) がマスタにありません（old_cd $($a.old_cd)）"; continue }
  $aliases[$a.old_cd] = $a.new_cd
}

# ------------------------------------------------------------
# 8. 書き出し
# ------------------------------------------------------------
$master = [ordered]@{
  builtAt = (Get-Date -Format 'yyyy-MM-dd HH:mm')
  sources = [ordered]@{ station = $stationFile.Name; line = $lineFile.Name; join = $joinFile.Name }
  stations = $stations
  units    = $units
  lines    = $lines
  joins    = $joins
  aliases  = $aliases
}
$json = $master | ConvertTo-Json -Depth 6 -Compress

New-Item -ItemType Directory -Force $outDir | Out-Null
$text = "// 自動生成ファイル（tools/build-master.ps1）。手で編集しないこと。`n" +
        "// 駅データ.jp のデータを加工して作成: https://ekidata.jp/`n" +
        "window.EKIMEMO_MASTER = $json;`n"
$outFile = Join-Path $outDir 'master.js'
[IO.File]::WriteAllText($outFile, $text, (New-Object Text.UTF8Encoding $false))

# ------------------------------------------------------------
# 9. 結果の表示
# ------------------------------------------------------------
$closedUnits = @($units.Values | Where-Object { $_.closed }).Count
Write-Host ""
Write-Host "=== 構築結果 ==="
Write-Host "運用前のため除外した駅コード : $excludedCount"
Write-Host "駅メモに無いため外した駅コード: $excludedHit（つなぎ直した接続 $($bridgeJoins.Count) 組）"
Write-Host "駅コード数                   : $($stations.Count)"
Write-Host "駅メモの駅数（数える単位）   : $($units.Count)（うち廃駅 $closedUnits）"
Write-Host "例外の表（unit_override）    : $($overrideRows.Count) 行"
Write-Host "路線数                       : $($lines.Count)"
Write-Host "  一本道 $($shapeCount.path) / 分岐 $($shapeCount.branch) / 環状 $($shapeCount.loop) / 接続データなし $($shapeCount.nojoin)"
Write-Host "読み飛ばした接続駅データ     : $skippedJoin 行（マスタに無い駅を含む）"
Write-Host "追加駅                       : $($extraRows.Count) 駅（$($extraByLine.Count) 路線に配置）"
Write-Host "旧コード対応表               : $($aliases.Count) 件"
Write-Host "e_sort と接続順が違った路線  : $($reordered.Count) 本（接続順を採用）"
$reordered | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "出力: $outFile ($([math]::Round((Get-Item $outFile).Length / 1KB)) KB)"
