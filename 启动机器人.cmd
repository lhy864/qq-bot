@echo off
chcp 65001 >nul
setlocal
title 鲸鱼机器人启动检查
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 找不到 Node.js，请安装项目要求的 Node.js 后再启动。
  pause
  exit /b 1
)
node scripts\start-robot.mjs
set "ROBOT_START_EXIT=%errorlevel%"
echo.
echo 可以关闭此窗口。后台组件继续运行；诊断请双击“检查机器人.cmd”。
pause
exit /b %ROBOT_START_EXIT%
