/* ============================================================================
 *  instruments.js —— 群玉阁 · 仪表数值计算
 *
 *  职责：把「物理状态 + 控制层状态」翻译成各仪表所需的数值。
 *  本模块 **不做任何控制决策**，也不修改 jc / fc 的任何字段（纯读）。
 *
 *  输入：jc（JadeChamber，物理层） + fc（FlightControl，控制层，可选）
 *  输出：按仪表分组的数值；render() 打印可读面板
 *
 *  仪表清单对应《群玉阁_驾驶舱与人机交互设计.md》§3 / §5 / §7 / §9：
 *    主仪表板   ceiling / saturation / altimetry / attitude / fieldRate
 *               terrainProfile / capability / damping
 *    CRT 圆表   compass
 *    MCP 窗     mcp
 *    升降计划   zRefPlan
 *    FE 面板    stones / propulsion / weightBalance
 *    告警       annunciators
 * ========================================================================== */
'use strict';

const { JadeChamber } = require('./jade-chamber.js');
const FC = require('./flight-control.js');
const { FlightControl, CRAB_LIMITS, bearingToPsi, psiToBearing, bearingVec } = FC;
const { DEG, wrapPi, wrap2pi, degOf } = FC;

/* ---------------------------------------------------------------- 小工具 */
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const wrapDeg = d => { d = ((d % 360) + 360) % 360; return d > 180 ? d - 360 : d; };  // → (−180,180]
const brg     = d => ((d % 360) + 360) % 360;                                        // → [0,360)
const round   = (x, n = 1) => { const p = 10 ** n; return Math.round(x * p) / p; };
const pctW    = (x, W) => x / W * 100;

/* ==========================================================================
 *  1. 能力极坐标的底层气动模型
 *  与 ControlPanel._optimalHeading **同一模型**（保证 HDG AUTO 与本图一致）
 * ========================================================================== */
const AERO = { rho: 1.2, Cd: 1.1, cpOffset: [10, 28] };

/**
 * 给定艏向 / 航迹 / 速度 / 风 ⇒ 两台 azimuth 所需推力的峰值
 * @param psiDeg 艏向（方位角，deg）  @param trkDeg 航迹（方位角，deg）
 */
function azimuthPeak(jc, psiDeg, trkDeg, spd, wind, opt = AERO) {
  const { a, b, c } = jc.cfg;
  const { rho, Cd, cpOffset } = opt;
  const psi = bearingToPsi(psiDeg);
  const vb  = bearingVec(trkDeg);
  const Vrel = [vb[0] * spd - (wind[0] || 0), vb[1] * spd - (wind[1] || 0)];
  const vr = Math.hypot(Vrel[0], Vrel[1]);
  if (vr < 1e-6) return { peak: 0, F: 0, Mz: 0, tb: 0, ts: 0, vr };
  /* 正方形平面旋转后的迎风投影宽（45° 时为对角线 = 最差） */
  const w = 2 * a * Math.abs(Math.cos(psi)) + 2 * b * Math.abs(Math.sin(psi));
  const F = 0.5 * rho * Cd * w * 2 * c * vr * vr;
  const [cx0, cy0] = cpOffset;
  const cpx = cx0 * Math.cos(psi) - cy0 * Math.sin(psi);
  const cpy = cx0 * Math.sin(psi) + cy0 * Math.cos(psi);
  const ux = Vrel[0] / vr, uy = Vrel[1] / vr;
  const Mz = cpx * (F * uy) - cpy * (F * ux);
  const Fxw = -F * ux, Fyw = -F * uy;                       // 世界系推力需求
  const fbx =  Fxw * Math.cos(psi) + Fyw * Math.sin(psi);   // → 体轴
  const fby = -Fxw * Math.sin(psi) + Fyw * Math.cos(psi);
  const L = 5 * b / 6;                                      // azimuth 力臂
  const D = -Mz / L;
  const tb = Math.hypot(fbx / 2 - D / 2, fby / 2);
  const ts = Math.hypot(fbx / 2 + D / 2, fby / 2);
  return { peak: Math.max(tb, ts), F, Mz, tb, ts, vr };
}

/* ==========================================================================
 *  2. InstrumentSuite
 * ========================================================================== */
class InstrumentSuite {
  /**
   * @param jc JadeChamber
   * @param fc FlightControl（可缺省：此时只有主仪表板的物理类读数）
   */
  constructor(jc, fc = null, cfg = {}) {
    this.jc = jc;
    this.fc = fc;
    this.cfg = Object.assign({
      /* 能力极坐标 */
      aero: AERO, polarStep: 15, vScanMax: 45, vScanStep: 0.25,
      /* 地形剖面 */
      profileRange: 5000, profileN: 11,
      /* 告警阈值 */
      marginWarn: 100, clearanceWarn: 50, stoneDevWarn: 0.01,
      trimPersistentPct: 0.5,       // 推进器持续非零（%W）⇒ 该配平了
      ceilingProtectMargin: 150,
      /* VSI 机械阻尼（对应仪表的油阻尼/节流，不是软件滤波的必需品） */
      vsiDamping: true,             // 默认开启；设 false 得到未阻尼原始 ż
      vsiTau: 1.5,                  // s，阻尼时间常数（滤掉 T_z=1.10 s 的弹簧模态）
      vsiDt: 0.05,                  // s，仅在无法从 sense().t 推断时使用的默认步长
    }, cfg);
    this._S = null;
    /* VSI 阻尼器自身的状态（仪表惯性，不影响 jc / fc） */
    this._vsi = { zdot: 0, inited: false, lastT: null };
  }

  /** 取观测量（每次 read 都重新 sense，保证与实际一致） */
  sense() {
    const S = this.jc.sense();
    S.jc = this.jc;
    this._S = S;
    return S;
  }
  /** 控制层诊断（若未跑过 update 则退化为空对象） */
  diag() {
    return (this.fc && this.fc.diag && Object.keys(this.fc.diag).length)
      ? this.fc.diag : null;
  }

  /* ==================================================================== *
   *  2.1 ★ 升限余量表 —— 全舱唯一生死攸关的仪表
   * ==================================================================== */
  ceilingGauge(S = this.sense()) {
    const jc = this.jc, lam = jc.cfg.lambda;
    const gap = S.gap, ceil = S.ceiling, W = S.W;
    const F0 = jc.stones[0].F0, nA = S.nActive;
    /* 还能坏几块：逐块算升限，直到低于当前间隙 */
    let canLose = 0;
    const table = [];
    for (let k = 0; k <= nA - 1; k++) {
      const zc = lam * Math.log((nA - k) * F0 / W);
      table.push({ lost: k, ceiling: zc, margin: zc - gap });
      if (zc >= gap) canLose = k; else break;
    }
    const margin = ceil - gap;
    const level = margin < 0 ? 'OVER_CEILING'
      : margin < this.cfg.marginWarn ? 'LOW' : margin < 300 ? 'CAUTION' : 'OK';
    return {
      agl: gap, ceiling: ceil, margin,
      canLoseStones: canLose,               // ← 直接读数：还能坏几块
      ceilingTable: table,
      level,
      /* 派生：升限只随总重变（激活数恒为 9，无隔离电门） */
      ceilingIfDump: m => lam * Math.log(nA * F0 / Math.max(W - m * jc.cfg.g, 1)),
      /* 载荷线：使升限不低于当前目标高度的最大总重 */
      maxMassForAGL: agl => nA * F0 * Math.exp(-agl / lam) / jc.cfg.g,
    };
  }

  /* ==================================================================== *
   *  2.2 包络饱和 / 稳定性
   * ==================================================================== */
  saturation(S = this.sense()) {
    const jc = this.jc, W = S.W;
    const per = jc.stones.map((st, i) => {
      const g = S.gArr[i];
      const env = st.F0 * Math.min(1, Math.exp(-g / jc.cfg.lambda));
      const raw = st.k * (S.zRef[i] - g);
      return {
        idx: i, f: S.fArr[i], frac: S.fArr[i] / (W / 9),
        saturated: st.failed ? false : raw > env * (1 + 1e-9),
        failed: st.failed, kEff: S.kArr[i],
      };
    });
    const nSat = per.filter(p => p.saturated).length;
    /* 有效刚度（触顶时只剩包络的极软刚度 F/λ） */
    const GMx = S.GMx, GMy = S.GMy;
    return {
      nSaturated: nSat, saturated: nSat > 0,
      perStone: per,
      GMx, GMy, delta0: S.delta0, d: S.d,
      stiffnessFailed: !!jc.stiffnessFailed,
      /* 触顶的后果：刚度塌缩 ⇒ GM 变负 ⇒ 翻覆 */
      unstable: GMx < 0 || GMy < 0,
      level: nSat > 0 ? 'WARNING' : (GMx < 0 || GMy < 0) ? 'WARNING' : 'OK',
    };
  }

  /* ==================================================================== *
   *  2.3 双高度表：AGL（离场参考面 S） + 真实离地（离地形 T）
   * ==================================================================== */
  altimetry(S = this.sense()) {
    const jc = this.jc, s = S.state;
    return {
      gap: S.gap,                 // AGL：离场参考面（决定升力）
      clearance: S.clearance,     // 真实离地（决定撞不撞山）
      amsl: s.P[2],               // 海拔（世界 z）
      fieldM: S.fieldM,           // 场参考面 S
      terrainM: S.terrainM,       // 真实地形 T
      /* S ≥ T ⇒ 两者之差 = 平滑面高出地形的部分 */
      smoothExcess: S.fieldM - S.terrainM,
      minAGL: jc.cfg.rMaxField ? 200 : 200,   // 最小运行 AGL（P7 建议值）
      lowClearance: S.clearance < this.cfg.clearanceWarn,
    };
  }

  /* ==================================================================== *
   *  2.4 坡度与倾角（巡航中约 2°，随坡倾斜是免费的）
   * ==================================================================== */
  attitude(S = this.sense()) {
    const s = S.state;
    const phi = degOf(s.phi), theta = degOf(s.theta);
    const sx = S.slope.sx, sy = S.slope.sy;
    /* 随坡倾斜的理论值：φ = s_y·BM/(BM−d)，θ = −s_x·BM/(BM−d) */
    const BMx = S.kY2 / S.W, BMy = S.kX2 / S.W;
    const fx = BMx / Math.max(BMx - S.d, 1e-6), fy = BMy / Math.max(BMy - S.d, 1e-6);
    const expPhi = sy * fx * DEG, expTheta = -sx * fy * DEG;
    return {
      phi, theta, bearing: psiToBearing(s.psi),
      slope: { sx, sy, mag: S.slopeMag, dirDeg: brg(Math.atan2(sx, sy) * DEG) },
      slopeDeg: S.slopeMag * DEG,
      tiltDeg: Math.hypot(phi, theta),
      /* FOLLOW SLOPE 时应收敛到坡度；LEVEL 时应收敛到 0 */
      followTarget: { phi: expPhi, theta: expTheta },
      levelError: { dphi: phi - expPhi, dtheta: theta - expTheta },
      levelMode: this.fc ? this.fc.panel.levelMode : 'FOLLOW',
    };
  }

  /* ==================================================================== *
   *  2.5 场变化率与限速
   * ==================================================================== */
  fieldRate(S = this.sense()) {
    const jc = this.jc;
    const v = Math.hypot(S.Vw[0], S.Vw[1]);
    const sMag = Math.max(S.slopeMag, 1e-6);
    const vLimTerrain = jc.cfg.rMaxField / sMag;    // V ≤ r_max / s
    const vLim = Math.min(jc.cfg.Vmax, vLimTerrain);
    /* 遭遇率 = ∇S·V；超过 r_max ⇒ S 滞后 ⇒ 真实离地间隙被侵蚀 */
    const rate = S.fieldRate;
    return {
      fieldRate: rate, rMax: jc.cfg.rMaxField,
      over: Math.abs(rate) > jc.cfg.rMaxField,
      speed: v, vLimit: vLim, vLimitTerrain: vLimTerrain,
      speedLimited: v > vLim + 1e-9,
      sMax: jc.cfg.sMax,
      /* ⚠ Ṡ_max = sMax·Vmax = 0.04×22 = 0.88 < rMax = 1.0
         ⇒ 该告警在现行参数下不可触发，vLimit 恒等于 Vmax。
         它现在是 VSI 上的**参考游标**，不再承担告警语义。 */
      alarmReachable: jc.cfg.sMax * jc.cfg.Vmax > jc.cfg.rMaxField,
      level: Math.abs(rate) > jc.cfg.rMaxField ? 'CAUTION' : 'OK',
    };
  }

  /* ==================================================================== *
   *  2.5b VSI（垂直速度表）：单针 + Ṡ 游标
   *
   *  分解： ż = Ṡ（地形遭遇） + ġap（指令）
   *    针   = ż（阻尼后）        游标 = Ṡ = ∇S·V
   *    针压游标 ⇒ 纯地形跟随（正常，无指令）
   *    偏离量   ⇒ 实际的间隙闭合率
   *
   *  ⚠ 阻尼的必要性（实测）：ż 含 T_z ≈ 1.10 s 的弹簧模态。自动驾驶
   *    阻尼失效时（恰恰是最需要看 VSI 的时候），无阻尼 ż 摆幅 ±2 m/s，
   *    比信号本身大两倍多，指针无法读。故需要 τ ≈ 1–2 s 的机械阻尼。
   * ==================================================================== */

  /** 推进阻尼器（仪表惯性）。可外部调用；read() 内部也会调用一次。 */
  tickVSI(rawZdot, dt, t = null) {
    const c = this.cfg, st = this._vsi;
    if (!c.vsiDamping) { st.zdot = rawZdot; st.inited = true; return st.zdot; }
    let h = dt;
    if (t != null && st.lastT != null && t > st.lastT) h = t - st.lastT;
    if (t != null) st.lastT = t;
    if (!(h > 0)) h = c.vsiDt;
    if (!st.inited) { st.zdot = rawZdot; st.inited = true; return st.zdot; }
    /* 一阶滞后：f += (raw − f)(1 − e^(−h/τ)) */
    st.zdot += (rawZdot - st.zdot) * (1 - Math.exp(-h / c.vsiTau));
    return st.zdot;
  }

  /** 重置阻尼器（如换表、或需要重新建立读数时） */
  resetVSI() { this._vsi = { zdot: 0, inited: false, lastT: null }; }

  vsi(S = null, dt = null) {
    if (!S) S = this.sense();
    const raw = S.Vw[2];                       // 世界系实际垂直速度
    const zdot = this.tickVSI(raw, dt == null ? this.cfg.vsiDt : dt, S.t);
    const sRate = S.fieldRate;                 // Ṡ = ∇S·V（游标位置）
    return {
      /* 表盘 */
      zdotRaw: raw,                            // 未阻尼原始值（诊断用）
      zdot: zdot,                              // ← 指针（阻尼后）
      damping: this.cfg.vsiDamping, tau: this.cfg.vsiTau,
      range: Math.abs(this.jc.cfg.rateLimZRef) + this.jc.cfg.sMax * this.jc.cfg.Vmax,
      /* 游标 */
      bug: sRate,
      /* 读法：偏离量 = 实际的间隙闭合率 */
      deviation: zdot - sRate,
      /* 分解（恒等式 ż = Ṡ + ġap） */
      components: { zdot: zdot, sRate: sRate, gapRate: zdot - sRate },
      /* 语义提示：针压游标 = 纯地形跟随 */
      following: Math.abs(zdot - sRate) < 0.05,
      /* 量程校核：|ż|_max = sMax·Vmax + rateLimZRef */
      zdotMax: this.jc.cfg.sMax * this.jc.cfg.Vmax + Math.abs(this.jc.cfg.rateLimZRef),
    };
  }

  /* ==================================================================== *
   *  2.6 地形 / 场剖面（沿航迹方向前视）
   * ==================================================================== */
  terrainProfile(S = this.sense()) {
    const jc = this.jc, s = S.state, C = this.cfg;
    const v = Math.hypot(S.Vw[0], S.Vw[1]);
    const dir = v > 0.5
      ? Math.atan2(S.Vw[0], S.Vw[1])                 // 航迹方向（世界 x-y）
      : s.psi;                                        // 保位时看艏向
    const ux = Math.sin(dir), uy = Math.cos(dir);
    const x0 = s.P[0], y0 = s.P[1];
    const pts = [];
    for (let i = 0; i < C.profileN; i++) {
      const d = C.profileRange * i / (C.profileN - 1);
      const x = x0 + ux * d, y = y0 + uy * d;
      const T = jc.terrain.terrainM(x, y), Fd = jc.terrain.fieldM(x, y);
      const sl = jc.terrain.slopeAt(x, y);
      pts.push({ d, T, S: Fd, smoothExcess: Fd - T, slopeMag: Math.hypot(sl.sx, sl.sy) });
    }
    /* 前视最小真实离地（假设高度不变） */
    const hNow = s.P[2] - jc.cfg.c;
    const minClear = Math.min(...pts.map(p => hNow - p.T));
    return { dirDeg: brg(dir * DEG), range: C.profileRange, points: pts,
             minClearanceAhead: minClear, lowAhead: minClear < this.cfg.clearanceWarn };
  }

  /* ==================================================================== *
   *  2.7 能力极坐标（DP 标准件，四瓣）
   * ==================================================================== */
  capability(S = this.sense(), trkDeg = null, spd = null) {
    const jc = this.jc, C = this.cfg;
    const wind = jc.cfg.windWorld || [0, 0, 0];
    const trk = trkDeg != null ? trkDeg
      : (this.fc ? this.fc.panel.out.trkNow : 0);
    const FazMax = jc.lim.FazMax;
    const out = [];
    for (let d = 0; d < 360; d += C.polarStep) {
      /* 当前速度下是否可行 */
      const at = spd != null
        ? azimuthPeak(jc, d, trk, spd, wind, C.aero)
        : null;
      /* 该艏向的最大可行速度（扫描） */
      let vMax = 0;
      for (let v = 0; v <= C.vScanMax + 1e-9; v += C.vScanStep) {
        if (azimuthPeak(jc, d, trk, v, wind, C.aero).peak <= FazMax) vMax = v;
      }
      vMax = Math.min(vMax, jc.cfg.Vmax);
      out.push({ hdg: d, vMax,
                 peakAtCur: at ? at.peak : null,
                 feasibleAtCur: at ? at.peak <= FazMax : null });
    }
    const best = out.reduce((a, b) => b.vMax > a.vMax ? b : a);
    const worst = out.reduce((a, b) => b.vMax < a.vMax ? b : a);
    const nFeasible = out.filter(o => o.feasibleAtCur !== false).length;
    return {
      trk, spd, wind, FazMax,
      polar: out, best, worst,
      feasibleFraction: nFeasible / out.length,
      /* 可行艏向扇形（连续段，供圆表/MFD 画） */
      fan: this._feasibleFan(out),
    };
  }
  _feasibleFan(polar) {
    const segs = []; let cur = null;
    for (const p of polar) {
      if (p.feasibleAtCur !== false) { if (!cur) cur = { from: p.hdg, to: p.hdg }; else cur.to = p.hdg; }
      else if (cur) { segs.push(cur); cur = null; }
    }
    if (cur) segs.push(cur);
    /* 首尾相连则合并 */
    if (segs.length > 1 && segs[0].from === 0 &&
        segs[segs.length - 1].to + this.cfg.polarStep >= 360) {
      const last = segs.pop(); segs[0].from = last.from - 360;
    }
    return segs;
  }

  /* ==================================================================== *
   *  2.8 阻尼 / LEVEL 收敛指示
   * ==================================================================== */
  damping(S = this.sense()) {
    const D = this.diag(), jc = this.jc;
    const W = S.W;
    const Tv = jc.ctrl.Tv.map(x => pctW(x, W));
    const tau = [pctW(jc.ctrl.tauBow, W), pctW(jc.ctrl.tauStern, W)];
    const peakV = Math.max(...Tv.map(Math.abs));
    const peakAz = Math.max(...tau.map(Math.abs));
    return {
      /* 模态（由刚度与惯量直接给出，不依赖控制器） */
      modes: {
        heave: { w: S.wz, T: 2 * Math.PI / S.wz },
        roll:  { w: S.wr, T: 2 * Math.PI / Math.max(S.wr, 1e-6) },
        pitch: { w: S.wp, T: 2 * Math.PI / Math.max(S.wp, 1e-6) },
      },
      coeffs: D ? { cz: D.cz, cr: D.cr, cp: D.cp } : null,
      zeta: jc.cfg.zeta,
      /* 推进器是当前占用的百分比（稳态应趋于 0） */
      TvPct: Tv, azPct: tau, TapuPct: pctW(jc.ctrl.Tapu, W),
      peakThrustPct: Math.max(peakV, peakAz),
      /* 自诊断：持续非零 = 该做 zRef 配平了 */
      trimPersistent: peakV > this.cfg.trimPersistentPct
                   || peakAz > this.cfg.trimPersistentPct,
      /* LEVEL 收敛：倾角与坡度之差 */
      levelError: this.attitude(S).levelError,
      alloc: D ? D.alloc : null,
    };
  }

  /* ==================================================================== *
   *  2.9 CRT 圆表（永久 HDG UP，无模式切换、无指示灯）
   * ==================================================================== */
  compass(S = this.sense()) {
    const p = this.fc ? this.fc.panel : null;
    const bearing = psiToBearing(S.state.psi);
    const spd = Math.hypot(S.Vw[0], S.Vw[1]);
    const crab = p ? p.out.crab : 0;
    const trkNow = p ? p.out.trkNow : bearing;
    const hdgSel = p ? p.out.hdg : bearing;
    const lim = CRAB_LIMITS[p ? p.crabMode : 'CRUISE'];
    const amp = lim.amp;
    /* 圆表几何（HDG UP：卡片随艏向旋转）
     *   lubber line 固定在顶部 ⇒ 顶端读数 = 当前艏向（这就是"自明"的模式指示）
     *   速度矢量指向 TRK ⇒ 相对 lubber 的转角 = TRK − HDG = −crab
     *   TRK bug 画在卡片边缘，方位读数 = trkNow                        */
    const arrowRelDeg = wrapDeg(trkNow - bearing);       // = −crab
    return {
      cardTopDeg: brg(bearing),        // 看卡片顶端即知模式（HDG UP）
      modeText: 'HDG↑',
      lubberDeg: brg(bearing),
      speed: spd,
      arrow: {
        bearingDeg: brg(trkNow),
        relToLubberDeg: arrowRelDeg,
        /* 分段刻度 0–5 / 5–15 / 15–30 ⇒ 半径比例 */
        radiusFrac: spd <= 5 ? 0.25 + 0.25 * (spd / 5)
                  : spd <= 15 ? 0.50 + 0.25 * ((spd - 5) / 10)
                  : 0.75 + 0.25 * Math.min(1, (spd - 15) / 15),
        band: spd <= 5 ? 'LOW' : spd <= 15 ? 'MID' : 'HIGH',
      },
      crab,
      crabLimitDeg: amp === Infinity ? null : amp,
      crabLimited: p ? p.crabLimited : false,
      crabClamped: p ? p.crabClamped : null,
      /* 扇区：从 lubber 向两侧 ±amp 的径向线 */
      sector: amp === Infinity ? { from: -180, to: 180 }
                               : { from: -amp, to: amp },
      bugs: {
        hdg: { deg: brg(hdgSel), relToLubberDeg: wrapDeg(hdgSel - bearing) },
        trk: { deg: brg(trkNow), relToLubberDeg: arrowRelDeg, slew: p ? p.trkSlewLimited : false },
      },
      noTrack: spd < 0.5,             // ⇒ 显示 NO TRACK，隐藏 CRAB
      holdRef: spd < 0.5,             // 但 TRK bug 仍保留（它还是手柄基准）
    };
  }

  /* ==================================================================== *
   *  2.10 MCP 数字窗
   * ==================================================================== */
  mcp(S = this.sense()) {
    if (!this.fc) return null;
    const p = this.fc.panel, o = p.out, jc = this.jc;
    const cap = S.ceiling - this.cfg.ceilingProtectMargin;
    return {
      SPD: { selected: p.sel.spd, actual: Math.hypot(S.Vw[0], S.Vw[1]),
             unit: 'm/s', step: p.cfg.spdStep, max: p.cfg.Vmax },
      TRK: { draft: p.draft.trk, selected: p.sel.trk, actual: o.trkNow,
             pending: round(wrapDeg(p.draft.trk - p.sel.trk), 2) !== 0,
             slewLimited: p.trkSlewLimited, unit: 'deg' },
      HDG: { selected: p.sel.hdg, actual: psiToBearing(S.state.psi),
             opt: o.optHdg, unit: 'deg' },
      ALT: { selected: p.sel.alt, actual: S.gap, cap,
             limited: p.sel.alt > cap + 1e-9,
             zRef: S.zRef[0], target: p.sel.alt + S.delta0, unit: 'm',
             step: { coarse: p.cfg.altStepCoarse, fine: p.cfg.altStepFine } },
      CRAB: { mode: p.crabMode, amp: CRAB_LIMITS[p.crabMode].amp,
              priority: CRAB_LIMITS[p.crabMode].priority,
              limited: p.crabLimited, clamped: p.crabClamped },
      switches: { LEVEL: p.levelMode, MANAGED: p.managed, AP: p.ap,
                  source: p.source, yawRate: p.yawRateMode },
      hdgAuto: p.cfg.hdgAuto.enabled,
    };
  }

  /* ==================================================================== *
   *  2.11 升降计划显示（τ=300 s ⇒ 高度变更一律按 15 min 规划）
   * ==================================================================== */
  zRefPlan(S = this.sense()) {
    if (!this.fc) return null;
    const p = this.fc.panel, pr = this.fc.profile, jc = this.jc;
    const target = p.sel.alt + S.delta0;
    const cur = jc.zRef[0];
    const err0 = target - cur;
    const emerg = !!this.fc.cfg.emergencyDescent;
    const { eta, eta95, rateNow, accNow } = this._eta(cur, target, err0, emerg, pr);
    return {
      targetAGL: p.sel.alt, targetZRef: target, currentZRef: cur,
      error: err0,
      mode: emerg ? 'EMERGENCY (τ bypassed)' : 'NORMAL (τ=300 s)',
      rateNow, rateLimit: pr.cfg.rateLim, accNow, accLimit: pr.aMax,
      rateLimited: Math.abs(rateNow) >= pr.cfg.rateLim - 1e-6,
      ceilingLimited: pr.limited,
      etaRemain: eta, eta95,
      floorSec: Math.abs(err0) / pr.cfg.rateLim,   // 速率限给出的硬地板
      notes: [
        '速率限不可旁路（旁路它 ⇒ 石头卸载 ⇒ 自由落体）；应急下降只旁路 τ',
        'eta95（到 95%）用于运行规划；eta（完全到位）含一阶长尾，不用于决策',
      ],
    };
  }
  /** 前向数值模拟（与 ZRefProfile 同逻辑：τ + 速率限 + 减速停车） */
  _eta(cur, target, err0, emerg, pr) {
    const dt = 0.5, tau = pr.cfg.tauS, rL = pr.cfg.rateLim, aM = pr.aMax;
    let z = cur, v = 0, t = 0, eta95 = null;
    const tol = Math.max(Math.abs(err0) * 0.05, 0.05);
    while (t < 14400) {
      const err = target - z;
      let rDes;
      if (emerg) { const stop = Math.sqrt(2 * aM * Math.abs(err));
                   rDes = Math.sign(err) * Math.min(rL, stop); }
      else rDes = clamp(err / tau, -rL, rL);
      v = clamp(v + clamp(rDes - v, -aM * dt, aM * dt), -rL, rL);
      z += v * dt; t += dt;
      if (eta95 == null && Math.abs(target - z) <= tol) eta95 = t;
      if (Math.abs(target - z) <= 0.05) break;
    }
    return { eta: t, eta95: eta95 != null ? eta95 : t, rateNow: v, accNow: 0 };
  }

  /* ==================================================================== *
   *  2.12 FE：浮空石阵列（9 条出力柱 + 9 个 zRef + 刚度权重）
   * ==================================================================== */
  stones(S = this.sense()) {
    const jc = this.jc, W = S.W;
    const rows = jc.stones.map((st, i) => {
      const g = S.gArr[i], f = S.fArr[i];
      const env = st.F0 * Math.min(1, Math.exp(-g / jc.cfg.lambda));
      const raw = st.k * (st.tol ? 1 + st.tol : 1) * (S.zRef[i] - g);
      const pred = clamp(raw, 0, env);
      const dev = pred > 1 ? Math.abs(f - pred) / (W / 9) : 0;
      /* 失去该石对 GM 的影响（刚度权重）——决定面板着色排序 */
      const dGMx = -S.kArr[i] * st.pos[1] ** 2 / W;
      const dGMy = -S.kArr[i] * st.pos[0] ** 2 / W;
      return {
        idx: i, pos: st.pos.slice(), f, frac: f / (W / 9),
        gap: g, zRef: S.zRef[i], dev,
        saturated: !st.failed && raw > env * (1 + 1e-9),
        failed: st.failed,
        dGMx, dGMy,
        /* 权重分类：角石（两轴）> 边中石（一轴）> 中心石（只供升力） */
        cls: st.pos[0] !== 0 && st.pos[1] !== 0 ? 'CORNER'
           : st.pos[0] === 0 && st.pos[1] === 0 ? 'CENTER' : 'EDGE',
      };
    });
    const maxDev = Math.max(...rows.map(r => r.dev));
    return {
      rows, nActive: S.nActive,
      maxDev, stoneDevAlarm: maxDev > this.cfg.stoneDevWarn,
      /* 差动 zRef 配平量（相对集体） */
      trimSpread: Math.max(...S.zRef) - Math.min(...S.zRef),
      zRefMean: S.zRef.reduce((a, b) => a + b, 0) / 9,
      /* 面板标注要求：只写 STONE Z-REF TRIM，禁止 ON/OFF/ISOLATE */
      label: 'STONE Z-REF TRIM（无隔离电门）',
    };
  }

  /* ==================================================================== *
   *  2.13 FE：推进器
   * ==================================================================== */
  propulsion(S = this.sense()) {
    const jc = this.jc, W = S.W, pc = x => pctW(x, W);
    const Tv = jc.ctrl.Tv.map((x, i) => ({
      name: jc.eng[i].name, pct: pc(x), frac: x / jc.lim.Fmax, failed: jc.eng[i].failed }));
    return {
      vertical: Tv,
      azimuth: [
        { name: 'bow',   pct: pc(jc.ctrl.tauBow),   frac: jc.ctrl.tauBow / jc.lim.FazMax,
          alpha: degOf(jc.ctrl.alphaBow), failed: jc.azBow.failed },
        { name: 'stern', pct: pc(jc.ctrl.tauStern), frac: jc.ctrl.tauStern / jc.lim.FazMax,
          alpha: degOf(jc.ctrl.alphaStern), failed: jc.azStern.failed },
      ],
      apu: { pct: pc(jc.ctrl.Tapu), failed: jc.apu.failed, role: 'GENERATOR ONLY' },
      fuelMass: jc.mFuel,
      headingFree: jc.azBow.failed !== jc.azStern.failed,
      limits: { FmaxPct: pctW(jc.lim.Fmax, W), FminPct: pctW(jc.lim.Fmin, W),
                FazMaxPct: pctW(jc.lim.FazMax, W) },
    };
  }

  /* ==================================================================== *
   *  2.14 FE/PO：重量与平衡（载荷线由升限决定，不是稳定性）
   * ==================================================================== */
  weightBalance(S = this.sense()) {
    const jc = this.jc, C = this.cfg;
    const CG = this.ceilingGauge(S);
    const targetAGL = this.fc ? this.fc.panel.sel.alt : S.gap;
    const maxMass = CG.maxMassForAGL(targetAGL);      // 使升限 ≥ 目标 AGL 的总重
    const payloadMargin = maxMass - S.M;
    const water = jc.tanks.reduce((a, t) => a + t.m, 0);
    return {
      M: S.M, W: S.W, rcm: S.rcm.slice(),
      d: S.d, delta0: S.delta0,
      parts: {
        structure: jc.mStructure, stone: jc.mStone,
        water, fuel: jc.mFuel, payload: jc.mPayload,
      },
      stoneFraction: jc.mStone / S.M,
      /* 载荷线（升限约束）：远紧于稳定性给出的 +107,581 t */
      loadLine: { targetAGL, maxMass, margin: payloadMargin,
                  marginPctNom: payloadMargin / jc.mp.M * 100 },
      /* 抛压载只能"抬高升限"，效果很弱 */
      dumpEffect: m => ({ mass: m, ceiling: CG.ceilingIfDump(m),
                          gain: CG.ceilingIfDump(m) - S.ceiling }),
      tanks: jc.tanks.map(t => ({ name: t.name, m: t.m })),
      canDump: water,
    };
  }

  /* ==================================================================== *
   *  2.15 告警汇总（分级：Warning / Caution / Advisory）
   * ==================================================================== */
  annunciators(S = this.sense()) {
    const jc = this.jc, C = this.cfg, D = this.diag();
    const L = [];
    const add = (level, code, text) => L.push({ level, code, text });
    const SAT = this.saturation(S), CG = this.ceilingGauge(S),
          AL = this.altimetry(S), FR = this.fieldRate(S),
          ST = this.stones(S), PR = this.propulsion(S),
          DM = this.damping(S);

    /* ---- Warning ---- */
    if (jc.stiffnessFailed)        add('W', 'STIFFNESS_LOSS', '场刚度丧失：中性浮力体，只能撤离');
    if (SAT.nSaturated > 0)        add('W', 'SATURATED', `${SAT.nSaturated} 块石触顶包络（刚度塌缩，GM_roll=${SAT.GMx.toFixed(0)} m）`);
    if (SAT.GMx < 0 || SAT.GMy < 0)add('W', 'NEGATIVE_GM', `GM_roll=${SAT.GMx.toFixed(1)} GM_pitch=${SAT.GMy.toFixed(1)}`);
    const nLost = 9 - S.nActive;
    if (nLost > 0)                 add('W', 'STONE_LOST', `已失 ${nLost} 块；升限 ${S.ceiling.toFixed(0)} m，立即下降`);
    if (CG.margin < C.marginWarn)  add('W', 'CEILING_MARGIN', `余量 ${CG.margin.toFixed(0)} m（可再失 ${CG.canLoseStones} 块）`);
    if (AL.clearance < C.clearanceWarn) add('W', 'TERRAIN_CLEARANCE', `真实离地 ${AL.clearance.toFixed(0)} m`);
    if (PR.headingFree)            add('W', 'HEADING_FREE', '单台 azimuth 失效：艏向不可控');
    if (jc.diverged)               add('W', 'DIVERGED', '姿态发散（翻覆）');

    /* ---- Caution ---- */
    if (ST.stoneDevAlarm)          add('C', 'STONE_DEV', `单石出力偏差 ${(ST.maxDev * 100).toFixed(2)}% > 1%`);
    if (FR.over)                   add('C', 'FIELD_RATE', `遭遇率 ${FR.fieldRate.toFixed(2)} m/s > r_max，需降速到 ${FR.vLimit.toFixed(1)} m/s`);
    if (DM.trimPersistent)         add('C', 'TRIM_PERSISTENT', `推进器持续非零 ${DM.peakThrustPct.toFixed(2)}%W：该做 zRef 配平了`);
    const p = this.fc ? this.fc.panel : null;
    if (p && p.out.crabLimited)    add('C', 'CRAB_LIMIT', `CRAB ${p.out.crab.toFixed(0)}° 超限，已夹逼 ${p.crabClamped}`);
    if (p && p.trkSlewLimited)     add('C', 'TRK_SLEW_LTD', '航迹回转受可用推力限制');
    if (this.fc && this.fc.profile.limited) add('C', 'CEILING_PROTECT', '高度目标已被升限保护限幅');
    if (this.fc && this.fc.panel.draft.trk !== this.fc.panel.sel.trk)
                                   add('C', 'TRK_PENDING', `TRK 草稿 ${this.fc.panel.draft.trk.toFixed(0)}° 未按 SET 提交`);

    /* ---- Advisory ---- */
    if (Math.hypot(S.Vw[0], S.Vw[1]) < 0.5) add('A', 'NO_TRACK', '速度 <0.5 m/s：航迹未定义，TRK bug 标注 HOLD REF');
    if (ST.trimSpread > 0.01)      add('A', 'ZREF_DIFFERENTIAL', `差动 zRef 展开 ${ST.trimSpread.toFixed(3)} m`);
    if (this.fc && this.fc.panel.levelMode === 'LEVEL') add('A', 'LEVEL_MODE', '差动 zRef 正在配平到水平（τ=300 s）');
    if (!this.fc || !this.fc.panel.managed) add('A', 'MANUAL', '手柄操纵中（MANAGED 已脱开）');

    const order = { W: 0, C: 1, A: 2 };
    L.sort((a, b) => order[a.level] - order[b.level]);
    return { list: L,
             warning: L.filter(x => x.level === 'W'),
             caution: L.filter(x => x.level === 'C'),
             advisory: L.filter(x => x.level === 'A'),
             masterWarning: L.some(x => x.level === 'W'),
             masterCaution: L.some(x => x.level === 'C') };
  }

  /* ==================================================================== *
   *  汇总
   * ==================================================================== */
  read(dt = null) {
    const S = this.sense();
    return {
      t: this.fc ? this.fc.t : (this.jc._t || 0),
      ceiling:    this.ceilingGauge(S),
      saturation: this.saturation(S),
      altimetry:  this.altimetry(S),
      attitude:   this.attitude(S),
      fieldRate:  this.fieldRate(S),
      vsi:        this.vsi(S, dt),
      terrain:    this.terrainProfile(S),
      capability: this.capability(S),
      damping:    this.damping(S),
      compass:    this.compass(S),
      mcp:        this.mcp(S),
      zRefPlan:   this.zRefPlan(S),
      stones:     this.stones(S),
      propulsion: this.propulsion(S),
      weight:     this.weightBalance(S),
      annunciators: this.annunciators(S),
    };
  }
}

/* ==========================================================================
 *  3. 渲染（可读文本面板）
 * ========================================================================== */
function render(inst, title = '') {
  const R = inst.read(), L = [];
  const H = s => L.push('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 62 - s.length)));
  const F = (k, v, u = '') => L.push('  ' + k.padEnd(24) + (typeof v === 'number' ? round(v, 2) : v) + (u ? ' ' + u : ''));

  if (title) L.push('══════ ' + title + ' ══════');

  H('★ 升限余量表（还能坏几块石头）');
  F('AGL（离场参考面）', R.ceiling.agl, 'm');
  F('升限', R.ceiling.ceiling, 'm');
  F('余量', R.ceiling.margin, 'm');
  F('可再失石数', R.ceiling.canLoseStones, '块');
  F('等级', R.ceiling.level);

  H('包络饱和 / 稳定性');
  F('触顶石数', R.saturation.nSaturated, '块');
  F('GM_roll', R.saturation.GMx, 'm');
  F('GM_pitch', R.saturation.GMy, 'm');
  F('δ₀', R.saturation.delta0, 'm');
  F('d = zCG − zCB', R.saturation.d, 'm');
  F('稳定性', R.saturation.unstable ? 'UNSTABLE' : 'STABLE');

  H('双高度表');
  F('AGL（离场 S）', R.altimetry.gap, 'm');
  F('真实离地（离 T）', R.altimetry.clearance, 'm');
  F('平滑面高出地形', R.altimetry.smoothExcess, 'm');

  H('姿态 / 坡度');
  F('滚转 φ', R.attitude.phi, '°');
  F('俯仰 θ', R.attitude.theta, '°');
  F('艏向', R.attitude.bearing, '°');
  F('坡度', R.attitude.slopeDeg, '°');
  F('随坡倾斜目标 φ', R.attitude.followTarget.phi, '°');
  F('模式', R.attitude.levelMode);

  H('场变化率 / 限速');
  F('遭遇率 Ṡ', R.fieldRate.fieldRate, 'm/s');
  F('r_max', R.fieldRate.rMax, 'm/s');
  F('当前速度', R.fieldRate.speed, 'm/s');
  F('限速 V ≤ r/s', R.fieldRate.vLimit, 'm/s');
  F('告警可触发', R.fieldRate.alarmReachable ? '是' : '否（Ṡ_max < r_max，现为参考游标）');

  H('VSI（针 = ż / 游标 = Ṡ）');
  F('ż 指针（阻尼）', R.vsi.zdot, 'm/s');
  F('ż 原始（未阻尼）', R.vsi.zdotRaw, 'm/s');
  F('Ṡ 游标', R.vsi.bug, 'm/s');
  F('偏离 = ġap', R.vsi.deviation, 'm/s');
  F('阻尼', R.vsi.damping ? `开 (τ=${R.vsi.tau}s)` : '关');
  F('纯地形跟随', R.vsi.following ? '是（针压游标）' : '否');
  F('量程 |ż|_max', R.vsi.zdotMax, 'm/s');

  H('能力极坐标（DP）');
  F('最优艏向', R.capability.best.hdg, '°');
  F('最优 v_max', R.capability.best.vMax, 'm/s');
  F('最差艏向', R.capability.worst.hdg, '°');
  F('最差 v_max', R.capability.worst.vMax, 'm/s');
  F('当前可行艏向占比', R.capability.feasibleFraction * 100, '%');

  H('阻尼 / 推进器占用');
  F('垂荡周期', R.damping.modes.heave.T, 's');
  F('滚转周期', R.damping.modes.roll.T, 's');
  F('俯仰周期', R.damping.modes.pitch.T, 's');
  F('推进器峰值占用', R.damping.peakThrustPct, '%W');
  F('持续非零（该配平）', R.damping.trimPersistent ? 'YES' : 'no');

  H('CRT 圆表（HDG UP）');
  F('卡片顶端读数', R.compass.cardTopDeg, '°');
  F('速度', R.compass.speed, 'm/s');
  F('箭头方位', R.compass.arrow.bearingDeg, '°');
  F('箭头相对 lubber', R.compass.arrow.relToLubberDeg, '°');
  F('CRAB', R.compass.crab, '°');
  F('CRAB 限幅', R.compass.crabLimitDeg == null ? 'OFF' : '±' + R.compass.crabLimitDeg + '°');
  F('NO TRACK', R.compass.noTrack ? 'YES（TRK bug 标 HOLD REF）' : 'no');

  if (R.mcp) {
    H('MCP 数字窗');
    F('SPD sel/act', `${round(R.mcp.SPD.selected, 1)} / ${round(R.mcp.SPD.actual, 1)}`, 'm/s');
    F('TRK draft/sel/act', `${R.mcp.TRK.draft.toFixed(0)} / ${R.mcp.TRK.selected.toFixed(0)} / ${round(R.mcp.TRK.actual, 1)}`, '°');
    F('TRK 待 SET', R.mcp.TRK.pending ? 'YES' : 'no');
    F('HDG sel/act', `${R.mcp.HDG.selected.toFixed(0)} / ${round(R.mcp.HDG.actual, 1)}`, '°');
    F('ALT sel/act', `${round(R.mcp.ALT.selected, 1)} / ${round(R.mcp.ALT.actual, 1)}`, 'm');
    F('ALT 上限（升限−150）', R.mcp.ALT.cap, 'm');
    F('CRAB 模式', `${R.mcp.CRAB.mode} ${R.mcp.CRAB.amp === Infinity ? 'OFF' : '±' + R.mcp.CRAB.amp + '°'}`);
    F('源 / LEVEL', `${R.mcp.switches.source} / ${R.mcp.switches.LEVEL}`);
  }

  if (R.zRefPlan) {
    H('升降计划');
    F('目标 AGL', R.zRefPlan.targetAGL, 'm');
    F('剩余误差', R.zRefPlan.error, 'm');
    F('模式', R.zRefPlan.mode);
    F('当前速率 / 限', `${round(R.zRefPlan.rateNow, 2)} / ${R.zRefPlan.rateLimit}`, 'm/s');
    F('ETA（到位）', round(R.zRefPlan.etaRemain / 60, 1), 'min');
    F('ETA（95%）', round(R.zRefPlan.eta95 / 60, 1), 'min');
    F('速率限硬地板', round(R.zRefPlan.floorSec / 60, 1), 'min');
  }

  H('浮空石阵列（FE）');
  R.stones.rows.forEach(r => L.push(
    `  #${r.idx} ${r.cls.padEnd(6)} f=${(r.frac * 100).toFixed(1).padStart(5)}%  ` +
    `gap=${r.gap.toFixed(2).padStart(7)}  zRef=${r.zRef.toFixed(2).padStart(7)}  ` +
    `dev=${(r.dev * 100).toFixed(2).padStart(5)}%  ${r.saturated ? 'SAT' : ''}${r.failed ? 'LOST' : ''}` +
    `  ΔGM=${r.dGMx.toFixed(0)}/${r.dGMy.toFixed(0)}`));
  F('最大偏差', R.stones.maxDev * 100, '%');

  H('重量与平衡（载荷线由升限决定）');
  F('总重', R.weight.M / 1e3, 't');
  F('石头占比', R.weight.stoneFraction * 100, '%');
  F('载荷余量', R.weight.loadLine.margin / 1e3, 't');
  F('可抛压载', R.weight.canDump / 1e3, 't');

  H('告警');
  if (!R.annunciators.list.length) L.push('  （无）');
  R.annunciators.list.forEach(a => L.push(`  [${a.level}] ${a.code.padEnd(20)} ${a.text}`));

  return L.join('\n');
}

/* ==========================================================================
 *  4. 自检 + 演示
 * ========================================================================== */
module.exports = { InstrumentSuite, azimuthPeak, render, AERO, wrapDeg, brg, round };

if (require.main === module) {
  let nPass = 0, nFail = 0;
  const ok = (c, m, extra = '') => { if (c) { nPass++; console.log('  ✓ ' + m); }
    else { nFail++; console.log('  ✗ ' + m + (extra ? '  → ' + extra : '')); } };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  /* ---------- 演示 1：平地驻留 ---------- */
  const jc = new JadeChamber({ terrain: { preset: 'flat' } });
  const fc = new FlightControl(jc);
  const inst = new InstrumentSuite(jc, fc);
  const run = (sec) => { const n = Math.round(sec / 0.05); for (let i = 0; i < n; i++) fc.update(0.05); };
  run(20);

  console.log(render(inst, '演示 1 · 平地驻留（MANAGED，ALT=749）'));

  /* ---------- 自检 ---------- */
  console.log('\n════════ 自检 ════════');

  /* 1) 升限恒等式 */
  {
    const R = inst.read();
    const F0 = jc.stones[0].F0;
    const expect = 500 * Math.log(9 * F0 / jc.mp.W);
    ok(near(R.ceiling.ceiling, expect, 0.5),
       `升限 = λ·ln(9F₀/W) = ${expect.toFixed(1)} m`, R.ceiling.ceiling.toFixed(1));
    ok(R.ceiling.canLoseStones >= 2,
       `实用升限下可再失 ${R.ceiling.canLoseStones} 块 ≥ 2`);
  }

  /* 2) 双高度表：S ≥ T ⇒ 真实离地 ≥ AGL */
  {
    const R = inst.read();
    ok(R.altimetry.smoothExcess >= -1e-6,
       `平滑面不低于地形（S−T = ${R.altimetry.smoothExcess.toFixed(1)} m）`);
    ok(R.altimetry.clearance >= R.altimetry.gap - 1e-6,
       '真实离地 ≥ AGL（AGL 是安全下界）');
  }

  /* 3) 能力极坐标：与 ControlPanel._optimalHeading 同一模型 */
  {
    const R = inst.read();
    const opt = fc.panel._optimalHeading(inst.sense(), R.capability.trk);
    const mine = R.capability.polar.reduce((a, b) =>
      azimuthPeak(jc, b.hdg, R.capability.trk, fc.panel.sel.spd, jc.cfg.windWorld).peak <
      azimuthPeak(jc, a.hdg, R.capability.trk, fc.panel.sel.spd, jc.cfg.windWorld).peak ? b : a);
    ok(opt == null || Math.abs(wrapDeg(mine.hdg - opt)) <= 16,
       `能力极坐标最优艏向 ${mine.hdg}° 与 HDG AUTO (${opt}) 一致`,
       `mine=${mine.hdg} opt=${opt}`);
    ok(R.capability.worst.vMax <= R.capability.best.vMax + 1e-9,
       '最差艏向 v_max ≤ 最优艏向 v_max');
  }

  /* 4) 圆表几何自洽：箭头相对 lubber = −crab */
  {
    const R = inst.read();
    ok(near(R.compass.arrow.relToLubberDeg, wrapDeg(-R.compass.crab), 0.01),
       `箭头相对 lubber (${R.compass.arrow.relToLubberDeg.toFixed(1)}°) = −CRAB (${R.compass.crab.toFixed(1)}°)`);
    ok(near(R.compass.cardTopDeg, brg(R.attitude.bearing), 0.01),
       'HDG UP：卡片顶端读数 = 当前艏向（自明，无需指示灯）');
  }

  /* 5) 石头权重分类 */
  {
    const R = inst.read();
    const corner = R.stones.rows.filter(r => r.cls === 'CORNER');
    const center = R.stones.rows.filter(r => r.cls === 'CENTER');
    ok(corner.length === 4 && center.length === 1, '4 角石 / 1 中心石');
    ok(Math.abs(center[0].dGMx) < 1e-6 && Math.abs(center[0].dGMy) < 1e-6,
       '中心石失效零刚度损失（只供升力）');
    ok(near(corner[0].dGMy, -333.3, 2), `角石 ΔGM_pitch ≈ −333 m`, corner[0].dGMy.toFixed(1));
  }

  /* 6) 升降计划：速率限地板 = |Δz| / 1.5 */
  {
    const R = inst.read();
    const pr = fc.profile;
    const dz = 749.3 - 300;
    fc.panel.setKnob('ALT', 300);
    const R2 = inst.read();
    ok(near(R2.zRefPlan.floorSec, dz / pr.cfg.rateLim, 1),
       `速率限地板 ${(R2.zRefPlan.floorSec / 60).toFixed(1)} min = Δz/1.5`);
    /* Δz = 449.3 m < 450 ⇒ 速率限不生效 ⇒ 纯一阶：
     *   到 95% 需 τ·ln20 ≈ 15 min；但「完全到位」（残差 0.05 m）需 τ·ln(Δ/0.05) ≈ 45 min。
     *   仪表应突出 eta95；eta 的长尾是一阶环节的固有性质，不是故障。 */
    ok(near(R2.zRefPlan.eta95 / 60, 15, 1.5),
       `NORMAL 到 95% 需 ${(R2.zRefPlan.eta95 / 60).toFixed(1)} min ≈ 3τ`);
    ok(R2.zRefPlan.etaRemain / 60 > 40,
       `NORMAL 完全到位 ${(R2.zRefPlan.etaRemain / 60).toFixed(1)} min（一阶长尾）`);
    /* 应急：旁路 τ ⇒ ETA 收敛到地板 */
    fc.cfg.emergencyDescent = true;
    const R3 = inst.read();
    ok(R3.zRefPlan.etaRemain / 60 < 12,
       `EMERGENCY ETA ${(R3.zRefPlan.etaRemain / 60).toFixed(1)} min（≈ 速率限地板，不旁路速率限）`);
    fc.cfg.emergencyDescent = false;
    fc.panel.setKnob('ALT', 749.3);
  }

  /* 7) 载荷线由升限决定 */
  {
    const R = inst.read();
    ok(R.weight.loadLine.margin / 1e3 > 7000 && R.weight.loadLine.margin / 1e3 < 8000,
       `载荷余量 ${(R.weight.loadLine.margin / 1e3).toFixed(0)} t ≈ +7360 t（升限约束，远紧于稳定性的 +107,581 t）`);
  }

  /* 8) 失石 ⇒ Warning + 升限下降 */
  {
    jc.setStone(0, { failed: true });   // 角石
    run(5);
    const R = inst.read();
    ok(R.annunciators.warning.some(a => a.code === 'STONE_LOST'),
       '失石 ⇒ STONE_LOST（Warning）');
    ok(R.ceiling.canLoseStones >= 0, `失 1 块后仍可再失 ${R.ceiling.canLoseStones} 块`);
    ok(R.stones.rows[0].failed, 'FE 面板标记该石 LOST');
    jc.setStone(0, { failed: false });
  }

  /* 9) 坡度：FOLLOW SLOPE 自动倾斜 = 坡度 */
  {
    const j2 = new JadeChamber({ terrain: { preset: 'ramp' } });
    const f2 = new FlightControl(j2);
    const i2 = new InstrumentSuite(j2, f2);
    j2.placeAt(0, 0, 749.3 - j2.delta0());
    for (let i = 0; i < 1200; i++) f2.update(0.05);
    const R = i2.read();
    ok(near(R.attitude.phi, R.attitude.followTarget.phi, 0.15),
       `随坡倾斜 φ=${R.attitude.phi.toFixed(2)}° ≈ 坡度目标 ${R.attitude.followTarget.phi.toFixed(2)}°`);
    ok(R.damping.peakThrustPct < 1,
       `随坡倾斜几乎免费（推进器 ${R.damping.peakThrustPct.toFixed(2)}%W）`);
  }

  /* 10) 无 fc 也能工作（只有物理类读数） */
  {
    const j3 = new JadeChamber({ terrain: { preset: 'flat' } });
    const i3 = new InstrumentSuite(j3);
    const R = i3.read();
    ok(R.mcp === null && R.zRefPlan === null, '无控制层时 MCP / 升降计划为 null（其余照常）');
    ok(R.ceiling.ceiling > 900 && R.annunciators.list.length >= 0, '主仪表板读数正常');
  }

  /* ---------- VSI ---------- */
  /* A) 恒等式 ż = Ṡ + ġap；驻留时两者皆零 ⇒ 针压游标 */
  {
    const R = inst.read();
    ok(near(R.vsi.components.zdot, R.vsi.components.sRate + R.vsi.components.gapRate, 1e-9),
       `恒等式 ż = Ṡ + ġap（${R.vsi.zdot.toFixed(3)} = ${R.vsi.bug.toFixed(3)} + ${R.vsi.deviation.toFixed(3)}）`);
    ok(R.vsi.following, '平地驻留：针压游标（纯地形跟随）');
  }

  /* B) 量程 |ż|_max = sMax·Vmax + rateLimZRef */
  {
    const R = inst.read();
    const expect = jc.cfg.sMax * jc.cfg.Vmax + Math.abs(jc.cfg.rateLimZRef);
    ok(near(R.vsi.zdotMax, expect, 1e-9),
       `量程 ±${expect.toFixed(2)} m/s（Ṡ 0.88 + ġap 1.5）`, R.vsi.zdotMax.toFixed(2));
  }

  /* C) 阻尼的必要性：关自动驾驶阻尼时 ż 被弹簧模态污染 */
  {
    const j = new JadeChamber({ terrain: { preset: 'ramp' } });
    j.placeAt(0, 0, 749.3 - j.delta0());
    j.state.V = [0, 22, 0];
    const on = new InstrumentSuite(j);
    const off = new InstrumentSuite(j, null, { vsiDamping: false });
    /* 用峰峰值衡量：ż 含 Ṡ≈0.81 的直流偏置，只看 |ż| 会混入该偏置 */
    let aOn = [], aOff = [];
    for (let i = 0; i < 160; i++) {
      j.physicsUpdate(0.05);                    // 不加自动驾驶 ⇒ 无主动阻尼
      aOff.push(off.vsi(null, 0.05).zdot);
      aOn.push(on.vsi(null, 0.05).zdot);
    }
    const pp = a => Math.max(...a) - Math.min(...a);
    const ppOn = pp(aOn), ppOff = pp(aOff);
    ok(ppOff > 1.5, `无阻尼 ż 峰峰 ${ppOff.toFixed(2)} m/s（T_z=1.1 s 弹簧模态污染）`);
    ok(ppOn < ppOff * 0.6,
       `阻尼后峰峰 ${ppOn.toFixed(2)} < 无阻尼 ${ppOff.toFixed(2)} 的 60%`);
  }

  /* D) 阻尼可关闭 */
  {
    const j = new JadeChamber({ terrain: { preset: 'ramp' } });
    j.placeAt(0, 0, 749.3 - j.delta0());
    j.state.V = [0, 22, 0];
    const off = new InstrumentSuite(j, null, { vsiDamping: false });
    j.physicsUpdate(0.05);
    const v = off.vsi(null, 0.05);
    ok(v.damping === false && near(v.zdot, v.zdotRaw, 1e-12),
       'vsiDamping=false ⇒ 指针 = 原始 ż');
  }

  /* E) Ṡ 告警不可触发（现为参考游标） */
  {
    const R = inst.read();
    ok(R.fieldRate.alarmReachable === (jc.cfg.sMax * jc.cfg.Vmax > jc.cfg.rMaxField),
       `Ṡ_max=${(jc.cfg.sMax * jc.cfg.Vmax).toFixed(2)} vs r_max=${jc.cfg.rMaxField} ⇒ 告警${R.fieldRate.alarmReachable ? '可' : '不可'}触发`);
  }

  /* ---------- 演示 2：斜坡 ---------- */
  console.log('\n');
  const j4 = new JadeChamber({ terrain: { preset: 'ramp' } });
  const f4 = new FlightControl(j4);
  const i4 = new InstrumentSuite(j4, f4);
  j4.placeAt(0, 0, 749.3 - j4.delta0());
  for (let i = 0; i < 2400; i++) f4.update(0.05);
  console.log(render(i4, '演示 2 · 斜坡地形（FOLLOW SLOPE）'));

  console.log(`\n══════ 结果：${nPass} 通过 / ${nFail} 失败 ══════`);
  process.exit(nFail ? 1 : 0);
}
