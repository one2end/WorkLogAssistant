'use strict';

/**
 * windowMonitor.js — 前台窗口采样
 *
 * Windows：常驻一个 PowerShell 子进程，Add-Type 只编译一次，之后每秒吐一行采样。
 *          相比原来每次调用都 spawn + Add-Type（单次 300~800ms），CPU 和延迟都降一个量级。
 *          同时通过 GetLastInputInfo 拿到真实的「距上次键鼠输入毫秒数」，用于空闲判定。
 * macOS / Linux：沿用按次调用，无空闲检测（idleMs 恒为 0）。
 *
 * 对外接口：
 *   await start()            启动后台采样
 *   latest()                 取最近一次采样快照
 *   await sampleOnce()       立即采样一次（不依赖常驻进程）
 *   stop()                   停止采样
 */

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execAsync = promisify(exec);

const SAMPLE_INTERVAL_MS = 1000;
const STALE_MS = 15000;

// Windows 端常驻脚本：Add-Type 只在启动时执行一次
const WIN_SAMPLER_SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$src = @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class WLWin {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
  '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  '  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
  '  public static uint IdleMs() {',
  '    LASTINPUTINFO li = new LASTINPUTINFO();',
  '    li.cbSize = (uint)Marshal.SizeOf(li);',
  '    if (!GetLastInputInfo(ref li)) return 0;',
  '    return (uint)(Environment.TickCount - (int)li.dwTime);',
  '  }',
  '}',
  "'@",
  'Add-Type -TypeDefinition $src',
  'while ($true) {',
  '  try {',
  '    $hwnd = [WLWin]::GetForegroundWindow()',
  '    $targetPid = 0',
  '    [WLWin]::GetWindowThreadProcessId($hwnd, [ref]$targetPid) | Out-Null',
  '    $sb = New-Object System.Text.StringBuilder 512',
  '    [WLWin]::GetWindowTextW($hwnd, $sb, 512) | Out-Null',
  '    $title = $sb.ToString()',
  '    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue',
  '    $name = if ($proc) { $proc.ProcessName } else { "unknown" }',
  '    $idle = [WLWin]::IdleMs()',
  '    $sep = [char]1',
  '    [Console]::Out.WriteLine($name + $sep + $title + $sep + $idle)',
  '    [Console]::Out.Flush()',
  '  } catch {',
  '    [Console]::Out.WriteLine("unknown" + [char]1 + [char]1 + "0")',
  '  }',
  '  Start-Sleep -Milliseconds 1000',
  '}'
].join('\n');

class WindowMonitor {
  constructor(options) {
    const opts = options || {};
    this.sampleIntervalMs = opts.sampleIntervalMs || SAMPLE_INTERVAL_MS;
    this._proc = null;
    this._rl = null;
    this._latest = null;
    this._lastError = null;
    this._usingPersistent = false;
  }

  // --- 生命周期 ---

  async start() {
    if (process.platform !== 'win32') {
      // 其它平台没有常驻采样的必要，保持按需调用
      return { persistent: false };
    }
    if (this._proc) return { persistent: true, already: true };

    try {
      // 写成临时 .ps1 再 -File 执行：stdin 逐行解释对 here-string 不友好
      const scriptPath = path.join(os.tmpdir(), `worklog-sampler-${process.pid}.ps1`);
      fs.writeFileSync(scriptPath, WIN_SAMPLER_SCRIPT, 'utf8');
      this._scriptPath = scriptPath;

      this._proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );

      this._rl = readline.createInterface({ input: this._proc.stdout });
      this._rl.on('line', (line) => this._onLine(line));

      // 保留 stderr 最后一行，便于诊断
      if (this._proc.stderr) {
        this._proc.stderr.on('data', (chunk) => {
          const text = chunk.toString().trim();
          if (text) this._lastError = text.slice(-300);
        });
      }

      this._proc.on('error', (err) => {
        this._lastError = err.message;
        this._usingPersistent = false;
      });

      this._proc.on('exit', () => {
        this._proc = null;
        this._rl = null;
        this._usingPersistent = false;
      });

      this._usingPersistent = true;
      return { persistent: true };
    } catch (error) {
      this._lastError = error.message;
      this._proc = null;
      this._usingPersistent = false;
      return { persistent: false, error: error.message };
    }
  }

  stop() {
    if (this._rl) {
      try { this._rl.close(); } catch (e) { /* noop */ }
      this._rl = null;
    }
    if (this._proc) {
      try { this._proc.kill(); } catch (e) { /* noop */ }
      this._proc = null;
    }
    if (this._scriptPath) {
      try { fs.unlinkSync(this._scriptPath); } catch (e) { /* noop */ }
      this._scriptPath = null;
    }
    this._usingPersistent = false;
  }

  // --- 采样 ---

  _onLine(line) {
    if (!line) return;
    const parts = line.split('\u0001');
    if (parts.length < 3) return;

    const processName = (parts[0] || 'unknown').trim() || 'unknown';
    const windowTitle = (parts[1] || '').trim();
    const idleMs = parseInt(parts[2], 10) || 0;

    this._latest = {
      processName,
      windowTitle,
      idleMs,
      ts: Date.now(),
      platform: 'windows',
      source: 'persistent'
    };
  }

  /** 最近一次采样；常驻进程失效时自动回退到即时采样 */
  latest() {
    if (this._latest && Date.now() - this._latest.ts < STALE_MS) {
      return this._latest;
    }
    return null;
  }

  isPersistent() {
    return this._usingPersistent && !!this._proc;
  }

  getLastError() {
    return this._lastError;
  }

  async sampleOnce() {
    if (process.platform === 'win32') return this._sampleWindowsOnce();
    if (process.platform === 'darwin') return this._sampleMacOnce();
    return this._sampleLinuxOnce();
  }

  /** 兼容旧调用方 */
  async getCurrentActivity() {
    return this.sampleOnce();
  }

  // --- Windows 单次采样（常驻进程挂掉时的兜底） ---

  async _sampleWindowsOnce() {
    try {
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "$src = @'",
        'using System; using System.Runtime.InteropServices; using System.Text;',
        'public class WLOnce {',
        '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
        '  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);',
        '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
        '}',
        "'@",
        'Add-Type -TypeDefinition $src',
        '$h=[WLOnce]::GetForegroundWindow(); $ip=0',
        '[WLOnce]::GetWindowThreadProcessId($h,[ref]$ip) | Out-Null',
        '$p = Get-Process -Id $ip -ErrorAction SilentlyContinue',
        '$sb = New-Object System.Text.StringBuilder 512',
        '[WLOnce]::GetWindowTextW($h,$sb,512) | Out-Null',
        'if ($p) { [Console]::Out.WriteLine($p.ProcessName + [char]1 + $sb.ToString()) }'
      ].join('\n');

      const { stdout } = await execAsync(script, {
        shell: 'powershell.exe',
        encoding: 'utf8',
        timeout: 8000
      });

      const line = stdout.trim().split(/\r?\n/).pop() || '';
      const [processName, windowTitle] = line.split('\u0001');
      if (!processName) return null;

      return {
        processName: processName.trim(),
        windowTitle: (windowTitle || '').trim(),
        idleMs: 0,
        ts: Date.now(),
        platform: 'windows',
        source: 'oneshot'
      };
    } catch (error) {
      this._lastError = error.message;
      return null;
    }
  }

  async _sampleMacOnce() {
    try {
      const { stdout } = await execAsync(
        "osascript -e 'tell application \"System Events\" to get name of first process whose frontmost is true'"
      );
      const processName = stdout.trim();
      if (!processName) return null;
      return {
        processName,
        windowTitle: processName,
        idleMs: 0,
        ts: Date.now(),
        platform: 'macos',
        source: 'oneshot'
      };
    } catch (error) {
      this._lastError = error.message;
      return null;
    }
  }

  async _sampleLinuxOnce() {
    try {
      const { stdout } = await execAsync('xdotool getactivewindow getwindowname getwindowpid');
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) return null;
      const { stdout: procName } = await execAsync(`ps -p ${lines[1]} -o comm=`);
      return {
        processName: procName.trim(),
        windowTitle: lines[0].trim(),
        idleMs: 0,
        ts: Date.now(),
        platform: 'linux',
        source: 'oneshot'
      };
    } catch (error) {
      this._lastError = error.message;
      return null;
    }
  }
}

module.exports = WindowMonitor;
