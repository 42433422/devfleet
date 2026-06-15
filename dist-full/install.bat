@echo off
chcp 65001 > nul
echo 🔧 正在安装 DevFleet...

:: 检查 Node.js
where node > nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 错误: 需要安装 Node.js
    echo 请访问 https://nodejs.org 下载安装
    pause
    exit /b 1
)

echo ✅ Node.js 版本: 
node -v
echo ✅ npm 版本: 
npm -v

echo.
echo 📦 正在安装依赖...
call npm install

if %errorlevel% equ 0 (
    echo ✅ 依赖安装成功!
) else (
    echo ❌ 依赖安装失败
    pause
    exit /b 1
)

echo.
echo 🎉 安装完成!
echo.
echo 启动方式:
echo   开发模式: npm run dev
echo   仅前端:   npm run client:dev
echo   仅后端:   npm run server:dev
echo.
pause
