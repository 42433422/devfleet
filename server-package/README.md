# DevFleet Server

这是支持持久化和 WebSocket 的 DevFleet 单实例服务端。Release 中的 `devfleet-server-<platform>.zip` 已内置对应平台的 Node.js 22 运行时；如果你自行删除 `runtime/`，则需要本机已安装 Node.js 20.19+。

Windows PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start-server.ps1
```

Linux/macOS：

```bash
chmod +x start-server.sh
./start-server.sh
```

默认监听 `3001` 端口，数据保存在同目录的 `data/`。请下载与当前系统匹配的 server zip；跨公网使用时，请通过 Caddy、Nginx 或云负载均衡提供 HTTPS/WSS，并限制服务器防火墙。
