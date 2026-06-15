# DevFleet - 多设备协同开发控制平台

## 快速开始

### 方式一：本地开发模式（推荐）
```bash
# 1. 进入目录
cd dist-full

# 2. 安装依赖
npm install

# 3. 启动开发服务器（前后端同时启动）
npm run dev
```

### 方式二：仅查看前端
```bash
# 直接用浏览器打开
open index.html
# 或
start index.html  # Windows
```

### 方式三：生产环境部署
```bash
# 1. 安装依赖
npm install

# 2. 构建前端
npm run build

# 3. 启动后端服务
npm run server:dev
```

## 功能说明

### 设备管理
- ✅ **扫码绑定**：生成绑定码，让设备扫码完成绑定
- ✅ **输入码绑定**：手动输入设备提供的绑定码
- ✅ **设置主设备**：点击星标按钮设为主设备
- ✅ **删除设备**：点击垃圾桶图标删除设备
- ✅ **设备状态显示**：在线/离线/连接中

### 任务控制台
- ✅ **创建任务**：添加新的开发任务
- ✅ **查看任务列表**：浏览所有任务
- ✅ **任务详情**：查看子任务执行日志
- ✅ **分支合并**：任务完成后合并分支

### 免登录
- ✅ 点击"立即进入"即可直接体验，无需注册

## 技术栈
- 前端：React 18 + TypeScript + Tailwind CSS + Vite
- 后端：Express + WebSocket
- 状态管理：Zustand
- 实时通信：WebSocket

## 端口说明
- 前端开发服务器： http://localhost:5173 (或 5174/5175)
- 后端 API： http://localhost:3001
- WebSocket： ws://localhost:3001/ws/*

## 数据存储
- 使用 JSON 文件存储数据（api/data/db.json）
- 开发环境数据存储在本地

## 注意事项
- 首次使用建议先启动后端服务，再访问前端
- 设备绑定功能需要后端服务运行
- WebSocket 实时功能需要后端支持
