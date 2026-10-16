// Windows-only helpers: list top-level windows and watch one of them.
// Electron cannot see other apps' windows, so a PowerShell process calls user32 for us.
const { spawn } = require('child_process');

const SUPPORTED = process.platform === 'win32';

const NATIVE = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
[StructLayout(LayoutKind.Sequential)] public struct WRECT { public int L, T, R, B; }
public delegate bool EnumProc(IntPtr h, IntPtr l);
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out WRECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmRect(IntPtr h, int a, out WRECT r, int s);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmInt(IntPtr h, int a, out int v, int s);
}
public static class Watch {
  public static void Run(long target) {
    IntPtr h = new IntPtr(target);
    string last = "";
    while (true) {
      bool alive = W.IsWindow(h);
      int min = 0; WRECT rc = new WRECT();
      if (alive) {
        if (W.IsIconic(h)) min = 1;
        if (W.DwmRect(h, 9, out rc, 16) != 0) W.GetWindowRect(h, out rc);
      }
      IntPtr fg = W.GetForegroundWindow();
      uint fgPid; W.GetWindowThreadProcessId(fg, out fgPid);
      int focused = fg.ToInt64() == target ? 1 : 0;
      string line = (alive ? 1 : 0) + "|" + min + "|" + focused + "|" + fgPid + "|" + rc.L + "|" + rc.T + "|" + rc.R + "|" + rc.B;
      if (line != last) { Console.Out.WriteLine(line); Console.Out.Flush(); last = line; }
      System.Threading.Thread.Sleep(8);
    }
  }
}
'@
[void][W]::SetProcessDpiAwarenessContext([IntPtr](-4))
`;

const LIST_SCRIPT = NATIVE + String.raw`
$own = __OWNPID__
$res = New-Object System.Collections.ArrayList
$cb = [EnumProc]{
  param($h, $l)
  if (-not [W]::IsWindowVisible($h)) { return $true }
  # Skip tool windows, click-through windows and non-activating windows (other overlays, including our own kind)
  if (([W]::GetWindowLong($h, -20) -band (0x80 -bor 0x20 -bor 0x08000000)) -ne 0) { return $true }
  $cloaked = 0
  [void][W]::DwmInt($h, 14, [ref]$cloaked, 4)
  if ($cloaked -ne 0) { return $true }
  $sb = New-Object System.Text.StringBuilder 256
  [void][W]::GetWindowText($h, $sb, 256)
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title) -or $title -eq 'Program Manager') { return $true }
  $wpid = 0
  [void][W]::GetWindowThreadProcessId($h, [ref]$wpid)
  if ($wpid -eq $own) { return $true }
  $p = Get-Process -Id $wpid -ErrorAction SilentlyContinue
  [void]$res.Add([pscustomobject]@{ hwnd = $h.ToInt64(); title = $title; proc = $p.ProcessName })
  return $true
}
[void][W]::EnumWindows($cb, [IntPtr]::Zero)
ConvertTo-Json -Compress -InputObject @($res)
`;

// One line per change: alive|minimized|focused|foregroundPid|left|top|right|bottom
// The loop is compiled C# (not PowerShell) so it can poll every ~8 ms without lag while a window is dragged.
const WATCH_SCRIPT = NATIVE + String.raw`
[Watch]::Run(__HWND__)
`;

function spawnScript(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true },
  );
}

function listWindows() {
  if (!SUPPORTED) return Promise.resolve([]);
  return new Promise((resolve) => {
    const proc = spawnScript(LIST_SCRIPT.replace('__OWNPID__', String(process.pid)));
    let out = '';
    const timer = setTimeout(() => proc.kill(), 10000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('error', () => { clearTimeout(timer); resolve([]); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.replace(/^﻿/, '').trim() || '[]');
        const list = (Array.isArray(parsed) ? parsed : [parsed])
          .filter((w) => w && w.hwnd && w.title)
          .map((w) => ({ hwnd: String(w.hwnd), title: String(w.title), proc: String(w.proc || '') }));
        resolve(list);
      } catch (_) {
        resolve([]);
      }
    });
  });
}

// Calls onState({alive, minimized, focused, fgPid, rect:{x,y,width,height}}) on every change.
// Returns { stop() }. onExit fires if the helper dies on its own.
function watchWindow(hwnd, onState, onExit) {
  const id = Number(hwnd);
  if (!SUPPORTED || !Number.isSafeInteger(id)) return { stop() {} };
  const proc = spawnScript(WATCH_SCRIPT.replace('__HWND__', String(id)));
  let stopped = false;
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const p = line.split('|').map(Number);
      if (p.length !== 8 || p.some(Number.isNaN)) continue;
      onState({
        alive: p[0] === 1,
        minimized: p[1] === 1,
        focused: p[2] === 1,
        fgPid: p[3],
        rect: { x: p[4], y: p[5], width: p[6] - p[4], height: p[7] - p[5] },
      });
    }
  });
  proc.on('error', () => { if (!stopped) onExit(); });
  proc.on('exit', () => { if (!stopped) onExit(); });
  return {
    stop() {
      stopped = true;
      proc.kill();
    },
  };
}

module.exports = { SUPPORTED, listWindows, watchWindow };
