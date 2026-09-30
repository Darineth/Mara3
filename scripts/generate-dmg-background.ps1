# Regenerate the macOS DMG window background: apps/shell/src-tauri/dmg/background.tiff.
#
#   powershell -File scripts/generate-dmg-background.ps1
#
# The DMG opens as a 660x400 Finder window with the app icon at (180,170) and the
# Applications shortcut at (480,170) — see bundle.macOS.dmg in tauri.macos.conf.json. This
# draws the arrow between them and the hint underneath, so keep the two in step.
#
# The output is one TIFF holding a 1x frame at 72 dpi and a 2x frame at 144 dpi — the same
# shape `tiffutil -cathidpicheck` makes — so Finder shows the sharp frame on Retina screens.
# Windows-only (System.Drawing), which is where the release is driven from.

Add-Type -AssemblyName System.Drawing

$out = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\apps\shell\src-tauri\dmg\background.tiff'))
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null

function New-Frame([int]$scale) {
  $w = 660 * $scale; $h = 400 * $scale
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $bmp.SetResolution(72 * $scale, 72 * $scale)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'

  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect,
    ([System.Drawing.Color]::FromArgb(248, 249, 252)),
    ([System.Drawing.Color]::FromArgb(231, 236, 245)), 90
  $g.FillRectangle($bg, $rect)

  # Opaque, so the head and shaft don't darken where they overlap.
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(166, 180, 212)), (7 * $scale)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $y = 170 * $scale
  $g.DrawLine($pen, 272 * $scale, $y, 384 * $scale, $y)
  $g.DrawLines($pen, [System.Drawing.PointF[]]@(
      (New-Object System.Drawing.PointF (362 * $scale), (152 * $scale)),
      (New-Object System.Drawing.PointF (386 * $scale), $y),
      (New-Object System.Drawing.PointF (362 * $scale), (188 * $scale))))

  # GraphicsUnit::Pixel — a point size would scale with the frame's dpi a second time.
  $font = New-Object System.Drawing.Font 'Segoe UI', (15 * $scale),
    ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(110, 120, 140))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $g.DrawString('Drag Mara 3 into Applications to install', $font, $brush,
    (New-Object System.Drawing.RectangleF 0, (318 * $scale), $w, (30 * $scale)), $fmt)

  $g.Dispose()
  return $bmp
}

$one = New-Frame 1
$two = New-Frame 2
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq 'image/tiff' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$saveFlag = [System.Drawing.Imaging.Encoder]::SaveFlag
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter $saveFlag,
  ([long][System.Drawing.Imaging.EncoderValue]::MultiFrame)
$one.Save($out, $codec, $params)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter $saveFlag,
  ([long][System.Drawing.Imaging.EncoderValue]::FrameDimensionPage)
$one.SaveAdd($two, $params)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter $saveFlag,
  ([long][System.Drawing.Imaging.EncoderValue]::Flush)
$one.SaveAdd($params)
$one.Dispose(); $two.Dispose()
Write-Output "wrote $out"
