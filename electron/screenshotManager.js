const { desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { app } = require('electron');

const execAsync = promisify(exec);

class ScreenshotManager {
  constructor() {
    const userDataPath = app.getPath('userData');
    this.screenshotDir = path.join(userDataPath, 'Data', 'screenshots');
    this.ensureScreenshotDir();
  }

  ensureScreenshotDir() {
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  async captureScreen() {
    try {
      if (process.platform === 'win32') {
        return await this.captureScreenWindows();
      } else if (process.platform === 'darwin') {
        return await this.captureScreenMac();
      } else {
        return await this.captureScreenLinux();
      }
    } catch (error) {
      console.error('截图失败:', error);
      return null;
    }
  }

  async captureScreenWindows() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot_${timestamp}.png`;
      const filepath = path.join(this.screenshotDir, filename);

      const { exec: powershell } = require('child_process');
      
      await powershell(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $screen = [System.Windows.Forms.Screen]::PrimaryScreen; $bitmap = New-Object System.Drawing.Bitmap $screen.Bounds.Width, $screen.Bounds.Height; $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($screen.Bounds.X, $screen.Bounds.Y, 0, 0, $screen.Bounds.Width, $screen.Bounds.Height); $bitmap.Save('${filepath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); $graphics.Dispose(); $bitmap.Dispose()`);

      const stats = fs.statSync(filepath);
      console.log(`截图已保存: ${filename}, 大小: ${(stats.size / 1024).toFixed(2)} KB`);

      return {
        filename,
        path: filepath,
        timestamp: new Date().toISOString(),
        size: stats.size
      };
    } catch (error) {
      console.error('Windows截图失败:', error);
      return await this.captureScreenElectron();
    }
  }

  async captureScreenMac() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot_${timestamp}.png`;
      const filepath = path.join(this.screenshotDir, filename);

      await execAsync(`screencapture -x -o "${filepath}"`);

      const stats = fs.statSync(filepath);
      console.log(`截图已保存: ${filename}, 大小: ${(stats.size / 1024).toFixed(2)} KB`);

      return {
        filename,
        path: filepath,
        timestamp: new Date().toISOString(),
        size: stats.size
      };
    } catch (error) {
      console.error('macOS截图失败:', error);
      return await this.captureScreenElectron();
    }
  }

  async captureScreenLinux() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot_${timestamp}.png`;
      const filepath = path.join(this.screenshotDir, filename);

      await execAsync(`import -window root -format png -quality 100 "${filepath}"`);

      const stats = fs.statSync(filepath);
      console.log(`截图已保存: ${filename}, 大小: ${(stats.size / 1024).toFixed(2)} KB`);

      return {
        filename,
        path: filepath,
        timestamp: new Date().toISOString(),
        size: stats.size
      };
    } catch (error) {
      console.error('Linux截图失败:', error);
      return await this.captureScreenElectron();
    }
  }

  async captureScreenElectron() {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      });

      if (sources.length === 0) {
        console.warn('未找到可用的屏幕源');
        return null;
      }

      const primaryScreen = sources[0];
      const thumbnail = primaryScreen.thumbnail;
      
      if (!thumbnail) {
        console.warn('无法获取屏幕缩略图');
        return null;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot_${timestamp}.png`;
      const filepath = path.join(this.screenshotDir, filename);

      fs.writeFileSync(filepath, thumbnail.toPNG(1.0));

      const stats = fs.statSync(filepath);
      console.log(`Electron截图已保存: ${filename}, 大小: ${(stats.size / 1024).toFixed(2)} KB`);

      return {
        filename,
        path: filepath,
        timestamp: new Date().toISOString(),
        size: stats.size
      };
    } catch (error) {
      console.error('Electron截图失败:', error);
      return null;
    }
  }

  async captureWindow(windowId) {
    try {
      if (process.platform === 'win32') {
        return await this.captureWindowWindows(windowId);
      } else if (process.platform === 'darwin') {
        return await this.captureWindowMac(windowId);
      } else {
        return await this.captureWindowLinux(windowId);
      }
    } catch (error) {
      console.error('窗口截图失败:', error);
      return null;
    }
  }

  async captureWindowWindows(windowId) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `window_${windowId}_${timestamp}.png`;
      const filepath = path.join(this.screenshotDir, filename);

      await execAsync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect); [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } }'; $hwnd = [Win32]::GetForegroundWindow(); $rect = New-Object RECT; [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null; $bitmap = New-Object System.Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top); $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)); $bitmap.Save('${filepath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); $graphics.Dispose(); $bitmap.Dispose()"`);

      const stats = fs.statSync(filepath);
      console.log(`窗口截图已保存: ${filename}, 大小: ${(stats.size / 1024).toFixed(2)} KB`);

      return {
        filename,
        path: filepath,
        timestamp: new Date().toISOString(),
        size: stats.size
      };
    } catch (error) {
      console.error('Windows窗口截图失败:', error);
      return await this.captureWindowElectron(windowId);
    }
  }

  async captureWindowMac(windowId) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `window_${windowId}_${timestamp}.png`;
      const filepath = path.join(this.screenshotDir, filename);

      await execAsync(`screencapture -l -o "${filepath}"`);

      const stats = fs.statSync(filepath);
      console.log(`窗口截图已保存: ${filename}, 大小: ${(stats.size / 1024).toFixed(2)} KB`);

      return {
        filename,
        path: filepath,
        timestamp: new Date().toISOString(),
        size: stats.size
      };
    } catch (error) {
      console.error('macOS窗口截图失败:', error);
      return await this.captureWindowElectron(windowId);
    }
  }

  async captureWindowLinux(windowId) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `window_${windowId}_${timestamp}.png`;
      const filepath = path.join(this.screenshotDir, filename);

      await execAsync(`import -window ${windowId} -format png -quality 100 "${filepath}"`);

      const stats = fs.statSync(filepath);
      console.log(`窗口截图已保存: ${filename}, 大小: ${(stats.size / 1024).toFixed(2)} KB`);

      return {
        filename,
        path: filepath,
        timestamp: new Date().toISOString(),
        size: stats.size
      };
    } catch (error) {
      console.error('Linux窗口截图失败:', error);
      return await this.captureWindowElectron(windowId);
    }
  }

  async captureWindowElectron(windowId) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1920, height: 1080 }
      });

      const windowSource = sources.find(source => source.id.includes(windowId.toString()));
      
      if (!windowSource) {
        console.warn('未找到指定的窗口');
        return null;
      }

      const thumbnail = windowSource.thumbnail;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `window_${windowId}_${timestamp}.png`;
      const filepath = path.join(this.screenshotDir, filename);

      fs.writeFileSync(filepath, thumbnail.toPNG(1.0));

      const stats = fs.statSync(filepath);
      console.log(`Electron窗口截图已保存: ${filename}, 大小: ${(stats.size / 1024).toFixed(2)} KB`);

      return {
        filename,
        path: filepath,
        timestamp: new Date().toISOString(),
        size: stats.size
      };
    } catch (error) {
      console.error('Electron窗口截图失败:', error);
      return null;
    }
  }

  getScreenshotPath(filename) {
    return path.join(this.screenshotDir, filename);
  }

  deleteOldScreenshots(daysToKeep = 30) {
    try {
      const files = fs.readdirSync(this.screenshotDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      files.forEach(file => {
        const filepath = path.join(this.screenshotDir, file);
        const stats = fs.statSync(filepath);
        
        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filepath);
          console.log(`删除过期截图: ${file}`);
        }
      });
    } catch (error) {
      console.error('清理过期截图失败:', error);
    }
  }
}

module.exports = ScreenshotManager;