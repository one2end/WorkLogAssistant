@echo off
REM WorkLog Assistant 启动脚本
REM JavaScript版本 - Electron + Vue

setlocal enabledelayedexpansion

REM 切换到脚本所在目录
cd /d "%~dp0"

echo ========================================
echo WorkLog Assistant 启动脚本
echo ========================================
echo.

REM 检查 Node.js 是否可用
node --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 找不到 Node.js 环境
    echo 请确保已安装 Node.js
    pause
    exit /b 1
)

echo [INFO] 启动 WorkLog Assistant...
echo.

REM 运行应用
npm run electron:dev

if errorlevel 1 (
    echo.
    echo 应用运行出错，请检查日志
    pause
    exit /b 1
)

echo 应用已成功启动
pause