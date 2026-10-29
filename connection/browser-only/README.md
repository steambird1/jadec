# browser-only — 物理运行在浏览器 Worker

```
index.html
   │  import
   ▼
main.mjs ──postMessage(commands)──▶ physics.worker.mjs
   ▲                                      │
   └──────────postMessage(frame)──────────┘
                     │
                     ▼
        shared/ui/cockpit-ui.mjs（panel 组件 + Canvas 仪表）
```

## 启动

```powershell
node connection/browser-only/serve.mjs
# http://localhost:8090/connection/browser-only/
```

`PORT` / `HOST` 可覆盖，例如 `$env:PORT=9000; node connection/browser-only/serve.mjs`。

> 必须用 HTTP 打开：ES Module Worker 与 `fetch(panels.json)` 在 `file://` 下会被浏览器拒绝。

## 物理来源

- `physics.worker.mjs` 创建 `SimCore`，每 50 ms 推进一次物理并 `postMessage` 一帧。
- `physics-bundle.mjs` 由 `build-physics-bundle.mjs` 读取
  `physics/{terrain,jade-chamber,flight-control,instruments}.js` 生成。
  物理代码一旦修改，执行：

```powershell
node connection/browser-only/build-physics-bundle.mjs
```

- Worker 内只有一份仿真状态；刷新页面 = 新建会话。
- 主线程暂停（`PAUSE` 按钮）只停物理节拍，不销毁 Worker。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 页眉（模式/链路/帧号）+ `#panels-container` |
| `main.mjs` | 建 UI、建 Worker、命令队列、断流检测 |
| `physics.worker.mjs` | Worker 入口；消息协议见 `../docs/data-interface.md` §4 |
| `physics-bundle.mjs` | **自动生成**，勿手改 |
| `build-physics-bundle.mjs` | CommonJS → ESM 打包器 |
| `serve.mjs` | 静态服务器（根 = 仓库根，`/panel` 挂载到兄弟目录） |

## 限制

- Worker 与 UI 在同一台机器：关闭页面即丢失仿真状态。
- 没有多客户端/观战；需要这些能力时用 `browser-server`。
