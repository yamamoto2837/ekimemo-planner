# ============================================================
# 確認用の簡易サーバー（このPCの中だけで動く）
#
# 実行方法（プロジェクトのフォルダで）:
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1
# ブラウザで http://localhost:8000/ を開く。止めるときは Ctrl + C。
# ============================================================
param([int]$Port = 8000)

$root = Split-Path $PSScriptRoot -Parent
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "http://localhost:$Port/ で公開中（フォルダ: $root）"

# 拡張子ごとのファイルの種類
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8';  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'; '.svg' = 'image/svg+xml'; '.csv' = 'text/csv; charset=utf-8'
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    # 1つの問い合わせでエラーが起きても、サーバー全体は止めない
    try {
      $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ($path -eq '' -or $path.EndsWith('/')) { $path += 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path))

      # プロジェクトのフォルダの外は見せない
      if ($file.StartsWith($root + [IO.Path]::DirectorySeparatorChar) -and (Test-Path $file -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $ext = [IO.Path]::GetExtension($file).ToLower()
        $ctx.Response.ContentType = $(if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' })
        $ctx.Response.Headers['Cache-Control'] = 'no-store'   # 直したファイルがすぐ反映されるように
        $ctx.Response.ContentLength64 = $bytes.Length
        # HEAD（中身はいらない問い合わせ）のときは中身を送らない
        if ($ctx.Request.HttpMethod -ne 'HEAD') { $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length) }
      } else {
        $ctx.Response.StatusCode = 404
      }
    } catch {
      Write-Host "エラー: $($ctx.Request.Url) $($_.Exception.Message)"
    } finally {
      try { $ctx.Response.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
