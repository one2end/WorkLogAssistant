const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class WindowMonitor {
  constructor() {
    this.lastActivity = null;
  }

  async getCurrentActivity() {
    try {
      const activity = await this.getActiveWindow();
      
      if (activity && this.isNewActivity(activity)) {
        this.lastActivity = activity;
        return activity;
      }
      
      return null;
    } catch (error) {
      console.error('获取窗口信息失败:', error);
      return null;
    }
  }

  async getActiveWindow() {
    if (process.platform === 'win32') {
      return await this.getWindowsActiveWindow();
    } else if (process.platform === 'darwin') {
      return await this.getMacActiveWindow();
    } else {
      return await this.getLinuxActiveWindow();
    }
  }

  async getWindowsActiveWindow() {
    try {
      const { stdout } = await execAsync(`
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId); [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount); }'
        $hwnd = [Win32]::GetForegroundWindow();
        $processId = 0;
        [Win32]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null;
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue;
        if ($process) {
          $title = New-Object System.Text.StringBuilder 256;
          [Win32]::GetWindowText($hwnd, $title, $title.Capacity) | Out-Null;
          $windowTitle = $title.ToString();
          if (-not $windowTitle) {
            $windowTitle = $process.MainWindowTitle;
          }
          Write-Output "$($process.ProcessName)|$windowTitle";
        }
      `, { 
        shell: 'powershell.exe',
        encoding: 'utf8'
      });

      const [processName, windowTitle] = stdout.trim().split('|');
      
      if (processName && windowTitle) {
        return {
          id: Date.now(),
          timestamp: new Date().toISOString(),
          processName: processName.trim(),
          windowTitle: windowTitle.trim(),
          platform: 'windows'
        };
      }
      
      return null;
    } catch (error) {
      console.error('Windows窗口监控错误:', error);
      return null;
    }
  }

  async getMacActiveWindow() {
    try {
      const { stdout } = await execAsync(`
        osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'
      `);

      const processName = stdout.trim();
      
      if (processName) {
        return {
          id: Date.now(),
          timestamp: new Date().toISOString(),
          processName: processName,
          windowTitle: processName,
          platform: 'macos'
        };
      }
      
      return null;
    } catch (error) {
      console.error('macOS窗口监控错误:', error);
      return null;
    }
  }

  async getLinuxActiveWindow() {
    try {
      const { stdout } = await execAsync(`
        xdotool getactivewindow getwindowname getwindowpid
      `);

      const lines = stdout.trim().split('\n');
      if (lines.length >= 2) {
        const windowTitle = lines[0];
        const pid = lines[1];
        
        const { stdout: processName } = await execAsync(`ps -p ${pid} -o comm=`);
        
        return {
          id: Date.now(),
          timestamp: new Date().toISOString(),
          processName: processName.trim(),
          windowTitle: windowTitle.trim(),
          platform: 'linux'
        };
      }
      
      return null;
    } catch (error) {
      console.error('Linux窗口监控错误:', error);
      return null;
    }
  }

  isNewActivity(activity) {
    if (!this.lastActivity) {
      return true;
    }
    
    return (
      activity.processName !== this.lastActivity.processName ||
      activity.windowTitle !== this.lastActivity.windowTitle
    );
  }
}

module.exports = WindowMonitor;