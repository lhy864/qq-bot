@echo off
chcp 65001 >nul
setlocal
title 鲸鱼机器人状态检查
cd /d "%~dp0"
node scripts\diagnose-robot.mjs --save
set "ROBOT_CHECK_EXIT=%errorlevel%"
echo.
echo 检查只读取服务状态，不发送 QQ 消息、不重置会话。
echo 如配置可读，脱敏摘要保存在 state\diagnostic-latest.json。
pause
exit /b %ROBOT_CHECK_EXIT%
