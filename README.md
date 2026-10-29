# JADEC: Jade Chamber's Authorized Digital and Electronic Control System

Work is still in progress now, please be patient.

For supporting framework go to `aviation-panels` (this checkout: `../panel`).

## 驾驶舱连接（physics ⇄ panel）

`connection/` 提供两种把 `physics/` 与 `../panel/` 组合起来的部署，二者共用同一份
物理代码与同一份仪表面板定义：

| 部署 | 物理位置 | 启动 |
|---|---|---|
| `connection/browser-only` | 浏览器 Web Worker | `node connection/browser-only/serve.mjs` → http://localhost:8090/connection/browser-only/ |
| `connection/browser-server` | Node.js 服务器 | `node connection/browser-server/server.mjs` → http://localhost:8091/connection/browser-server/ |

- 数据接口：`connection/docs/data-interface.md`
- 组件命名：`connection/docs/component-map.md`
- 总览：`connection/README.md`
