# 群玉阁 · Connection（physics ⇄ panel）

把 `jadec/physics/` 的飞行物理与 `../panel/` 的驾驶舱组件连接起来，提供两种部署：

| 目录 | 物理运行位置 | 前端 | 传输 |
|---|---|---|---|
| `browser-only/` | **浏览器 Web Worker** | 浏览器 | `postMessage` |
| `browser-server/` | **Node.js 后台** | 浏览器 | SSE + HTTP POST |
| `shared/` | — | 两者共用 | 面板 JSON / SimCore / UI / Canvas 仪表 |

## 快速开始

```powershell
# 方式 1：纯浏览器（物理在 Worker）
node connection/browser-only/serve.mjs
# 打开 http://localhost:8090/connection/browser-only/

# 方式 2：Node 服务器（物理在服务器）
node connection/browser-server/server.mjs
# 打开 http://localhost:8091/connection/browser-server/
```

两种方式都**零 npm 依赖**（Node 18+，本仓库在 Node 24 验证）。

## 目录

```
connection/
├─ shared/
│  ├─ sim-core.mjs               物理/控制/仪表 + 命令 + 帧（运输无关）
│  ├─ static-server.mjs          零依赖静态服务（/panel 挂载到兄弟目录）
│  ├─ panels/jade-cockpit.json   6 个面板、101 个组件
│  └─ ui/
│     ├─ cockpit-ui.mjs          帧 → 组件；组件 → 命令
│     ├─ canvas-instruments.mjs  群玉阁特有 Canvas 仪表
│     ├─ units.mjs               SI ↔ 表盘单位（唯一换算点）
│     ├─ command-queue.mjs       连续量合并 / 命令节流
│     └─ connection.css          页面外壳
├─ browser-only/
│  ├─ index.html / main.mjs
│  ├─ physics.worker.mjs         物理后台
│  ├─ physics-bundle.mjs         自动生成（physics/*.js → ESM）
│  ├─ build-physics-bundle.mjs   重新生成 bundle
│  └─ serve.mjs                  静态服务器
├─ browser-server/
│  ├─ index.html / main.mjs      纯前端
│  └─ server.mjs                 Node 物理 + SSE/HTTP + 静态服务
└─ docs/
   ├─ data-interface.md          帧/命令/传输协议（完整）
   └─ component-map.md           6 个面板全部组件命名与数据源
```

## 设计要点

- **物理单一真相源**：两种部署调用同一份 `physics/*.js`。浏览器端用构建脚本
  把 CommonJS 包成 ESM；Node 端直接 `require`。不复制、不改写物理代码。
- **仪表单一真相源**：`InstrumentSuite.read()` 的 16 个分组原样进入帧；
  前端只做单位换算与绘制，不重算物理。
- **连续量合并**：旋钮拖动最多 30 ms 发一批，同一旋钮只保留最后值；
  按钮命令保序。
- **回声抑制**：远端回写旋钮/鼓轮时屏蔽组件自身 `change`，避免命令回环。
- **断流检测**：3 s 无帧 → 页眉与状态页显示 `NO DATA`；SSE 自动重连。

## 单位

`physics/instruments.js` 全部输出 SI；只有 `disp-alt-agl` 复用的
`panel/scripts/alt.js` 需要 ft，换算集中在 `shared/ui/units.mjs`。

## 验证

```powershell
# 语法
Get-ChildItem -Recurse -File connection -Include *.mjs | ForEach-Object { node --check $_.FullName }

# 无头 UI 冒烟测试（有最小 DOM shim，不需要浏览器）
node connection/tests/ui-smoke.mjs

# 重新生成物理 bundle
node connection/browser-only/build-physics-bundle.mjs

# 服务器接口
node -e "fetch('http://localhost:8091/api/hello').then(r=>r.json()).then(console.log)"
```

`browser-only/main.mjs` 与 `browser-server/main.mjs` 都调用同一个
`CockpitUI`；两者行为差异只在传输适配层。

详细说明见 [`docs/data-interface.md`](docs/data-interface.md) 与
[`docs/component-map.md`](docs/component-map.md)。
