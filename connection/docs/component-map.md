# 驾驶舱组件命名表（Panel / Display / Switch）

> 面板定义：`connection/shared/panels/jade-cockpit.json`
> 该文件符合 `panel/scripts/editor-schema.js` 的项目格式（`normalizeProject()` 无警告），
> 可直接在 `panel/editor.html` 中导入、调整布局后再导出。
> 组件库：`D:\Project\Jadec\panel`（`Panel`、`Display`、`DrumDisplay`、
> `ButtonSimple`、`ButtonWithLights`、`IndicatorLight`、`IndicatorLightGroup`、
> `KnobDiscrete`、`KnobContinuous`、`Lever`）
> 数据源：`physics/instruments.js` → `InstrumentSuite.read()` 的 16 个分组
> 命令协议：`connection/docs/data-interface.md` §3

---

## 0. 命名规则

| 前缀 | 组件类型 | 用途 | 例子 |
|---|---|---|---|
| `disp-` | `Display`（Canvas） | 显示屏 / CRT / 自绘机械表 | `disp-ceiling`, `disp-compass` |
| `drum-` | `DrumDisplay` | 机械鼓轮数字窗 | `drum-alt`, `drum-zref-3` |
| `knob-` | `KnobContinuous` / `KnobDiscrete` | 旋钮（连续 / 档位） | `knob-spd`, `knob-crab` |
| `lever-` | `Lever` | 拨杆（离散） | `lever-level` |
| `btn-` | `ButtonSimple` / `ButtonWithLights` | 按钮（可带盖板） | `btn-trk-set`, `btn-stiffness` |
| `light-` | `IndicatorLight` | 指示灯 / 告警灯 | `light-saturated` |
| `lightgroup-` | `IndicatorLightGroup` | 灯组（9 段 / 3×3） | `lightgroup-stones` |

约定：

1. **id 就是数据接口的一部分**：UI、文档、测试都用同一个字符串，不随布局变化。
2. 面板 id 用小写 kebab-case：`main-panel`、`mcp-panel`、`mfd-panel`、`fe-panel`、
   `annunciator-panel`、`system-panel`。
3. 只读仪表用 `disp-`/`drum-`/`light-`；可操作件用 `knob-`/`lever-`/`btn-`。
4. 同一物理量在 PIC 与 FE 重复显示时，使用不同 id（例如
   `light-ceiling-margin` 在主仪表板、`light-warn-ceiling-margin` 在告警板），
   而不是复用同一个组件。
5. **禁止**在 UI 里出现 `ON/OFF/ISOLATE` 单石开关：物理模型没有单石隔离，
   只有 `STONE Z-REF TRIM`（见 `docs/cockpit_design.md` §6）。

---

## 1. `main-panel` — 主仪表板（30 × 8，cell 44）

| 组件 id | 类型 | 显示 / 操作 | 数据源（`data.`） |
|---|---|---|---|
| `light-master-warn` | IndicatorLight | 主警告 | `annunciators.masterWarning` |
| `light-master-caution` | IndicatorLight | 主警戒 | `annunciators.masterCaution` |
| `light-saturated` | IndicatorLight | 包络饱和 | code `SATURATED` |
| `light-terrain-clearance` | IndicatorLight | 真实离地低 | code `TERRAIN_CLEARANCE` |
| `light-ceiling-margin` | IndicatorLight | 升限余量低 | code `CEILING_MARGIN` |
| `light-heading-free` | IndicatorLight | 艏向不可控 | code `HEADING_FREE` |
| `lightgroup-remain-stones` | IndicatorLightGroup 1×9 | 还能坏几块石头（0–8 段） | `ceiling.canLoseStones` |
| `disp-ceiling` | Display 200×200 | **升限余量双针表**：白针 AGL、红针升限、三条固定红线、底部 9 段可失石条 | `ceiling`, `altimetry` |
| `disp-attitude` | Display 207×253 | PFD：姿态球 + 飞行指引 + FMA（2×4） | `attitude`, `mcp`, `meta.flags` |
| `disp-speed` | Display 132×132 | 空速表 0–30 m/s：白针、红限速游标、青 SPD 选择游标 | `compass.speed`, `fieldRate.vLimit`, `mcp.SPD` |
| `disp-alt-agl` | Display 132×132 | AGL 高度表（ft，复用 panel `AltitudeIndication`） | `altimetry.gap`, `mcp.ALT` |
| `disp-vsi` | Display 132×132 | VSI：白针 = `vsi.zdot`（阻尼），红游标 = `vsi.bug`（Ṡ） | `vsi` |
| `disp-clearance` | Display 200×240 | 双高度带：左 AGL/离场 S，右真实离地/T，红 200 m 线 | `altimetry` |
| `disp-compass` | Display 280×280 | CRT 圆表：HDG UP 罗盘卡、速度箭头、HDG/TRK bug、CRAB 扇区、可行艏向扇区 | `compass`, `capability` |
| `drum-margin` | DrumDisplay | 升限余量（m） | `ceiling.margin` |
| `drum-lost` | DrumDisplay | 还能失几块石头 | `ceiling.canLoseStones` |

### 1.1 PFD 的 FMA 内容

| 行 | 栏 1 | 栏 2 | 栏 3 | 栏 4 |
|---|---|---|---|---|
| 绿 | `MANAGED` / `MANUAL` | `AP` / `AP OFF` | `HDG AUTO` / `HDG SEL` | `FOLLOW` / `LEVEL` |
| 青 | `SPD xx.x` | `TRK xxx` | `ALT xxx` | `CRAB <MODE>` |

FMA 只写模式词，不写连续变化的数值（避免每帧触发加框）。

---

## 2. `mcp-panel` — MCP 自动驾驶面板（24 × 6）

| 组件 id | 类型 | 显示 / 操作 | 数据源 / 命令 |
|---|---|---|---|
| `knob-spd` | KnobContinuous 0–22 m/s，0.1 | SPD 选择 | `mcp.SPD.selected` / `setKnob SPD` |
| `drum-spd` | DrumDisplay | SPD 选择值 | `mcp.SPD.selected` |
| `knob-trk` | KnobContinuous 0–359°，1° | TRK **草稿** | `mcp.TRK.draft` / `setKnob TRK` |
| `drum-trk-draft` | DrumDisplay | TRK 草稿窗 | `mcp.TRK.draft` |
| `btn-trk-set` | ButtonSimple | 提交 TRK（草稿→生效） | `trkSet` |
| `drum-trk-sel` | DrumDisplay | TRK 生效窗 | `mcp.TRK.selected` |
| `knob-hdg` | KnobContinuous 0–359°，1° | HDG 选择 | `mcp.HDG.selected` / `setKnob HDG` |
| `drum-hdg` | DrumDisplay | HDG 选择值 | `mcp.HDG.selected` |
| `knob-alt` | KnobContinuous 0–1200 m，0.1 | ALT（zRef AGL） | `mcp.ALT.selected` / `setKnob ALT` |
| `drum-alt` | DrumDisplay | ALT 选择值 | `mcp.ALT.selected` |
| `drum-alt-actual` | DrumDisplay | 当前 AGL | `altimetry.gap` |
| `light-alt-limited` | IndicatorLight | 目标被升限−150 限幅 | `mcp.ALT.limited` |
| `light-trk-pending` | IndicatorLight | 草稿 ≠ 生效（PENDING） | `mcp.TRK.pending` |
| `light-ceiling-protect` | IndicatorLight | 高度保护生效 | code `CEILING_PROTECT` |
| `light-managed` | IndicatorLight | MANAGED 接通 | `mcp.switches.MANAGED` / `meta.flags.managed` |
| `light-ap` | IndicatorLight | AP 接通 | `meta.flags.ap` |
| `light-hdg-auto` | IndicatorLight | HDG AUTO 接通 | `meta.flags.hdgAuto` |
| `knob-crab` | KnobDiscrete `OFF / ±30 / ±10 / ±5` | CRAB LIMIT | `mcp.CRAB.mode` / `setKnob CRAB`（映射 `CRUISE/TRANSIT/PRECISION/BERTH`） |
| `lever-level` | Lever `FOLLOW / LEVEL` | 水平模式 | `mcp.switches.LEVEL` / `level` |
| `btn-managed` | ButtonSimple | 接管 | `managed` |
| `btn-ap` | ButtonSimple | AP 开关 | `toggleSwitch AP` |
| `btn-hdg-auto` | ButtonSimple | 最优艏向开关 | `toggleSwitch HDG_AUTO` |
| `btn-emerg-descent` | ButtonSimple（带盖） | 应急下降（只旁路 τ） | `toggleSwitch EMERGENCY_DESCENT` |
| `btn-sync-hdg` | ButtonSimple | 同步 HDG | `sync HDG` |
| `btn-sync-trk` | ButtonSimple | 同步 TRK | `sync TRK` |
| `btn-sync-alt` | ButtonSimple | 同步 ALT | `sync ALT` |
| `light-level-mode` | IndicatorLight | LEVEL（蓝） | `mcp.switches.LEVEL === 'LEVEL'` |
| `light-emergency` | IndicatorLight | 应急下降生效 | `meta.flags.emergencyDescent` |

---

## 3. `mfd-panel` — CRT 多功能显示（20 × 18）

| 组件 id | 类型 | 显示 | 数据源 |
|---|---|---|---|
| `disp-profile` | Display 520×300 | 场剖面：T 地形填充、S 场参考面、S+gap 预测航迹、最险点 | `fieldProfile` |
| `disp-polar` | Display 420×420 | 能力极坐标：24 艏向 v_max、风矢、最优/最差、可行占比 | `capability` |
| `disp-plan` | Display 520×300 | 升降计划：目标/误差/速率/ETA/阻尼模态 | `zRefPlan`, `damping` |
| `disp-annunc` | Display 420×460 | 告警明细（W/C/A 三级文本） | `annunciators.list` |

---

## 4. `fe-panel` — FE 工程面板（30 × 12）

| 组件 id | 类型 | 显示 / 操作 | 数据源 / 命令 |
|---|---|---|---|
| `lightgroup-stones` | IndicatorLightGroup 3×3 | 9 块石头状态；文本 `#n 101%`，失效变暗，触顶高亮 | `stones.rows` |
| `disp-stone-load` | Display 360×360 | 3×3 出力图：0–150%，绿带 99–101%，角石/边中/中心色环 | `stones.rows` |
| `drum-zref-0` | DrumDisplay | #0 zRef（m） | `stones.rows[0].zRef` |
| `drum-zref-1` | DrumDisplay | #1 zRef | `stones.rows[1].zRef` |
| `drum-zref-2` | DrumDisplay | #2 zRef | `stones.rows[2].zRef` |
| `drum-zref-3` | DrumDisplay | #3 zRef | `stones.rows[3].zRef` |
| `drum-zref-4` | DrumDisplay | #4 zRef | `stones.rows[4].zRef` |
| `drum-zref-5` | DrumDisplay | #5 zRef | `stones.rows[5].zRef` |
| `drum-zref-6` | DrumDisplay | #6 zRef | `stones.rows[6].zRef` |
| `drum-zref-7` | DrumDisplay | #7 zRef | `stones.rows[7].zRef` |
| `drum-zref-8` | DrumDisplay | #8 zRef | `stones.rows[8].zRef` |
| `drum-total-weight` | DrumDisplay | 总重（t） | `weight.M / 1000` |
| `drum-payload-margin` | DrumDisplay | 载荷余量（t，升限约束） | `weight.loadLine.margin / 1000` |
| `drum-water` | DrumDisplay | 水箱总量（t） | `weight.tanks[].m` |
| `drum-trim-spread` | DrumDisplay | 差动 zRef 展开量（m） | `stones.trimSpread` |
| `disp-propulsion` | Display 460×300 | 4 垂推 ±50%、2 azimuth、APU、峰值/TRIM 提示 | `propulsion`, `damping` |
| `light-trim` | IndicatorLight | 推进器持续非零（该配平） | code `TRIM_PERSISTENT` |
| `light-stone-dev` | IndicatorLight | 单石偏差 > 1% | `stones.stoneDevAlarm` |
| `light-fe-level` | IndicatorLight | LEVEL 配平中（蓝） | `attitude.levelMode` |
| `btn-dump` | ButtonSimple（带盖） | 抛 100 t 压载 | `dumpBallast 100000` |

> 9 个 zRef 鼓轮、9 格状态灯与 3×3 出力图使用同一空间顺序：
> 上排 `#6 #7 #8`、中排 `#3 #4 #5`、下排 `#0 #1 #2`（**前排在上**，左列在左）。
> JSON 中鼓轮按该顺序摆放；状态灯的 `texts` 与 UI 的 `STONE_FACE_ORDER`
> 也使用 `[6,7,8,3,4,5,0,1,2]`，避免“选错块”。

---

## 5. `annunciator-panel` — 告警灯板（24 × 9）

| 组件 id | 类型 | 告警代码 | 级别 |
|---|---|---|---|
| `light-warn-stiffness` | IndicatorLight | `STIFFNESS_LOSS` | Warning |
| `light-warn-saturated` | IndicatorLight | `SATURATED` | Warning |
| `light-warn-negative-gm` | IndicatorLight | `NEGATIVE_GM` | Warning |
| `light-warn-stone-lost` | IndicatorLight | `STONE_LOST` | Warning |
| `light-warn-ceiling-margin` | IndicatorLight | `CEILING_MARGIN` | Warning |
| `light-warn-terrain-clearance` | IndicatorLight | `TERRAIN_CLEARANCE` | Warning |
| `light-warn-heading-free` | IndicatorLight | `HEADING_FREE` | Warning |
| `light-warn-diverged` | IndicatorLight | `DIVERGED` | Warning |
| `light-caution-stone-dev` | IndicatorLight | `STONE_DEV` | Caution |
| `light-caution-field-rate` | IndicatorLight | `FIELD_RATE` | Caution |
| `light-caution-trim` | IndicatorLight | `TRIM_PERSISTENT` | Caution |
| `light-caution-crab` | IndicatorLight | `CRAB_LIMIT` | Caution |
| `light-caution-trk-slew` | IndicatorLight | `TRK_SLEW_LTD` | Caution |
| `light-caution-ceiling-protect` | IndicatorLight | `CEILING_PROTECT` | Caution |
| `light-caution-trk-pending` | IndicatorLight | `TRK_PENDING` | Caution |
| `light-adv-no-track` | IndicatorLight | `NO_TRACK` | Advisory |
| `light-adv-zref-diff` | IndicatorLight | `ZREF_DIFFERENTIAL` | Advisory |
| `light-adv-level` | IndicatorLight | `LEVEL_MODE` | Advisory |
| `light-adv-manual` | IndicatorLight | `MANUAL` | Advisory |
| `light-annunc-master-warn` | IndicatorLight | `annunciators.masterWarning` | 总警告 |
| `light-annunc-master-caution` | IndicatorLight | `annunciators.masterCaution` | 总警戒 |

映射实现：`connection/shared/ui/cockpit-ui.mjs` 的 `ANNUNCIATOR_IDS`。
新增告警代码时，必须同时在此表和 `instruments.js` 的 `annunciators()` 中加入。

---

## 6. `system-panel` — 会话 / 故障注入（20 × 8）

> 这一面板不属于飞行仪表，只用于演示与联调：**任何操作都会真实改变物理状态**。

| 组件 id | 类型 | 操作 | 命令 |
|---|---|---|---|
| `light-link` | IndicatorLight | 数据链在线 | 由 UI 连接状态驱动（非物理） |
| `disp-status` | Display 480×320 | 连接/帧号/仿真时间/风/开关/错误 | `frame.meta` + UI `status` |
| `knob-terrain` | KnobDiscrete `FLAT/RAMP/HILLS/RIDGE/PEAK/LIYUE` | 选择重置地形 | 由 `btn-reset` 读取 |
| `btn-reset` | ButtonSimple（带盖） | 新建会话 | `reset {terrainPreset}` |
| `knob-fail-stone` | KnobDiscrete `0..8` | 选择石头编号 | 由 `btn-toggle-stone` 读取 |
| `btn-toggle-stone` | ButtonSimple（带盖） | 翻转该石失效 | `toggleStone {index}` |
| `knob-fail-engine` | KnobDiscrete `FL/FR/RL/RR` | 选择垂推 | 由 `btn-toggle-engine` 读取 |
| `btn-toggle-engine` | ButtonSimple（带盖） | 翻转该垂推失效 | `toggleEngine {index}` |
| `knob-wind-dir` | KnobContinuous 0–359° | 风向（吹向） | 由 `btn-apply-wind` 读取 |
| `knob-wind-speed` | KnobContinuous 0–10 m/s | 风速 | 由 `btn-apply-wind` 读取 |
| `btn-apply-wind` | ButtonSimple | 应用风 | `setWind {speed, dirDeg}` |
| `btn-stiffness` | ButtonWithLights（带盖） | 刚度丧失开关 | `toggleSwitch STIFFNESS_LOSS` |

`btn-stiffness` 的上灯 = `LOSS`（红色），下灯 = `OK`（绿色），
分别由 `meta.flags.stiffnessFailed` 驱动。

---

## 7. 自绘仪表 ↔ Canvas 类

| 组件 id | 类（`shared/ui/canvas-instruments.mjs`） | 说明 |
|---|---|---|
| `disp-ceiling` | `CeilingGauge` | 双针 + 固定红线 + 可失石灯条 |
| `disp-speed` | `SpeedGauge` | 0–30 m/s，红限速游标 |
| `disp-vsi` | `VsiGauge` | 针 = ż，游标 = Ṡ |
| `disp-compass` | `CompassRose` | HDG UP + CRAB 扇区 + 可行扇区 |
| `disp-clearance` | `ClearanceTape` | AGL / 真实离地双带 |
| `disp-profile` | `ProfileDisplay` | T / S / 预测航迹 |
| `disp-polar` | `PolarDisplay` | 能力极坐标 |
| `disp-stone-load` | `StoneLoadDisplay` | 3×3 出力图 |
| `disp-propulsion` | `PropulsionDisplay` | 4 垂推 + 2 azimuth + APU |
| `disp-plan` | `PlanPage` | 升降计划文本页 |
| `disp-annunc` | `AnnuncPage` | 告警文本页 |
| `disp-status` | `StatusPage` | 连接状态页 |

复用 panel 原生仪表：

| 组件 id | panel 类 |
|---|---|
| `disp-attitude` | `PrimaryFlightDisplay`（`panel/scripts/pfd.js`） |
| `disp-alt-agl` | `AltitudeIndication`（`panel/scripts/alt.js`） |
| `drum-*` | `DrumDisplay` |
| `light-*` | `IndicatorLight` / `IndicatorLightGroup` |
| `knob-*` | `KnobContinuous` / `KnobDiscrete` |
| `lever-*` | `Lever` |
| `btn-*` | `ButtonSimple` / `ButtonWithLights` |

---

## 8. 新增组件检查单

1. 在 `jade-cockpit.json` 加组件，id 遵循 §0 前缀规则，且全局唯一。
2. 如果它显示物理量：在 `cockpit-ui.mjs` 的 `applyFrame()` 里绑定 `data.*`，
   **不要在 UI 里重算物理公式**。
3. 如果它接受操作：在 `_bindControls()` 里翻译成 §3 的命令；
   连续量要传 `coalesceKey`。
4. 如果它是 `Display` 且需要自绘：在 `customFactory` 注册并实现 `render(frame)`。
5. 如果是告警灯：同时更新 `ANNUNCIATOR_IDS` 与 `instruments.js`。
6. 更新本文档与 `docs/data-interface.md` 的对应表。
