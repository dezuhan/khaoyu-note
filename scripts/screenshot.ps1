param(
    [string]$Out = (Join-Path $PSScriptRoot '..\shots\app.png'),
    [string]$ProcessName = 'khaoyu-note'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
}
"@ -ErrorAction SilentlyContinue

$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOMOVE = 0x0002
$SWP_NOSIZE = 0x0001
$SWP_SHOWWINDOW = 0x0040

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
if (-not $proc) { throw "$ProcessName is not running (no window found)" }

$handle = $proc.MainWindowHandle
if ([WinCap]::IsIconic($handle)) { [WinCap]::ShowWindow($handle, 9) | Out-Null; Start-Sleep -Milliseconds 500 }
# Force the window above other apps: foreground changes are blocked for background shells,
# but a temporary TOPMOST placement is allowed and gives us a clean capture.
[WinCap]::SetWindowPos($handle, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW) | Out-Null
[WinCap]::BringWindowToTop($handle) | Out-Null
[WinCap]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 1200

$rect = New-Object WinCap+RECT
[WinCap]::GetWindowRect($handle, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw "invalid window rect" }

$bmp = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
$graphics.Dispose()
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

"CAPTURED $Out ($width x $height)"

