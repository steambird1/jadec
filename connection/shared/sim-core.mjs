/* ============================================================================
 *  sim-core.mjs —— 群玉阁 · 仿真会话核心（物理 / 控制 / 仪表 的运输无关封装）
 *
 *  被两种部署共用：
 *    browser-only   : Web Worker 内实例化（physics 由 physics-bundle.mjs 提供）
 *    browser-server : Node.js 服务器内实例化（physics 由 require 提供）
 *
 *  本文件不依赖任何运行环境（除 Date.now），也不直接引用 physics/ 目录：
 *  构造函数接收 { JadeChamber, FlightControl, InstrumentSuite } 三个类。
 *
 *  输出帧 = {
 *    type:'frame', seq, simTime, wallTime,
 *    data: InstrumentSuite.read() 的完整结果（已 JSON 安全化）,
 *    meta: { units, flags, controls, environment, limits, names, ui }
 *  }
 * ========================================================================== */
'use strict';

/** 物理/控制/仪表的唯一输入来源（与 physics/instruments.js 的单位一致） */
export const DEFAULT_OPTIONS = Object.freeze({
  terrainPreset: 'flat',
  /* 每个仿真步的最大时长；与 flight-control 内部的 0.05 s 控制节拍一致 */
  maxStep: 0.05,
  /* 新建会话时先空跑若干秒，让 VSI 阻尼器与自动驾驶进入稳态 */
  warmupSeconds: 2.0,
  /* 单次 step() 最多补算多少秒（防止页面切后台后“追帧”过久） */
  maxCatchUpSeconds: 0.25,
});

export const TERRAIN_PRESETS = Object.freeze([
  { value: 'flat', label: 'FLAT 平原' },
  { value: 'ramp', label: 'RAMP 缓坡' },
  { value: 'hills', label: 'HILLS 丘陵' },
  { value: 'ridge', label: 'RIDGE 山脊' },
  { value: 'peak', label: 'PEAK 尖峰' },
  { value: 'liyue', label: 'LIYUE 璃月外海' },
]);

/** JSON 安全化：去掉函数、把 NaN/Infinity 变成 null（Worker postMessage 不能克隆函数） */
export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

export class SimCore {
  /**
   * @param {{JadeChamber:Function, FlightControl:Function, InstrumentSuite:Function}} physics
   * @param {object} [options]
   */
  constructor(physics, options = {}) {
    if (!physics || !physics.JadeChamber || !physics.FlightControl || !physics.InstrumentSuite) {
      throw new Error('SimCore: 需要 { JadeChamber, FlightControl, InstrumentSuite }');
    }
    this.physics = physics;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.reset({ terrainPreset: this.options.terrainPreset });
  }

  /* ------------------------------------------------------------------ *
   *  会话生命周期
   * ------------------------------------------------------------------ */
  reset(opts = {}) {
    const terrainPreset = opts.terrainPreset || this.options.terrainPreset;
    this.options.terrainPreset = terrainPreset;

    const { JadeChamber, FlightControl, InstrumentSuite } = this.physics;
    this.jc = new JadeChamber({ terrain: { preset: terrainPreset } });
    this.fc = new FlightControl(this.jc);
    this.suite = new InstrumentSuite(this.jc, this.fc);

    this.simTime = 0;
    this.seq = 0;
    this.startedAt = Date.now();
    this.lastCommand = null;

    /* 预热：不产生帧，只让控制器/阻尼器收敛 */
    const warmSteps = Math.round(this.options.warmupSeconds / this.options.maxStep);
    for (let i = 0; i < warmSteps; i++) {
      this.fc.update(this.options.maxStep);
      this.simTime += this.options.maxStep;
    }
    this.frame = this._buildFrame(this.options.maxStep);
    return this.frame;
  }

  /* ------------------------------------------------------------------ *
   *  推进仿真
   * ------------------------------------------------------------------ */
  /**
   * @param {number} dt 真实经过时间（秒）；内部按 maxStep 切分并限幅
   * @returns {object} 最新帧
   */
  step(dt) {
    let remaining = Number(dt);
    if (!Number.isFinite(remaining) || remaining <= 0) remaining = this.options.maxStep;
    remaining = Math.min(remaining, this.options.maxCatchUpSeconds);

    let total = 0;
    while (remaining > 1e-9) {
      const h = Math.min(this.options.maxStep, remaining);
      this.fc.update(h);
      this.simTime += h;
      total += h;
      remaining -= h;
      if (this.jc.diverged) break;
    }
    this.frame = this._buildFrame(total || this.options.maxStep);
    return this.frame;
  }

  /* ------------------------------------------------------------------ *
   *  命令接口
   *  协议：{ action, ...参数 }
   * ------------------------------------------------------------------ */
  applyCommands(commands) {
    const list = Array.isArray(commands) ? commands : [commands];
    const results = [];
    for (const command of list) {
      try {
        this.applyCommand(command);
        results.push({ ok: true, action: command && command.action });
      } catch (error) {
        results.push({ ok: false, action: command && command.action,
                       error: String(error && error.message || error) });
      }
    }
    if (list.length) this.frame = this._buildFrame(this.options.maxStep);
    return results;
  }

  applyCommand(command) {
    if (!command || typeof command !== 'object') throw new Error('command 必须是对象');
    const p = this.fc.panel;
    const c = this.fc.cfg;
    const jc = this.jc;
    this.lastCommand = { action: command.action, at: Date.now() };

    switch (command.action) {
      /* ---- MCP 旋钮 ---- */
      case 'setKnob': {
        if (command.name === 'CRAB') {
          const mode = String(command.value);
          if (!(mode in this.physics.CRAB_LIMITS)) throw new Error('未知 CRAB 模式: ' + mode);
          p.setKnob('CRAB', mode);
        } else {
          p.setKnob(String(command.name), Number(command.value));
        }
        return;
      }
      case 'nudge':
        p.nudge(String(command.name), Number(command.steps) || 0, !!command.fine);
        return;

      /* ---- MCP 按钮 / 同步 ---- */
      case 'trkSet':
        p.pressTRKSET();
        return;
      case 'sync': {
        const kind = String(command.kind).toUpperCase();
        const S = this.jc.sense();
        const cur = {
          hdg: p.out ? p.out.hdg : this.physics.psiToBearing(S.state.psi),
          trk: p.out ? p.out.trkNow : 0,
          alt: S.gap,
        };
        p.pressSYNC(kind, cur);
        return;
      }
      case 'managed':
        p.pressMANAGED();
        return;
      case 'level':
        p.pressLEVEL(!!command.value);
        return;

      /* ---- 开关 ---- */
      case 'setSwitch':
        this._setSwitch(String(command.name), !!command.value);
        return;
      case 'toggleSwitch':
        this._setSwitch(String(command.name), !this._readSwitch(String(command.name)));
        return;

      /* ---- 压载 / 故障注入 ---- */
      case 'dumpBallast':
        jc.dumpBallast(Math.max(0, Number(command.mass) || 0));
        return;
      case 'setStone': {
        const index = Number(command.index) | 0;
        if (!jc.stones[index]) throw new Error('石头索引越界: ' + index);
        jc.setStone(index, { failed: !!command.failed });
        return;
      }
      case 'toggleStone': {
        const index = Number(command.index) | 0;
        const stone = jc.stones[index];
        if (!stone) throw new Error('石头索引越界: ' + index);
        jc.setStone(index, { failed: !stone.failed });
        return;
      }
      case 'setEngineFailed': {
        const index = Number(command.index) | 0;
        if (!jc.eng[index]) throw new Error('发动机索引越界: ' + index);
        jc.setEngineFailed(index, !!command.failed);
        return;
      }
      case 'toggleEngine': {
        const index = Number(command.index) | 0;
        const engine = jc.eng[index];
        if (!engine) throw new Error('发动机索引越界: ' + index);
        jc.setEngineFailed(index, !engine.failed);
        return;
      }
      case 'setApuFailed':
        jc.setApuFailed(!!command.failed);
        return;
      case 'setWind': {
        /* 输入：speed (m/s) + dirDeg（气象风向 = 风吹向的方位） */
        const speed = Math.max(0, Number(command.speed) || 0);
        const dir = ((Number(command.dirDeg) || 0) % 360 + 360) % 360;
        const rad = dir * Math.PI / 180;
        jc.setWind([speed * Math.sin(rad), speed * Math.cos(rad), 0]);
        return;
      }
      case 'reset':
        this.reset({ terrainPreset: command.terrainPreset || this.options.terrainPreset });
        return;
      case 'ping':
        return;
      default:
        throw new Error('未知命令 action: ' + command.action);
    }
  }

  _readSwitch(name) {
    switch (name) {
      case 'AP': return !!this.fc.panel.ap;
      case 'MANAGED': return !!this.fc.panel.managed;
      case 'HDG_AUTO': return !!this.fc.panel.cfg.hdgAuto.enabled;
      case 'EMERGENCY_DESCENT': return !!this.fc.cfg.emergencyDescent;
      case 'STIFFNESS_LOSS': return !!this.jc.stiffnessFailed;
      case 'YAW_RATE': return !!this.fc.panel.yawRateMode;
      default: throw new Error('未知开关: ' + name);
    }
  }

  _setSwitch(name, value) {
    switch (name) {
      case 'AP': this.fc.panel.ap = value; break;
      case 'MANAGED':
        if (value) this.fc.panel.pressMANAGED();
        else { this.fc.panel.managed = false; this.fc.panel.source = 'MANUAL'; }
        break;
      case 'HDG_AUTO': this.fc.panel.cfg.hdgAuto.enabled = value; break;
      case 'EMERGENCY_DESCENT': this.fc.cfg.emergencyDescent = value; break;
      case 'STIFFNESS_LOSS': this.jc.setStiffnessFailed(value); break;
      case 'YAW_RATE': this.fc.panel.yawRateMode = value; break;
      default: throw new Error('未知开关: ' + name);
    }
    return value;
  }

  /* ------------------------------------------------------------------ *
   *  帧组装
   * ------------------------------------------------------------------ */
  _buildFrame(dt) {
    /* InstrumentSuite.read(dt) 是“物理 → 仪表”的唯一映射，原样发送 */
    const data = this.suite.read(dt);
    const p = this.fc.panel;
    const jc = this.jc;
    const out = p.out || {};

    const frame = {
      type: 'frame',
      protocol: 1,
      seq: ++this.seq,
      simTime: Number(this.simTime.toFixed(3)),
      wallTime: Date.now(),
      data,
      meta: {
        units: {
          speed: 'm/s',
          altitude: 'm',
          verticalSpeed: 'm/s',
          heading: 'deg',
          mass: 'kg',
          thrust: '%W',
        },
        terrainPreset: (jc.terrain && jc.terrain.preset) || this.options.terrainPreset,
        flags: {
          ap: !!p.ap,
          managed: !!p.managed,
          hdgAuto: !!p.cfg.hdgAuto.enabled,
          emergencyDescent: !!this.fc.cfg.emergencyDescent,
          stiffnessFailed: !!jc.stiffnessFailed,
          yawRate: !!p.yawRateMode,
          diverged: !!jc.diverged,
        },
        controls: {
          spd: p.sel.spd,
          trkDraft: p.draft.trk,
          trkSelected: p.sel.trk,
          trkNow: out.trkNow,
          hdg: p.sel.hdg,
          alt: p.sel.alt,
          crabMode: p.crabMode,
          levelMode: p.levelMode,
          source: p.source,
          managed: !!p.managed,
        },
        environment: {
          windWorld: Array.isArray(jc.cfg.windWorld) ? jc.cfg.windWorld.slice(0, 3) : [0, 0, 0],
        },
        limits: {
          Vmax: jc.cfg.Vmax,
          zRef0: jc.cfg.zRef0,
          altMax: 1200,
          ceilingProtectMargin: this.suite.cfg.ceilingProtectMargin,
          FazMax: jc.lim.FazMax,
          Fmax: jc.lim.Fmax,
        },
        names: {
          stones: ['#0', '#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8'],
          engines: jc.eng.map(e => e.name),
          tanks: jc.tanks.map(t => t.name),
        },
        /* 给 UI 的只读派生量（避免前端重复实现物理公式） */
        ui: {
          aglFt: data.altimetry.gap * 3.280839895,
          clearanceFt: data.altimetry.clearance * 3.280839895,
          ceilingFt: data.ceiling.ceiling * 3.280839895,
          speedKt: data.compass.speed * 1.943844492,
          vsiFpm: data.vsi.zdot * 196.8503937,
          vsiBugFpm: data.vsi.bug * 196.8503937,
          canLoseStones: data.ceiling.canLoseStones,
          warningCount: data.annunciators.warning.length,
          cautionCount: data.annunciators.caution.length,
          advisoryCount: data.annunciators.advisory.length,
        },
      },
    };
    return jsonSafe(frame);
  }
}
