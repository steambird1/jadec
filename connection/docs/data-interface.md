# 数据接口规范（physics ⇄ panel）

> 代码位置：`connection/shared/sim-core.mjs`
> 面板定义：`connection/shared/panels/jade-cockpit.json`
> 组件命名：`connection/docs/component-map.md`

本文定义两种部署**完全相同**的数据协议。区别只在传输层：

| 部署 | 物理运行位置 | 帧传输 | 命令传输 |
|---|---|---|---|
| `browser-only` | 浏览器 Web Worker | `worker.postMessage(frame)` | `worker.postMessage({type:'commands'})` |
| `browser-server` | Node.js 服务器 | SSE `GET /api/stream` | HTTP `POST /api/command` |

---

## 1. 总体结构

```
                  ┌──────────────────────────────┐
                  │  physics/jade-chamber.js      │  6-DOF + 浮空场
                  │  physics/flight-control.js    │  控制层 / MCP / 自动驾驶
                  │  physics/instruments.js       │  InstrumentSuite.read()
                  └──────────────┬───────────────┘
                                 │  每 0.05 s
                  ┌──────────────▼───────────────┐
                  │  SimCore（shared/sim-core）   │  命令 → 物理 → 帧
                  └──────────────┬───────────────┘
             ┌───────────────────┴───────────────────┐
      Worker postMessage                        SSE / HTTP
             │                                       │
      ┌──────▼───────────────────────────────────────▼──────┐
      │ CockpitUI（shared/ui）                              │
      │  data 分组 → 仪表组件；组件事件 → 命令               │
      └─────────────────────────────────────────────────────┘
```

**唯一真相源**：`physics/` 只被 `SimCore` 调用一次。前端不重算任何物理量；
所有表盘读数都来自 `InstrumentSuite.read()` 的 16 个分组。

---

## 2. 帧（Frame）

每帧是一个 JSON 可序列化对象（函数会被去掉，`NaN/Infinity` 会变成 `null`）：

```json
{
  "type": "frame",
  "protocol": 1,
  "seq": 128,
  "simTime": 24.35,
  "wallTime": 1793235717704,
  "data": { "...": "InstrumentSuite.read() 原样输出" },
  "meta": { "...": "给 UI 的派生量与单位声明" }
}
```

| 字段 | 说明 |
|---|---|
| `seq` | 单调递增帧号（命令产生的帧也计数，因此客户端可能看到跳号） |
| `simTime` | 仿真时间（秒），**不是**墙钟 |
| `wallTime` | 生成帧时的 `Date.now()`；前端用它判断断流（> 3 s 报警） |
| `data` | `InstrumentSuite.read(dt)` 的完整结果，见 §2.1 |
| `meta` | 单位、开关、限制、连接/派生量，见 §2.2 |

> `data` 中保留了下标、`level`、`text` 等字段；**不要**在前端重新推导物理公式。
> 由于经过 JSON，`ceiling.ceilingIfDump()`、`ceiling.maxMassForAGL()`、
> `weight.dumpEffect()` 三个函数字段不会出现在帧里；需要相应功能时应在
> `SimCore` 的命令层新增动作，而不是在浏览器里重算。

### 2.1 `data` 的 16 个分组

单位统一为 SI：高度/距离 **m**，速度 **m/s**，质量 **kg**，角度 **deg**，推力 **N**（界面显示为 `%W`）。

| 分组 | 关键字段 | 对应仪表 |
|---|---|---|
| `ceiling` | `agl`, `ceiling`, `margin`, `canLoseStones`, `ceilingTable[]`, `level` | 升限余量双针表 / 可失石数灯条 |
| `saturation` | `nSaturated`, `perStone[]`, `GMx`, `GMy`, `delta0`, `d`, `unstable`, `level` | 包络饱和灯 / MFD |
| `altimetry` | `gap`, `clearance`, `amsl`, `fieldM`, `terrainM`, `smoothExcess`, `minAGL`, `lowClearance` | AGL 表 / 双高度带 |
| `attitude` | `phi`, `theta`, `bearing`, `slope`, `slopeDeg`, `tiltDeg`, `followTarget`, `levelError`, `levelMode` | PFD / 坡度 |
| `fieldRate` | `fieldRate`, `rMax`, `over`, `speed`, `vLimit`, `speedLimited`, `alarmReachable` | 空速表红色限速游标 |
| `vsi` | `zdotRaw`, `zdot`, `bug`, `deviation`, `components`, `following`, `zdotMax` | VSI（针 + Ṡ 游标） |
| `fieldProfile` | `dirDeg`, `rangeM`, `lookaheadT`, `lookaheadV`, `points[{d,T,S,track,clearance,excess,gap}]`, `terrain`, `field`, `clearance`, `kinds`, `notes` | MFD 场剖面 |
| `terrain` | 与 `fieldProfile` 相同（兼容旧名） | MFD 场剖面 |
| `capability` | `trk`, `wind`, `FazMax`, `polar[{hdg,vMax,feasibleAtCur}]`, `best`, `worst`, `feasibleFraction`, `fan` | 能力极坐标 / 圆表可行扇区 |
| `damping` | `modes`, `coeffs`, `zeta`, `TvPct[]`, `azPct[]`, `TapuPct`, `peakThrustPct`, `trimPersistent`, `levelError`, `alloc` | 推进器面板 / TRIM 灯 |
| `compass` | `cardTopDeg`, `modeText`, `lubberDeg`, `speed`, `arrow`, `crab`, `crabLimitDeg`, `crabLimited`, `sector`, `bugs`, `noTrack`, `holdRef` | CRT 圆表 |
| `mcp` | `SPD`, `TRK`, `HDG`, `ALT`, `CRAB`, `switches`, `hdgAuto` | MCP 数字窗与指示灯 |
| `zRefPlan` | `targetAGL`, `targetZRef`, `currentZRef`, `error`, `mode`, `rateNow`, `rateLimit`, `accNow`, `accLimit`, `etaRemain`, `eta95`, `floorSec`, `notes` | MFD 升降计划 |
| `stones` | `rows[{idx,pos,f,frac,gap,zRef,dev,saturated,failed,dGMx,dGMy,cls}]`, `nActive`, `maxDev`, `stoneDevAlarm`, `trimSpread` | 3×3 石头出力 / 9 个 zRef 鼓轮 |
| `propulsion` | `vertical[4]`, `azimuth[2]`, `apu`, `fuelMass`, `headingFree`, `limits` | 推进器图 |
| `weight` | `M`, `W`, `rcm`, `d`, `delta0`, `parts`, `stoneFraction`, `loadLine`, `tanks[]`, `canDump` | 重量鼓轮 |
| `annunciators` | `list[{level,code,text}]`, `warning[]`, `caution[]`, `advisory[]`, `masterWarning`, `masterCaution` | 告警灯板 / MFD 文本页 |

`annunciators` 的代码与灯组件一一对应，见 `component-map.md` §6。

### 2.2 `meta`

```json
{
  "units": { "speed": "m/s", "altitude": "m", "verticalSpeed": "m/s",
             "heading": "deg", "mass": "kg", "thrust": "%W" },
  "terrainPreset": "flat",
  "flags": {
    "ap": true, "managed": true, "hdgAuto": false,
    "emergencyDescent": false, "stiffnessFailed": false,
    "yawRate": false, "diverged": false
  },
  "controls": {
    "spd": 0, "trkDraft": 0, "trkSelected": 0, "trkNow": 0,
    "hdg": 0, "alt": 749.3, "crabMode": "CRUISE",
    "levelMode": "FOLLOW", "source": "MANAGED", "managed": true
  },
  "environment": { "windWorld": [0, 0, 0] },
  "limits": { "Vmax": 22, "zRef0": 749.3, "altMax": 1200,
              "ceilingProtectMargin": 150, "FazMax": 0, "Fmax": 0 },
  "names": { "stones": ["#0", "..."], "engines": ["FL", "FR", "RL", "RR"],
             "tanks": ["W1(FL↑)", "..."] },
  "ui": {
    "aglFt": 2457.0, "clearanceFt": 2457.0, "ceilingFt": 3112.0,
    "speedKt": 0.0, "vsiFpm": 0.0, "vsiBugFpm": 0.0,
    "canLoseStones": 2, "warningCount": 0, "cautionCount": 0, "advisoryCount": 1
  }
}
```

`meta.ui` 是**只读派生量**，只做单位换算，不包含新的物理语义。

---

## 3. 命令（Command）

命令都是普通对象，`action` 为唯一必填字段。可单条发送，也可批量：

```json
{ "commands": [
  { "action": "setKnob", "name": "ALT", "value": 300 },
  { "action": "trkSet" },
  { "action": "toggleSwitch", "name": "HDG_AUTO" }
] }
```

| action | 参数 | 作用 |
|---|---|---|
| `setKnob` | `name: SPD\|TRK\|HDG\|ALT`, `value:number` | 写 MCP 选择值；`TRK` 只写草稿窗 |
| `setKnob` | `name:"CRAB"`, `value:"CRUISE"\|"TRANSIT"\|"PRECISION"\|"BERTH"` | CRAB LIMIT 档位 |
| `nudge` | `name`, `steps`, `fine?` | 与旋钮同义的增量操作 |
| `trkSet` | — | 提交 TRK 草稿（同时回到 MANAGED） |
| `sync` | `kind:"HDG"\|"TRK"\|"ALT"` | 同步到当前实际值 |
| `managed` | — | 接管为 MANAGED |
| `level` | `value:boolean` | `true`=LEVEL，`false`=FOLLOW SLOPE |
| `setSwitch` | `name`, `value:boolean` | 显式写开关 |
| `toggleSwitch` | `name` | 翻转开关 |
| `dumpBallast` | `mass:kg` | 抛压载（5 个水箱均分） |
| `setStone` | `index:0..8`, `failed:boolean` | 设置单石失效 |
| `toggleStone` | `index:0..8` | 翻转单石失效 |
| `setEngineFailed` | `index:0..3`, `failed:boolean` | 垂推失效 |
| `toggleEngine` | `index:0..3` | 翻转垂推失效 |
| `setApuFailed` | `failed:boolean` | APU 失效 |
| `setWind` | `speed:m/s`, `dirDeg:0..359` | 设置风（`dirDeg` = 风吹向的方位） |
| `reset` | `terrainPreset?:flat\|ramp\|hills\|ridge\|peak\|liyue` | 新建会话 |
| `ping` | — | 连通性测试 |

开关名（`setSwitch` / `toggleSwitch`）：

`AP` · `MANAGED` · `HDG_AUTO` · `EMERGENCY_DESCENT` · `STIFFNESS_LOSS` · `YAW_RATE`

**注意**：`MANAGED` 显式设为 `false` 等价于切到 MANUAL；手柄一有输入，
`ControlPanel` 自己也会切 MANUAL。

### 3.1 执行结果

批量命令返回：

```json
{
  "ok": true,
  "seq": 130,
  "results": [
    { "ok": true,  "action": "setKnob" },
    { "ok": false, "action": "setStone", "error": "石头索引越界: 9" }
  ]
}
```

- 单条失败不会中断后续命令（逐条 `try/catch`）。
- 有失败时服务器返回 HTTP **207**；Worker 返回 `{type:'ack',results}` 并额外发 `{type:'error'}`。
- 命令执行后会立即生成一帧，但该帧也会被下一次广播覆盖；UI 以广播帧为准。

---

## 4. 传输层 A：Web Worker（browser-only）

主线程 → Worker：

| 消息 | 说明 |
|---|---|
| `{type:'commands', commands:[...]}` | 批量命令 |
| `{type:'setRate', hz:5..60}` | 改变物理节拍，默认 20 Hz |
| `{type:'pause'}` / `{type:'resume'}` | 暂停/恢复仿真 |
| `{type:'ping'}` | 心跳 |

Worker → 主线程：

| 消息 | 说明 |
|---|---|
| `{type:'ready', info}` | 物理加载完成（`mode/physics/tickHz/terrainPreset`） |
| `frame` | 完整帧（与 §2 相同） |
| `{type:'ack', results}` | 命令执行结果 |
| `{type:'error', message}` | 初始化或运行异常 |
| `{type:'pong', at}` | 心跳回应 |

物理时间由 Worker 自己的 `setInterval(50 ms)` 推进；主线程渲染慢不会拖慢物理，
主线程切后台也不会停 Worker。

---

## 5. 传输层 B：Node.js + SSE（browser-server）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/hello` | 服务器信息（模式/频率/物理位置/客户端数） |
| `GET` | `/api/frame` | 最新一帧（轮询/调试用） |
| `GET` | `/api/stream` | **SSE**：先发 `hello`，随后每 50 ms 发 `frame`；每 15 s 发注释心跳 |
| `POST` | `/api/command` | 命令入口；body 为单条命令或 `{commands:[...]}` |
| `POST` | `/api/commands` | 同上（别名） |

SSE 事件：

```text
retry: 1000

event: hello
data: {"mode":"browser-server","transport":"sse","protocol":1,"tickHz":20,...}

event: frame
data: {"type":"frame","protocol":1,"seq":1,...}

: keep-alive
```

- 使用 `EventSource`，浏览器自带断线重连（`retry: 1000`）。
- 服务器对慢客户端**丢旧帧**（`writableLength > 2 MB` 时跳过），不会无限堆积。
- `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no`，避免代理缓冲。
- 命令 POST 是独立请求，不与 SSE 流共享连接；前端用 `CommandQueue` 串行发送。

> 为什么用 SSE + POST 而不是 WebSocket：遥测是**单向高频**、命令是**低频**，
> SSE 零依赖、自动重连、对代理友好；WebSocket 在这个规模上没有额外收益。
> 若以后需要二进制或双向高频，只需替换 `main.mjs` 的传输适配层，帧/命令结构不变。

---

## 6. 单位换算（唯一入口 `shared/ui/units.mjs`）

| 物理量 | 帧内单位 | 表盘单位 | 换算 |
|---|---|---|---|
| 水平速度 | m/s | kt（圆表文字）/ m/s（自绘空速表） | `× 1.943844` |
| 高度 / 距离 | m | ft（PFD 高度表） | `× 3.280839895` |
| 垂直速度 | m/s | m/s（自绘 VSI） | 1:1 |
| 马赫 | — | — | `v(m/s)/340.3`（15 °C 标准声速，与 panel/scripts/physics.js 同式） |
| 质量 | kg | t | `÷ 1000` |
| 推力 | N | %W | `f / W × 100`（由 instruments.js 已算好） |

`panel/scripts/alt.js`、`airspeed.js` 等传统仪表内部使用 ft / kt；
只有 `disp-alt-agl` 直接复用了 `AltitudeIndication`，因此换算只发生在这一处。

---

## 7. 时序、噪声与回声抑制（实现约定）

1. **物理步长**：`SimCore.step(dt)` 把任意 `dt` 切成 ≤ 0.05 s 的子步；
   单次最多补算 0.25 s，防止页面切后台后“追帧”几小时。
   帧率目标是 20 Hz；实际受绘图/JSON 影响约 16–20 Hz。物理用**真实 dt** 推进，
   所以帧率下降不会改变仿真时间。
2. **预热**：新建会话先空跑 2 s，让 VSI 阻尼器与自动驾驶进入稳态。
3. **VSI 阻尼**：`instruments.js` 内部一阶滞后（τ = 1.5 s），帧里 `vsi.zdot`
   已经是阻尼后的指针值；`vsi.zdotRaw` 只用于诊断。
4. **命令合并**：`CommandQueue` 对连续量按 key（`SPD`/`TRK`/`HDG`/`ALT`）合并，
   30 ms 冲刷一次；按钮命令保序。
5. **回声抑制**：UI 把远端值写回旋钮/鼓轮时加 `_suppress` 标记，
   组件同步触发的 `change` 不会再发回服务器。
6. **鼓轮降频**：`DrumDisplay` 重建 DOM 较贵，UI 限制到约 8 Hz。
7. **断流检测**：超过 3 s 没收到帧，状态页与页眉都显示 `NO DATA`；
   Worker 部署需手动刷新，SSE 部署会自动重连。
