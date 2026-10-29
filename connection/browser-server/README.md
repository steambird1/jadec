# browser-server — 物理运行在 Node.js 服务器

```
浏览器（只做 UI）                          Node.js（唯一真相源）
┌────────────────────────┐   GET /api/stream   ┌─────────────────────────┐
│ main.mjs               │ ◀──── SSE 20 Hz ─── │ server.mjs              │
│ CockpitUI（panel 组件） │                     │ SimCore                 │
│ CommandQueue           │ ── POST /api/command▶│  ├ JadeChamber          │
└────────────────────────┘                     │  ├ FlightControl        │
                                               │  └ InstrumentSuite      │
                                               └─────────────────────────┘
```

## 启动

```powershell
node connection/browser-server/server.mjs
# 打开 http://localhost:8091/connection/browser-server/
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8091` | HTTP 端口 |
| `HOST` | `0.0.0.0` | 监听地址（局域网可访问） |
| `TERRAIN` | `flat` | 初始地形：`flat/ramp/hills/ridge/peak/liyue` |

## HTTP / SSE 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/hello` | 模式、频率、物理位置、客户端数 |
| GET | `/api/frame` | 最新一帧（调试/轮询） |
| GET | `/api/stream` | SSE：`hello` 事件 + 20 Hz `frame` 事件 + 15 s 心跳 |
| POST | `/api/command` | 单条命令或 `{commands:[...]}` |
| POST | `/api/commands` | 别名 |

示例：

```powershell
# 读一帧
curl http://localhost:8091/api/frame

# 设 ALT=300 m、提交 TRK 草稿
curl -X POST http://localhost:8091/api/command -H "Content-Type: application/json" `
  -d '{"commands":[{"action":"setKnob","name":"ALT","value":300},{"action":"setKnob","name":"TRK","value":45},{"action":"trkSet"}]}'

# SSE（PowerShell 7）
curl.exe -N http://localhost:8091/api/stream
```

完整字段见 [`../docs/data-interface.md`](../docs/data-interface.md)。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 前端外壳（无物理代码） |
| `main.mjs` | EventSource 收帧 + `fetch` 发命令 + 断流检测 |
| `server.mjs` | 物理主循环、SSE 广播、命令 API、静态服务 |

## 行为说明

- 服务器**始终**以 20 Hz 推进仿真，即使没有浏览器连接。
- 慢客户端会被丢帧（`writableLength > 2 MB`），不会拖慢物理。
- 浏览器刷新不会重置仿真；需要重置时按 `SYSTEM → RESET`（带盖）。
- 多开浏览器会看到**同一份**状态。
- EventSource 断线自动重连；服务器重启后页面无需刷新。

## 安全

这是本地演示服务器：**没有鉴权、没有 TLS、任何能访问端口的人都能发命令**
（包括故障注入）。不要直接暴露到公网；需要时在前面加反向代理与鉴权。
