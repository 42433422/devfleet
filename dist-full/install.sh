#!/bin/bash

# DevFleet 安装脚本

echo "🔧 正在安装 DevFleet..."

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 需要安装 Node.js"
    echo "请访问 https://nodejs.org 下载安装"
    exit 1
fi

echo "✅ Node.js 版本: $(node -v)"
echo "✅ npm 版本: $(npm -v)"

# 安装依赖
echo ""
echo "📦 正在安装依赖..."
npm install

if [ $? -eq 0 ]; then
    echo "✅ 依赖安装成功!"
else
    echo "❌ 依赖安装失败"
    exit 1
fi

echo ""
echo "🎉 安装完成!"
echo ""
echo "启动方式:"
echo "  开发模式: npm run dev"
echo "  仅前端:   npm run client:dev"
echo "  仅后端:   npm run server:dev"
echo ""
