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
# 4b2. 駅名・廃駅の修正（data/station_fix.csv）
#     駅データ.jp と駅メモで、駅名や廃駅かどうかが違う駅を直す。
#       name   : 空でなければ、その駅名に変える
#       closed : 1 なら廃駅にする、0 なら現役にする、空なら変えない
#     「駅メモの駅」をまとめる前に直すので、まとめた結果にも反映される。
# ------------------------------------------------------------
$fixFile = Join-Path $dataDir 'station_fix.csv'
$fixRows = @()
if (Test-Path $fixFile) { $fixRows = @(Import-Csv $fixFile -Encoding UTF8) }   # 1行だけでも一覧として扱う
foreach ($f in $fixRows) {
  if (-not $stations.ContainsKey($f.station_cd)) { Write-Warning "station_fix.csv の駅コード $($f.station_cd) がマスタにありません"; continue }
  if ($f.name) { $stations[$f.station_cd]['name'] = $f.name }
  if ($f.closed -eq '1') { $stations[$f.station_cd]['closed'] = $true }
  if ($f.closed -eq '0') { $stations[$f.station_cd]['closed'] = $false }
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
#     既にある路線：差し込んでも遠回りがいちばん少ない場所に入れる。
#     新しい路線　：端の駅から「まだ並べていない中で一番近い駅」を順につなぐ。
#     どちらも推定なので、路線に estimated（並び順は推定）の印を付ける。
# ------------------------------------------------------------
function DistKm($a, $b) { $dx = ($a.lon - $b.lon) * 91; $dy = ($a.lat - $b.lat) * 111; [math]::Sqrt($dx * $dx + $dy * $dy) }

# 並び（$list）の中で、駅 $c を入れたときに道のりの増え方が一番少ない場所に差し込む。
# 両端の外側（先頭の前・最後の後ろ）も候補にする。
function InsertCheapest($list, $c) {
  if ($list.Count -eq 0) { [void]$list.Add($c); return }
  $p = $stations[$c]
  $bestAt = 0; $bestCost = DistKm $p $stations[$list[0]]                     # 先頭の前
  $endCost = DistKm $p $stations[$list[$list.Count - 1]]                     # 最後の後ろ
  if ($endCost -lt $bestCost) { $bestAt = $list.Count; $bestCost = $endCost }
  for ($i = 0; $i -lt $list.Count - 1; $i++) {                               # 駅と駅のあいだ
    $a = $stations[$list[$i]]; $b = $stations[$list[$i + 1]]
    $cost = (DistKm $a $p) + (DistKm $p $b) - (DistKm $a $b)
    if ($cost -lt $bestCost) { $bestAt = $i + 1; $bestCost = $cost }
  }
  $list.Insert($bestAt, $c)
}

foreach ($lcd in $extraByLine.Keys) {
  $codes = @($extraByLine[$lcd])
  if ($lines.ContainsKey($lcd)) {
    $list = New-Object System.Collections.ArrayList
    foreach ($s in $lines[$lcd].stations) { [void]$list.Add($s) }
    foreach ($c in $codes) { InsertCheapest $list $c }
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
# 6c. 路線名を駅メモの表記に直す（data/line_names.csv）
#     name       : 空でなければ、その路線名に変える
#     merge_into : 路線コードがあれば、その路線にまとめる（駅を移して、元の路線は無くす）
#                  駅メモには無く、駅がほかの路線と重なる路線（京王新線など）に使う
# ------------------------------------------------------------
$lineNameFile = Join-Path $dataDir 'line_names.csv'
$lineNameRows = @()
if (Test-Path $lineNameFile) { $lineNameRows = @(Import-Csv $lineNameFile -Encoding UTF8) }
$mergedLines = 0; $renamedLines = 0

foreach ($r in ($lineNameRows | Where-Object { $_.merge_into })) {
  $src = $r.line_cd; $dst = $r.merge_into
  if (-not $lines.ContainsKey($src) -or -not $lines.ContainsKey($dst)) { Write-Warning "line_names.csv: $src → $dst の路線がありません"; continue }
  $list = New-Object System.Collections.ArrayList
  foreach ($s in $lines[$dst].stations) { [void]$list.Add($s) }
  $have = @{}; foreach ($s in $list) { $have[$stations[$s]['u']] = $true }
  foreach ($c in $lines[$src].stations) {
    if (-not $have.ContainsKey($stations[$c]['u'])) { InsertCheapest $list $c; $have[$stations[$c]['u']] = $true }
    $stations[$c]['line'] = $dst    # 駅の路線も付け替える
  }
  $lines[$dst].stations = @($list)
  $lines[$dst].estimated = $true
  # 接続駅データも移す（あとで経路を計算するときに使う）
  if ($joins.ContainsKey($src)) {
    if (-not $joins.ContainsKey($dst)) { $joins[$dst] = New-Object System.Collections.ArrayList }
    foreach ($pair in $joins[$src]) { [void]$joins[$dst].Add($pair) }
    $joins.Remove($src)
  }
  $lines.Remove($src)
  $mergedLines++
}
foreach ($r in ($lineNameRows | Where-Object { $_.name })) {
  if (-not $lines.ContainsKey($r.line_cd)) { Write-Warning "line_names.csv: 路線コード $($r.line_cd) がありません"; continue }
  $lines[$r.line_cd]['name'] = $r.name
  $renamedLines++
}

# ------------------------------------------------------------
# 6d. 駅メモにだけある路線を足す（data/line_virtual.csv）
#     駅メモには、ほかの路線と同じ駅を持つ古い名前の路線などがある（北リアス線・旧広電など）。
#     駅はすでにある駅をそのまま使う（駅数は変わらない）。路線の数え方だけが増える。
#       name       : 路線名
#       closed     : 1 なら廃路線
#       base_lines : 駅を探す路線（; で区切る。名前を直したあとの路線名）
#       stations   : 駅の並び（| で区切る。駅メモの駅の名前）
# ------------------------------------------------------------
$virtualFile = Join-Path $dataDir 'line_virtual.csv'
$virtualRows = @()
if (Test-Path $virtualFile) { $virtualRows = @(Import-Csv $virtualFile -Encoding UTF8) }
$lineCdByName = @{}
foreach ($lc in $lines.Keys) { if (-not $lineCdByName.ContainsKey($lines[$lc]['name'])) { $lineCdByName[$lines[$lc]['name']] = $lc } }
$virtualAdded = 0
foreach ($v in $virtualRows) {
  # 探す路線の駅：駅メモの駅の名前 → 駅コード（最初に見つかったもの）
  $codeByName = @{}
  foreach ($bn in ($v.base_lines -split ';')) {
    if (-not $lineCdByName.ContainsKey($bn)) { Write-Warning "line_virtual.csv: 「$($v.name)」の base_lines「$bn」がありません"; continue }
    foreach ($c in $lines[$lineCdByName[$bn]]['stations']) {
      $un = $units[$stations[$c]['u']].name
      if (-not $codeByName.ContainsKey($un)) { $codeByName[$un] = $c }
    }
  }
  $codes = New-Object System.Collections.ArrayList
  foreach ($sn in ($v.stations -split '\|')) {
    if ($codeByName.ContainsKey($sn)) { [void]$codes.Add($codeByName[$sn]) }
    else { Write-Warning "line_virtual.csv: 「$($v.name)」の駅「$sn」が見つかりません" }
  }
  if ($codes.Count -eq 0) { continue }
  $lines["v:$($v.name)"] = [ordered]@{
    name      = $v.name
    company   = ''
    closed    = ($v.closed -eq '1')
    shape     = 'nojoin'
    estimated = $false
    virtual   = $true          # 駅メモにだけある路線（駅はほかの路線と同じ）
    stations  = @($codes)
  }
  $virtualAdded++
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
# 7b. 前の駅マスタと比べる（F10：新駅・廃駅の差分の知らせ）
#     いまある master/master.js（前回作ったもの）と比べて、変わったことを
#     master/changes.js に書き足す。アプリはこれを見て知らせる。
#     駅は駅コードで突き合わせる（「駅メモの駅」の番号は、乗換駅が増えると変わることがあるため）。
# ------------------------------------------------------------
$builtAt = Get-Date -Format 'yyyy-MM-dd HH:mm'
$changesFile = Join-Path $outDir 'changes.js'
$CHANGES_KEEP = 20   # 残しておく更新の記録の数

function Read-JsData($path) {
  # window.XXX = {...}; の形のファイルから、中身を読み出す
  if (-not (Test-Path $path)) { return $null }
  $txt = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
  $start = $txt.IndexOf('='); $end = $txt.LastIndexOf(';')
  if ($start -lt 0 -or $end -le $start) { return $null }
  Add-Type -AssemblyName System.Web.Extensions
  $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $ser.MaxJsonLength = [int]::MaxValue
  return $ser.DeserializeObject($txt.Substring($start + 1, $end - $start - 1).Trim())
}

$old = Read-JsData (Join-Path $outDir 'master.js')
$changeEntry = $null
if ($old) {
  # 前の駅マスタ：駅コード → 駅メモの駅、駅メモの駅 → 通る路線
  $oldUnitOf = @{}
  foreach ($c in $old.stations.Keys) { $oldUnitOf[$c] = $old.stations[$c]['u'] }
  $oldLinesOf = @{}
  foreach ($lc in $old.lines.Keys) {
    foreach ($c in $old.lines[$lc]['stations']) {
      $ou = $oldUnitOf[$c]
      if (-not $oldLinesOf.ContainsKey($ou)) { $oldLinesOf[$ou] = @{} }
      $oldLinesOf[$ou][$lc] = $true
    }
  }
  # 今の駅マスタ：駅メモの駅 → 通る路線
  $newLinesOf = @{}
  foreach ($lc in $lines.Keys) {
    foreach ($c in $lines[$lc].stations) {
      $nu = $stations[$c]['u']
      if (-not $newLinesOf.ContainsKey($nu)) { $newLinesOf[$nu] = @{} }
      $newLinesOf[$nu][$lc] = $true
    }
  }

  $added = New-Object System.Collections.ArrayList
  $closedNow = New-Object System.Collections.ArrayList
  $reopened = New-Object System.Collections.ArrayList
  $lineAdded = [ordered]@{}
  $matchedOld = @{}
  foreach ($u in $units.Keys) {
    $unit = $units[$u]
    $olds = @($unit.codes | Where-Object { $oldUnitOf.ContainsKey($_) } | ForEach-Object { $oldUnitOf[$_] } | Select-Object -Unique)
    $olds | ForEach-Object { $matchedOld[$_] = $true }
    $info = [ordered]@{ u = $u; name = $unit.name; pref = $unit.pref }
    if ($olds.Count -eq 0) {
      [void]$added.Add($info)                       # 新しく加わった駅
    } else {
      $o = $old.units[$olds[0]]
      if ($unit.closed -and -not $o['closed']) { [void]$closedNow.Add($info) }   # 廃駅になった
      if (-not $unit.closed -and $o['closed']) { [void]$reopened.Add($info) }    # 現役に戻った
    }
    # 路線に加わった駅（前はその路線に無かった）
    $oldLines = @{}
    foreach ($ou in $olds) { if ($oldLinesOf.ContainsKey($ou)) { foreach ($k in $oldLinesOf[$ou].Keys) { $oldLines[$k] = $true } } }
    if ($newLinesOf.ContainsKey($u)) {
      foreach ($lc in $newLinesOf[$u].Keys) {
        if ($oldLines.ContainsKey($lc)) { continue }
        if (-not $lineAdded.Contains($lc)) { $lineAdded[$lc] = New-Object System.Collections.ArrayList }
        [void]$lineAdded[$lc].Add($u)
      }
    }
  }
  # 無くなった駅（前の駅メモの駅で、今の駅マスタに駅コードが1つも残っていないもの）
  $removed = New-Object System.Collections.ArrayList
  foreach ($ou in $old.units.Keys) {
    if ($matchedOld.ContainsKey($ou)) { continue }
    $o = $old.units[$ou]
    [void]$removed.Add([ordered]@{ name = $o['name']; pref = $o['pref'] })
  }
  # 名前が変わった路線
  $renamed = New-Object System.Collections.ArrayList
  foreach ($lc in $lines.Keys) {
    if ($old.lines.ContainsKey($lc) -and $old.lines[$lc]['name'] -ne $lines[$lc].name) {
      [void]$renamed.Add([ordered]@{ line = $lc; from = $old.lines[$lc]['name']; to = $lines[$lc].name })
    }
  }

  $total = $added.Count + $closedNow.Count + $reopened.Count + $removed.Count + $lineAdded.Count + $renamed.Count
  if ($total -gt 0) {
    $changeEntry = [ordered]@{
      builtAt = $builtAt; from = $old.builtAt
      added = $added; closed = $closedNow; reopened = $reopened; removed = $removed
      lineAdded = $lineAdded; renamedLines = $renamed
    }
  }
}

# 更新の記録を書き足す（新しいものを先頭に。古いものは捨てる）
$history = New-Object System.Collections.ArrayList
$oldHistory = Read-JsData $changesFile
if ($changeEntry) { [void]$history.Add($changeEntry) }
if ($oldHistory) { foreach ($h in $oldHistory) { if ($history.Count -lt $CHANGES_KEEP) { [void]$history.Add($h) } } }
New-Item -ItemType Directory -Force $outDir | Out-Null
$historyJson = ConvertTo-Json -InputObject @($history) -Depth 6 -Compress
if ($history.Count -eq 0) { $historyJson = '[]' }
$changesText = "// 自動生成ファイル（tools/build-master.ps1）。駅マスタの更新の記録（新しい順）。`n" +
               "window.EKIMEMO_CHANGES = $historyJson;`n"
[IO.File]::WriteAllText($changesFile, $changesText, (New-Object Text.UTF8Encoding $false))

# ------------------------------------------------------------
# 8. 書き出し
# ------------------------------------------------------------
$master = [ordered]@{
  builtAt = $builtAt
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
Write-Host "駅名・廃駅の修正（station_fix）: $($fixRows.Count) 行"
Write-Host "路線数                       : $($lines.Count)"
Write-Host "  一本道 $($shapeCount.path) / 分岐 $($shapeCount.branch) / 環状 $($shapeCount.loop) / 接続データなし $($shapeCount.nojoin)"
Write-Host "読み飛ばした接続駅データ     : $skippedJoin 行（マスタに無い駅を含む）"
Write-Host "追加駅                       : $($extraRows.Count) 駅（$($extraByLine.Count) 路線に配置）"
Write-Host "路線名の修正（line_names）   : 名前を変えた $renamedLines 路線 / まとめた $mergedLines 路線"
Write-Host "駅メモにだけある路線（line_virtual）: $virtualAdded 路線を追加"
Write-Host "旧コード対応表               : $($aliases.Count) 件"
Write-Host "e_sort と接続順が違った路線  : $($reordered.Count) 本（接続順を採用）"
$reordered | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
if ($changeEntry) {
  Write-Host "前回（$($changeEntry.from)）との違い: 新駅 $($changeEntry.added.Count) / 廃駅になった $($changeEntry.closed.Count) / 現役に戻った $($changeEntry.reopened.Count) / 無くなった $($changeEntry.removed.Count) / 駅が加わった路線 $($changeEntry.lineAdded.Count) / 名前が変わった路線 $($changeEntry.renamedLines.Count)"
} elseif ($old) {
  Write-Host "前回（$($old.builtAt)）との違い: なし"
}
Write-Host ""
Write-Host "出力: $outFile ($([math]::Round((Get-Item $outFile).Length / 1KB)) KB)"
Write-Host "（地図の線路の形も作り直すときは、続けて tools\build-shapes.ps1 を動かしてください）"
