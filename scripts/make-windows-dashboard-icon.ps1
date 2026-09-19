#Requires -Version 5.1
<#
.SYNOPSIS
Renders assets/windows/prime-agent-dashboard.ico in the same style as prime-agent.ico
(black slab, yellow frame, white accent) with a 2x2 tile grid for the sessions dashboard.

.DESCRIPTION
The icon is drawn with System.Drawing at 256 px and downsampled to the standard shell
sizes; every size is stored as a PNG-compressed ICO entry. No external tooling needed.

.PARAMETER OutputPath
Where to write the .ico. Defaults to assets/windows/prime-agent-dashboard.ico.
#>
[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is not bound while parameter defaults are evaluated on Windows PowerShell 5.1.
if (-not $OutputPath) { $OutputPath = Join-Path $PSScriptRoot '..\assets\windows\prime-agent-dashboard.ico' }
Add-Type -AssemblyName System.Drawing

$Yellow = [System.Drawing.Color]::FromArgb(0xFC, 0xEE, 0x0A)
$Black = [System.Drawing.Color]::FromArgb(0x05, 0x05, 0x06)
$White = [System.Drawing.Color]::FromArgb(0xF4, 0xF4, 0xF0)

function New-DashboardBitmap([int]$Size) {
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $g.Clear($Black)

        # Yellow frame matching prime-agent.ico (frame thickness ~5% of the size).
        $frame = [Math]::Max(1, [int][Math]::Round($Size * 0.05))
        $inset = [int][Math]::Round($Size * 0.03)
        $yellowBrush = New-Object System.Drawing.SolidBrush $Yellow
        $blackBrush = New-Object System.Drawing.SolidBrush $Black
        $whiteBrush = New-Object System.Drawing.SolidBrush $White
        try {
            $g.FillRectangle($yellowBrush, $inset, $inset, $Size - 2 * $inset, $Size - 2 * $inset)
            $g.FillRectangle($blackBrush, $inset + $frame, $inset + $frame, $Size - 2 * ($inset + $frame), $Size - 2 * ($inset + $frame))

            # 2x2 tile grid: three solid yellow tiles and one white "live" tile.
            $pad = [int][Math]::Round($Size * 0.20)
            $gap = [Math]::Max(1, [int][Math]::Round($Size * 0.06))
            $tile = [int](($Size - 2 * $pad - $gap) / 2)
            $x0 = $pad
            $y0 = $pad
            $x1 = $pad + $tile + $gap
            $y1 = $pad + $tile + $gap
            $g.FillRectangle($yellowBrush, $x0, $y0, $tile, $tile)
            $g.FillRectangle($yellowBrush, $x1, $y0, $tile, $tile)
            $g.FillRectangle($yellowBrush, $x0, $y1, $tile, $tile)
            $g.FillRectangle($whiteBrush, $x1, $y1, $tile, $tile)

            # Header notch on the top-left tile, echoing the overlay's slab header.
            $notch = [Math]::Max(1, [int][Math]::Round($tile * 0.22))
            $g.FillRectangle($blackBrush, $x0 + $notch, $y0 + $notch, $tile - 2 * $notch, $notch)
        } finally {
            $yellowBrush.Dispose(); $blackBrush.Dispose(); $whiteBrush.Dispose()
        }
    } finally {
        $g.Dispose()
    }
    return $bmp
}

function Resize-Bitmap([System.Drawing.Bitmap]$Source, [int]$Size) {
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.DrawImage($Source, 0, 0, $Size, $Size)
    } finally {
        $g.Dispose()
    }
    return $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$Bitmap) {
    $ms = New-Object System.IO.MemoryStream
    try {
        $Bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        return $ms.ToArray()
    } finally {
        $ms.Dispose()
    }
}

# Classic 32bpp DIB entry (BITMAPINFOHEADER + bottom-up BGRA rows + empty AND mask). GDI+ and
# older shell consumers cannot decode PNG-compressed entries below 256 px, so only the 256 px
# entry is stored as PNG.
function Get-DibBytes([System.Drawing.Bitmap]$Bitmap) {
    $w = $Bitmap.Width
    $h = $Bitmap.Height
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $data.Stride
        $pixels = New-Object byte[] ($stride * $h)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
    } finally {
        $Bitmap.UnlockBits($data)
    }
    $maskStride = [int]((($w + 31) -band -bnot 31) / 8)
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms
    try {
        $bw.Write([UInt32]40)            # biSize
        $bw.Write([Int32]$w)             # biWidth
        $bw.Write([Int32]($h * 2))       # biHeight: XOR + AND masks
        $bw.Write([UInt16]1)             # biPlanes
        $bw.Write([UInt16]32)            # biBitCount
        $bw.Write([UInt32]0)             # biCompression = BI_RGB
        $bw.Write([UInt32]($w * $h * 4)) # biSizeImage
        $bw.Write([Int32]0); $bw.Write([Int32]0); $bw.Write([UInt32]0); $bw.Write([UInt32]0)
        for ($row = $h - 1; $row -ge 0; $row--) {
            $bw.Write($pixels, $row * $stride, $w * 4)
        }
        $bw.Write((New-Object byte[] ($maskStride * $h)))
        $bw.Flush()
        return $ms.ToArray()
    } finally {
        $bw.Dispose()
    }
}

$sizes = @(256, 128, 64, 48, 32, 24, 16)
$master = New-DashboardBitmap 256
$entries = @()
try {
    foreach ($size in $sizes) {
        $bmp = if ($size -eq 256) { $master } else { Resize-Bitmap $master $size }
        try {
            $payload = if ($size -eq 256) { Get-PngBytes $bmp } else { Get-DibBytes $bmp }
            $entries += [pscustomobject]@{ Size = $size; Bytes = $payload }
        } finally {
            if ($size -ne 256) { $bmp.Dispose() }
        }
    }
} finally {
    $master.Dispose()
}

# ICO container: ICONDIR + ICONDIRENTRY[] + payloads. A width/height byte of 0 means 256.
$headerSize = 6 + 16 * $entries.Count
$offset = $headerSize
$writer = New-Object System.IO.BinaryWriter ([System.IO.MemoryStream]::new())
try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$entries.Count)
    foreach ($entry in $entries) {
        $dim = if ($entry.Size -ge 256) { 0 } else { $entry.Size }
        $writer.Write([byte]$dim)
        $writer.Write([byte]$dim)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$entry.Bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $entry.Bytes.Length
    }
    # PowerShell unrolls byte[] into Object[]; the BinaryWriter needs the typed array back.
    foreach ($entry in $entries) { $writer.Write([byte[]]$entry.Bytes) }
    $writer.Flush()
    $bytes = $writer.BaseStream.ToArray()
} finally {
    $writer.Dispose()
}

$resolved = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path -Parent $resolved) -Force | Out-Null
[System.IO.File]::WriteAllBytes($resolved, $bytes)
Write-Host "Wrote $resolved ($($bytes.Length) bytes, sizes: $($sizes -join ', '))"
