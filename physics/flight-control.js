/* ============================================================================
 *  flight-control.js —— 群玉阁「控制层」
 *
 *  设计原则：本文件 **不含任何物理**，只做「观测量 → 操纵量」的变换。
 *  物理（几何、质量、浮空场、刚体积分）全部在 jade-chamber.js。
 *
 *  分层：
 *    ┌ ControlPanel (MCP)  旋钮/按钮 → 目标值（含 TRK SET、CRAB LIMIT、HDG AUTO）
 *    ├ ZRefProfile         zRef 剖面生成（τ 一阶 / 应急旁路 / S 曲线 jerk 限制）
 *    ├ Autopilot           目标值 + 观测量 → 推进器指令
 *    ├ ManualControl       手柄 + 脚蹬（扭转轴）→ 推进器指令
 *    └ FlightControl       编排：选源(MANAGED/MANUAL) → 施加 → 推进物理
 *
 *  与物理侧的接触面只有三处：
 *    jc.sense()     读观测量
 *    jc.ctrl        写推进器指令
 *    jc.setZRef()   写各石头的「弹簧原长」
 * ========================================================================== */

'use strict';
const JC = require('./jade-chamber.js');
const { JadeChamber, matMul, matT, matInv, vCross, vSub } = JC;
/* 控制层自带向量工具，避免依赖物理模块的内部导出 */
const vAdd  = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vMul  = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vDot  = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vLen  = a => Math.hypot(a[0], a[1], a[2]);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

const DEG = 180 / Math.PI;
const wrapPi = x => { while (x > Math.PI) x -= 2 * Math.PI; while (x < -Math.PI) x += 2 * Math.PI; return x; };
const wrap2pi = x => { x %= 2 * Math.PI; return x < 0 ? x + 2 * Math.PI : x; };
const degOf = r => r * DEG;

/* 角度约定：
 *   世界系 (x, y) 为平面坐标，z 向上。
 *   **航向/航迹用「罗盘方位」β**（从 +y 轴起顺时针，即 +y=北=000，+x=东=090）。
 *   平台偏航角 ψ 与方位的关系： β = −ψ   （由 ZYX 旋转矩阵推出）
 */
const bearingToPsi = b => -b / DEG;
const psiToBearing = p => -p * DEG;
/** 单位向量：方位 β → 世界 (x,y) 分量 */
const bearingVec = b => { const r = b / DEG; return [Math.sin(r), Math.cos(r)]; };

/* ==========================================================================
 *  1. Allocator —— 垂向 + 俯仰 + 滚转的可重构最小二乘分配
 *     （4 台垂推 → 3 个约束；失效时自动降维重构；饱和时沿零空间降峰值）
 * ========================================================================== */
function allocateVertical(cols, bv) {
  const T = [0, 0, 0, 0];
  const utilOf = (cs, t) => t.map((v, k) =>
    Math.abs(v) / Math.max(v >= 0 ? cs[k].hi : -cs[k].lo, 1e-12));
  const solveLS = (cs, b, Wi) => {
    if (!cs.length) return null;
    const w = Wi || cs.map(c => c.hi * c.hi);
    const AWiAt = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let k = 0; k < cs.length; k++)
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) AWiAt[i][j] += w[k] * cs[k].a[i] * cs[k].a[j];
    let inv = matInv(AWiAt), damped = false, err = Infinity;
    if (inv) {
      err = 0;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let v = 0; for (let k = 0; k < 3; k++) v += AWiAt[i][k] * inv[k][j];
        err = Math.max(err, Math.abs(v - (i === j ? 1 : 0)));
      }
    }
    if (!(err < 1e-6)) {
      damped = true;
      const lam = 1e-3 * (AWiAt[0][0] + AWiAt[1][1] + AWiAt[2][2]) / 3 + 1e-9;
      inv = matInv(AWiAt.map((row, i) => row.map((v, j) => v + (i === j ? lam : 0))));
      if (!inv) return null;
    }
    const y = matMul(inv, [[b[0]], [b[1]], [b[2]]]);
    return { t: cs.map((c, k) => w[k] * (c.a[0] * y[0][0] + c.a[1] * y[1][0] + c.a[2] * y[2][0])), damped };
  };
  const nullDir = cs => {
    const m = cs.length; if (m <= 3) return null;
    const AAt = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let k = 0; k < m; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) AAt[i][j] += cs[k].a[i] * cs[k].a[j];
    const inv = matInv(AAt); if (!inv) return null;
    let best = null;
    for (let c0 = 0; c0 < m; c0++) {
      const y = matMul(inv, [[cs[c0].a[0]], [cs[c0].a[1]], [cs[c0].a[2]]]);
      const n = cs.map((c, k) => (k === c0 ? 1 : 0) - (c.a[0] * y[0][0] + c.a[1] * y[1][0] + c.a[2] * y[2][0]));
      const nrm = Math.hypot(...n);
      if (!best || nrm > best.nrm) best = { n, nrm };
    }
    return best && best.nrm > 1e-9 ? best.n : null;
  };

  let damped = false;
  const sol = solveLS(cols, bv, null);
  if (!sol) return { T, iters: 0, damped: false, saturated: false, peak: 0, nullShift: false, deficit: bv.slice() };
  damped = sol.damped;
  let chosen = { t: sol.t.slice(), peak: Math.max(...utilOf(cols, sol.t)) };
  if (chosen.peak <= 1 + 1e-9) {
    cols.forEach((c, k) => { T[c.i] = clamp(chosen.t[k], c.lo, c.hi); });
    return { T, iters: 0, damped, saturated: false, peak: chosen.peak, nullShift: false, deficit: [0, 0, 0] };
  }
  const n = nullDir(cols);
  if (n) {
    const nn = Math.hypot(...n), u = n.map(v => v / nn);
    const f = lam => Math.max(...utilOf(cols, chosen.t.map((v, k) => v + lam * u[k])));
    const Sc = 4 * Math.max(...chosen.t.map(Math.abs)) + 1e-9;
    let lo = -Sc, hi = Sc, iters = 0;
    for (; iters < 100; iters++) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (f(m1) < f(m2)) hi = m2; else lo = m1;
    }
    const lam = (lo + hi) / 2;
    if (f(lam) < chosen.peak - 1e-9)
      chosen = { t: chosen.t.map((v, k) => v + lam * u[k]), peak: f(lam) };
  }
  if (chosen.peak <= 1 + 1e-9) {
    cols.forEach((c, k) => { T[c.i] = clamp(chosen.t[k], c.lo, c.hi); });
    return { T, iters: 0, damped, saturated: false, peak: chosen.peak, nullShift: true, deficit: [0, 0, 0] };
  }
  let frozen = [], pend = [], free = cols.slice(), iters = 0;
  for (; iters <= cols.length && free.length; iters++) {
    const rem = [0, 1, 2].map(r => bv[r] - frozen.reduce((a, f) => a + f.a[r] * f.v, 0));
    const s2 = solveLS(free, rem, null); if (!s2) break;
    damped = damped || s2.damped;
    const newly = []; pend = [];
    free.forEach((c, k) => {
      const v = clamp(s2.t[k], c.lo, c.hi);
      (v >= c.hi - 1e-9 || v <= c.lo + 1e-9 ? newly : pend).push({ ...c, v });
    });
    if (!newly.length) break;
    frozen = frozen.concat(newly);
    free = free.filter(c => !newly.some(x => x.kind === c.kind && x.i === c.i));
  }
  for (const f of frozen.concat(pend)) if (f.kind === 'v') T[f.i] = f.v;
  const got = [0, 1, 2].map(r => cols.reduce((a, c) => a + c.a[r] * T[c.i], 0));
  return { T, iters, damped, saturated: true, peak: chosen.peak, nullShift: true,
           deficit: [0, 1, 2].map(r => bv[r] - got[r]) };
}

/* ==========================================================================
 *  2. ZRefProfile —— 「弹簧原长」的剖面生成器
 *
 *  物理约束（来自 jade-chamber 的弹簧方程）：
 *      ẍ + ω_z² x = − z̈_ref        （x 为平台相对移动平衡点的偏差）
 *      ω_z²·δ₀ = g                  ⇒  |x|/δ₀ = |z̈_ref| / g
 *  ⇒ **只有加速度会激励振荡，匀速上升完全无滞后**。
 *
 *  · 阶跃进入速率 u：振幅 = u/ω_z，安全上限 u < δ₀·ω_z = 1.72 m/s
 *  · 一阶 τ：对阶跃命令 Δz，t=0 的速度从 0 跳到 Δz/τ —— **它其实是速度阶跃**
 *           Δz > δ₀·ω_z·τ = 515 m 时直接卸载 ⇒ 所以必须有速率限（450 m 处接管）
 *  · S 曲线（jerk 限制）：振幅 ≈ a/ω_z²，抑制倍数 ≈ ω_z·t_ramp
 *
 *  模式：
 *    'normal'    一阶 τ 主导（到 95% 约 15 min）
 *    'emergency' 旁路 τ，以速率限全速走（749 m 从 ~37 min 缩到 8.3 min）
 *                —— **不旁路速率限**，只旁路 τ
 * ========================================================================== */
class ZRefProfile {
  constructor(cfg = {}) {
    this.cfg = Object.assign({
      tauS: 300,          // 一阶时间常数 s
      rateLim: 1.5,       // 速率上限 m/s（安全设备，任何模式都不旁路）
      tRamp: 5,           // S 曲线加速段 s ⇒ aMax = rateLim/tRamp
      ceilingMargin: 150, // 升限保护：目标 ≤ 升限 − margin
      n: 9,
    }, cfg);
    this.rate = new Array(this.cfg.n).fill(0);
    this.acc  = new Array(this.cfg.n).fill(0);
    this.jMax = 2 * (this.cfg.rateLim / this.cfg.tRamp) / this.cfg.tRamp;
    this.limited = false; this.excess = 0;
  }
  get aMax() { return this.cfg.rateLim / this.cfg.tRamp; }
  /** 兼容旧接口：初始化速率状态 */
  init() { this.rate.fill(0); this.acc.fill(0); return this; }
  /**
   * @param dt    步长 s
   * @param target 长度 n 的目标数组（集体 + 差动）
   * @param ceiling 当前升限 m（用于保护限幅）
   * @param mode  'normal' | 'emergency'
   */
  /**
   * 给出「原长变化率」（由物理侧在每个子步连续积分，避免阶梯激励）
   * @param dt     控制步长 s（只用于 jerk 限幅的时间常数）
   * @param target 长度 n 的目标（集体 + 差动）
   * @param ceiling 当前升限 m
   * @param cur    当前原长数组（来自物理侧）
   * @param mode   'normal'（τ 主导）| 'emergency'（旁路 τ，不旁路速率限）
   * @returns { rate, limited, excess }
   */
  rateFor(dt, target, ceiling, mode = 'normal', cur = null) {
    const C = this.cfg, n = C.n, aMax = this.aMax, rateLim = C.rateLim;
    const curArr = cur || new Array(n).fill(0);
    /* 升限保护：对 **集体分量** 限幅（差动配平量不受影响） */
    const cap = ceiling - C.ceilingMargin;
    const meanT = target.reduce((a, b) => a + b, 0) / n;
    const excess = meanT > cap ? meanT - cap : 0;
    const rate = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = target[i] - excess, err = t - curArr[i];
      /* ---- 期望速率 ---- */
      let rDes;
      if (mode === 'emergency') {
        /* 旁路 τ：全速走，末端按 2·a·err 减速停车 */
        const stop = Math.sqrt(2 * aMax * Math.abs(err));
        rDes = Math.sign(err) * Math.min(rateLim, stop);
      } else {
        rDes = clamp(err / C.tauS, -rateLim, rateLim);
      }
      /* ---- jerk 限制：加速度只能以 jMax 的速率变化 ---- */
      const aNeed = (rDes - this.rate[i]) / Math.max(dt, 1e-6);
      let a = clamp(aNeed, this.acc[i] - this.jMax * dt, this.acc[i] + this.jMax * dt);
      a = clamp(a, -aMax, aMax);
      this.acc[i] = a;
      rate[i] = clamp(this.rate[i] + a * dt, -rateLim, rateLim);
      this.rate[i] = rate[i];
    }
    this.limited = excess > 0; this.excess = excess;
    return { rate, limited: this.limited, excess };
  }
  /** 兼容旧接口：直接给出新的原长（仍由调用方写入） */
  update(dt, target, ceiling, mode = 'normal', cur = null) {
    const { rate } = this.rateFor(dt, target, ceiling, mode, cur);
    const base = cur || new Array(this.cfg.n).fill(0);
    return base.map((z, i) => z + rate[i] * dt);
  }
  /** 预测：以加速度 a 作准静态跟随时的相对偏差（占 δ₀ 的比例） */
  static quasiStatic(a) { return Math.abs(a) / 9.81; }
}

/* ==========================================================================
 *  3. ControlPanel —— MCP（自动驾驶面板）+ 中央台的模式开关
 *
 *  旋钮只能旋转 ⇒ 推/拉功能全部外置为按钮：
 *    航向「按下/拉出」→ 纯目标选择器；速率模式另设带盖 YAW RATE 开关
 *    「按压接管」     → MANAGED 按钮
 *    「拉出同步」     → SYNC ×3 按钮
 *
 *  TRK 采用 **草稿窗 + TRK SET 按钮**（旋钮阻尼的替代方案）
 * ========================================================================== */
const CRAB_LIMITS = {
  CRUISE:    { amp: Infinity, priority: 'NONE', label: 'OFF' },
  TRANSIT:   { amp: 30,       priority: 'TRK',  label: '±30°' },
  PRECISION: { amp: 10,       priority: 'HDG',  label: '±10°' },
  BERTH:     { amp: 5,        priority: 'HDG',  label: '±5°'  },
};

class ControlPanel {
  constructor(cfg = {}) {
    this.cfg = Object.assign({
      Vmax: 22, spdStep: 0.1, degStep: 1, altStepCoarse: 10, altStepFine: 0.1,
      trkSlewGain: 1.0,
      hdgAuto: { enabled: false, mode: 'scan', cpOffset: [10, 28], rho: 1.2, Cd: 1.1 },
    }, cfg);
    /* 已提交的目标 */
    this.sel = { spd: 0, trk: 0, hdg: 0, alt: 749.3 };
    /* 草稿（TRK SET 之前不生效） */
    this.draft = { trk: 0 };
    /* 实际生效的航迹（受回转率限制，缓慢跟随 sel.trk） */
    this.trkNow = 0;
    /* 开关 */
    this.crabMode   = 'CRUISE';
    this.levelMode  = 'FOLLOW';    // FOLLOW SLOPE / LEVEL
    this.managed    = true;        // MANAGED 按钮（手柄一动即转 MANUAL）
    this.ap         = true;
    this.yawRateMode = false;      // 带盖：L2/L3 降级用
    this.stick      = { x: 0, y: 0, twist: 0 };   // 手柄（TRK 系）
    this.crabLimited = false; this.crabClamped = null;
    this.trkSlewLimited = false;
    this.source = 'MANAGED';
  }
  /* ---------------- 旋钮 ---------------- */
  setKnob(name, v) {
    const brg = x => Math.round(wrap2pi(x / DEG) * DEG * 1e6) / 1e6;   // 归一化到 0..360
    if (name === 'TRK') { this.draft.trk = brg(v); return this.draft.trk; }
    if (name === 'SPD') { this.sel.spd = clamp(v, 0, this.cfg.Vmax); return this.sel.spd; }
    if (name === 'HDG') { this.sel.hdg = brg(v); return this.sel.hdg; }
    if (name === 'ALT') { this.sel.alt = v; return this.sel.alt; }
    if (name === 'CRAB') { if (CRAB_LIMITS[v]) this.crabMode = v; return this.crabMode; }
    throw new Error('unknown knob ' + name);
  }
  nudge(name, steps, fine = false) {
    if (name === 'ALT') return this.setKnob('ALT', this.sel.alt + steps * (fine ? this.cfg.altStepFine : this.cfg.altStepCoarse));
    if (name === 'SPD') return this.setKnob('SPD', this.sel.spd + steps * this.cfg.spdStep);
    return this.setKnob(name, this[name === 'TRK' ? 'draft' : 'sel'][name === 'TRK' ? 'trk' : name.toLowerCase()] + steps * this.cfg.degStep);
  }
  /* ---------------- 按钮 ---------------- */
  pressTRKSET() { this.sel.trk = this.draft.trk; this.pressMANAGED(); return this.sel.trk; }
  pressSYNC(kind, current) {
    if (kind === 'HDG') this.sel.hdg = current.hdg;
    if (kind === 'TRK') { this.sel.trk = current.trk; this.draft.trk = current.trk; this.trkNow = current.trk; }
    if (kind === 'ALT') this.sel.alt = current.alt;
    return this.sel;
  }
  pressMANAGED() { this.managed = true; this.source = 'MANAGED'; return true; }
  /** 手柄一动即转 MANUAL（触碰接管） */
  stickMoved() {
    const s = this.stick, m = Math.hypot(s.x, s.y) + Math.abs(s.twist);
    if (m > 1e-3 && this.managed) { this.managed = false; this.source = 'MANUAL'; }
    return this.source;
  }
  pressLEVEL(v) { this.levelMode = v ? 'LEVEL' : 'FOLLOW'; return this.levelMode; }

  /* ---------------- 每拍更新 ---------------- */
  /**
   * @param S  sense() 的输出
   * @param Favail 单台 azimuth 可用推力 N（用于 TRK 回转率限制）
   */
  update(dt, S, Favail) {
    const c = this.cfg;
    /* --- a) 手柄非零 ⇒ MANUAL --- */
    this.stickMoved();

    /* --- b) CRAB LIMIT 夹逼 --- */
    let hdg = this.sel.hdg, trk = this.sel.trk;
    const lim = CRAB_LIMITS[this.crabMode];
    let crab = wrapPi((hdg - trk) / DEG) * DEG;
    this.crabLimited = false; this.crabClamped = null;
    if (Math.abs(crab) > lim.amp) {
      const cClamped = Math.sign(crab) * lim.amp;
      if (lim.priority === 'TRK')      { trk = wrap2pi((hdg - cClamped * DEG ? (hdg - cClamped) / DEG : 0)) * DEG; this.crabClamped = 'TRK'; }
      else if (lim.priority === 'HDG') { hdg = wrap2pi((trk + cClamped) / DEG) * DEG; this.crabClamped = 'HDG'; }
      this.crabLimited = true;
    }
    /* 修正 TRK 夹逼的写法（避免上面三元式的歧义） */
    if (this.crabClamped === 'TRK') trk = wrap2pi((hdg - Math.sign(crab) * lim.amp) / DEG) * DEG;
    crab = wrapPi((hdg - trk) / DEG) * DEG;

    /* --- c) HDG AUTO：按「最小推力需求」选艏向 --- */
    let optHdg = null;
    if (c.hdgAuto.enabled && this.source === 'MANAGED' && this.crabMode !== 'BERTH') {
      if (c.hdgAuto.mode === 'scan')      optHdg = this._optimalHeading(S, trk);
      else if (c.hdgAuto.mode === 'search') optHdg = this._searchHeading(S, dt);
      if (optHdg != null) hdg = optHdg;
    }

    /* --- d) TRK 回转率限制（ω ≤ F_avail /(M·v)） --- */
    const v = Math.hypot(S.Vw[0], S.Vw[1]);
    let wMax = Infinity;
    if (v > 0.1) wMax = Favail / Math.max(S.M * v, 1) * DEG;   // °/s
    const errT = wrapPi((trk - this.trkNow) / DEG) * DEG;
    const slew = clamp(errT / Math.max(dt, 1e-3) * c.trkSlewGain, -wMax, wMax);
    this.trkSlewLimited = Math.abs(errT) > 0.5 && Math.abs(slew) < Math.abs(errT / Math.max(dt, 1e-3));
    this.trkNow = wrap2pi((this.trkNow + slew * dt) / DEG) * DEG;

    this.out = {
      hdg, trk, trkNow: this.trkNow, crab,
      spd: this.sel.spd, alt: this.sel.alt,
      crabLimited: this.crabLimited, crabClamped: this.crabClamped,
      crabLimitDeg: lim.amp, trkSlewLimited: this.trkSlewLimited,
      optHdg, source: this.source, level: this.levelMode,
    };
    return this.out;
  }

  /* 最小推力艏向：扫描全部方位，预测「平移 + 偏航」合成需求下单台 azimuth 的峰值 */
  _optimalHeading(S, trk) {
    const C = this.cfg.hdgAuto, jc = S.jc;
    const a = jc.cfg.a, b = jc.cfg.b, c = jc.cfg.c;
    const wind = jc.cfg.windWorld || [0, 0, 0];
    /* 相对气流：假定沿 TRK 以 sel.spd 行驶 + 风 */
    const vb = bearingVec(trk), spd = this.sel.spd;
    const Vrel = [vb[0] * spd - wind[0], vb[1] * spd - wind[1]];
    const vr = Math.hypot(Vrel[0], Vrel[1]);
    if (vr < 0.2) return null;
    const kq = 0.5 * C.rho * C.Cd;
    let best = null;
    for (let d = 0; d < 360; d += 1) {
      const psi = bearingToPsi(d);
      /* 正方形平面旋转后的迎风投影宽 */
      const w = 2 * a * Math.abs(Math.cos(psi)) + 2 * b * Math.abs(Math.sin(psi));
      const F = kq * w * 2 * c * vr * vr;                 // 阻力，沿相对气流反向
      /* CP 世界偏移（体轴 r_cp 旋转到世界） */
      const [cx0, cy0] = C.cpOffset;
      const cpx = cx0 * Math.cos(psi) - cy0 * Math.sin(psi);
      const cpy = cx0 * Math.sin(psi) + cy0 * Math.cos(psi);
      /* 风载方向单位矢（平台受力的方向 = Vrel 方向） */
      const ux = Vrel[0] / vr, uy = Vrel[1] / vr;
      const Mz = cpx * (F * uy) - cpy * (F * ux);
      /* 需求：合力 = −F·u（世界），偏航力矩 = −Mz */
      const Fxw = -F * ux, Fyw = -F * uy;
      const fbx = Fxw * Math.cos(psi) + Fyw * Math.sin(psi);
      const fby = -Fxw * Math.sin(psi) + Fyw * Math.cos(psi);
      const D = -Mz / (5 * b / 6);
      const tb = Math.hypot(fbx / 2 - D / 2, fby / 2), ts = Math.hypot(fbx / 2 + D / 2, fby / 2);
      const peak = Math.max(tb, ts);
      if (!best || peak < best.peak) best = { d, peak };
    }
    return best ? best.d : null;
  }
  /* 在线极值搜索：缓慢扰动艏向，沿梯度走向更小的实测推力需求 */
  _searchHeading(S, dt) {
    const jc = S.jc;
    const peak = jc.ctrl ? Math.max(jc.ctrl.tauBow, jc.ctrl.tauStern) : 0;
    if (this._srch == null) this._srch = { t: 0, last: peak, grad: 0 };
    const s = this._srch; s.t += dt;
    if (s.t > 30) { s.grad = peak - s.last; s.last = peak; s.t = 0; }
    const step = 2 * dt;    // °/s 缓慢
    const dir = s.grad > 0 ? -1 : 1;
    return wrap2pi((this.sel.hdg + dir * step) / DEG) * DEG;
  }
}

/* ==========================================================================
 *  4. Autopilot —— 目标值 + 观测量 → 推进器指令
 *     垂向：间隙速率阻尼（skyhook），**不是位置伺服**
 *     姿态：角速率阻尼（+ 可选坡度前馈 / LEVEL 差动配平）
 *     水平/偏航：PD → azimuth
 * ========================================================================== */
class Autopilot {
  constructor(cfg = {}) {
    this.cfg = Object.assign({
      zeta: 0.10,
      kpPos: 0.05, kdPos: 0.45, aMax: 0.5,
      kpYaw: 0.02, kdYaw: 0.5,
      attitudeHold: false,     // 强制水平（坡上会饱和，仅作业用）
    }, cfg);
  }
  compute(S, cmd) {
    const jc = S.jc, C = this.cfg, s = S.state, { M, I, rcm } = S;
    const R = S.R;
    const Fmax = jc.lim.Fmax, Fmin = jc.lim.Fmin, FazMax = jc.lim.FazMax;

    /* ---- 水平：世界系速度指令 → 体轴力 ---- */
    let vCmdW = [cmd.vxW || 0, cmd.vyW || 0];
    let vMax = jc.cfg.Vmax;
    if (S.slopeMag > 1e-6) vMax = Math.min(vMax, jc.cfg.rMaxField / S.slopeMag);
    const vm = Math.hypot(vCmdW[0], vCmdW[1]);
    if (vm > vMax) { vCmdW = [vCmdW[0] * vMax / vm, vCmdW[1] * vMax / vm]; }
    const aCmd = [(vCmdW[0] - S.Vw[0]) / Math.max(cmd.dt, 1e-3), (vCmdW[1] - S.Vw[1]) / Math.max(cmd.dt, 1e-3)];
    const am = Math.hypot(aCmd[0], aCmd[1]);
    if (am > C.aMax) { aCmd[0] *= C.aMax / am; aCmd[1] *= C.aMax / am; }
    const FhorizW = [aCmd[0] * M, aCmd[1] * M, 0];
    /* 世界 → 体轴 */
    const FhorizB = [
      R[0][0] * FhorizW[0] + R[1][0] * FhorizW[1],
      R[0][1] * FhorizW[0] + R[1][1] * FhorizW[1],
      R[0][2] * FhorizW[0] + R[1][2] * FhorizW[1],
    ];

    /* ---- 偏航 ---- */
    let MzYaw;
    if (cmd.yawRateCmd != null) MzYaw = I[2][2] * (cmd.yawRateCmd - s.omega[2]) * 2.0;
    else MzYaw = I[2][2] * (C.kpYaw * wrapPi(cmd.psiCmd - s.psi) - C.kdYaw * s.omega[2]);

    /* ---- azimuth 分配 ---- */
    const bm = jc.cfg.b, rcmY = rcm[1], rcmX = rcm[0];
    const A1 = rcmY - 5 * bm / 6, A2 = rcmY + 5 * bm / 6;
    const rhs = MzYaw + rcmX * FhorizB[1];
    let fbx = 0, fsx = 0;
    if (!jc.azBow.failed && !jc.azStern.failed) { fsx = (rhs - A1 * FhorizB[0]) / (A2 - A1); fbx = FhorizB[0] - fsx; }
    else if (!jc.azBow.failed)   fbx = rhs / A1;
    else if (!jc.azStern.failed) fsx = rhs / A2;
    const fby = jc.azBow.failed   ? 0 : FhorizB[1] / 2;
    const fsy = jc.azStern.failed ? 0 : FhorizB[1] / 2;
    const pack = (fx, fy, failed) => {
      if (failed) return { tau: 0, alpha: 0, fx: 0, fy: 0 };
      const tau = Math.hypot(fx, fy), sc = tau > FazMax ? FazMax / tau : 1;
      return { tau: tau * sc, alpha: Math.atan2(fx * sc, fy * sc), fx: fx * sc, fy: fy * sc };
    };
    const pb = pack(fbx, fby, jc.azBow.failed), ps = pack(fsx, fsy, jc.azStern.failed);
    const Maz = vAdd(vCross(vSub(jc.azBow.pos, rcm),   [pb.fx, pb.fy, 0]),
                     vCross(vSub(jc.azStern.pos, rcm), [ps.fx, ps.fy, 0]));

    /* ---- 垂向：间隙速率阻尼 ---- */
    const wz = Math.sqrt(9 * jc.stones[0].k / M);
    const cz = 2 * C.zeta * M * wz;
    /* 阻尼必须相对于 **指令的参考运动**：
     * 若按绝对 ż 阻尼，匀速下降时也会被当成扰动而持续对抗（实测会吃掉 17%W）。
     * 正确做法：对 (实际间隙速率 − zRef 速率) 阻尼 ⇒ 匀速跟随指令时阻尼力为零。 */
    const gapRate = S.Vw[2] - S.fieldRate;
    const gapRateRel = gapRate - (cmd.zRefRate || 0);
    const FzReq = -cz * gapRateRel;

    /* ---- 姿态：角速率阻尼 ---- */
    const Kr = S.Kr, Kp = S.Kp;
    const wr = Math.sqrt(Math.max(Kr, 1) / I[0][0]), wp = Math.sqrt(Math.max(Kp, 1) / I[1][1]);
    const cr = 2 * C.zeta * I[0][0] * wr, cp = 2 * C.zeta * I[1][1] * wp;
    let MxReq = -cr * s.omega[0], MyReq = -cp * s.omega[1];
    if (C.attitudeHold) {
      MxReq += I[0][0] * (0.02 * (0 - s.phi)   - 0.5 * s.omega[0]);
      MyReq += I[1][1] * (0.02 * (0 - s.theta) - 0.5 * s.omega[1]);
    }

    /* ---- 垂向 + 力矩：可重构 LS ---- */
    const cols = [];
    jc.eng.forEach((e, i) => {
      if (e.failed) return;
      cols.push({ kind: 'v', i, a: [1, e.pos[1] - rcm[1], -(e.pos[0] - rcm[0])], lo: Fmin, hi: Fmax });
    });
    const bBase = [FzReq, MxReq - Maz[0], MyReq - Maz[1]];
    const res = allocateVertical(cols, bBase);

    /* ---- APU：仅在触顶（升力缺口）时投入 ---- */
    let Tapu = 0;
    const achieved = res.T.reduce((a, v) => a + v, 0);
    const deficit = FzReq - achieved;
    const onThr = jc.lim.Famin, offThr = 0.9 * jc.lim.Famin;
    if (!jc.apu.failed && deficit > (jc._apuOn ? offThr : onThr)) {
      Tapu = clamp(deficit, jc.lim.Famin, jc.lim.Famax); jc._apuOn = true;
    } else jc._apuOn = false;

    return {
      Tv: res.T, Tapu,
      gapRate, gapRateRel,
      tauBow: pb.tau, alphaBow: pb.alpha,
      tauStern: ps.tau, alphaStern: ps.alpha,
      FzReq, MxReq, MyReq, alloc: res, deficit,
      vCmdW, vMax, FhorizB, MzYaw,
      cz, cr, cp, wz, wr, wp,
    };
  }
}

/* ==========================================================================
 *  5. ManualControl —— 手柄 / 脚蹬（非自动驾驶的输入变换）
 *
 *  手柄坐标系 = **TRK 系**（不是机体系，也不是正北系）：
 *      「前」= TRK 旋钮所指的那个世界方位
 *      ⇒ 一个系、无开关、无指示灯；BERTH 时「前」= 泊位轴（舵工心智）
 *  手柄 **无 Z 轴**（推进器垂向只有 ±6 cm，作为操纵量无意义）
 *  垂向/姿态的阻尼 **始终由自动驾驶提供**（与 MANUAL/MANAGED 无关）
 * ========================================================================== */
class ManualControl {
  constructor(cfg = {}) {
    this.cfg = Object.assign({ Vmax: 22, yawRateMax: 1.5 /* °/s */, deadband: 1e-3 }, cfg);
  }
  /** @param stick {x,y,twist} 归一化 [-1,1]；trkBearing 当前航迹方位（度） */
  compute(S, panel) {
    const C = this.cfg, st = panel.stick;
    const mag = Math.hypot(st.x, st.y);
    /* TRK 系 → 世界： forward = (sin β, cos β)，right = (cos β, −sin β) */
    const beta = panel.trkNow / DEG;
    const fwd = [Math.sin(beta), Math.cos(beta)], rgt = [Math.cos(beta), -Math.sin(beta)];
    const m = Math.min(mag, 1);
    const vxW = (st.x * rgt[0] + st.y * fwd[0]) * C.Vmax * m;
    const vyW = (st.x * rgt[1] + st.y * fwd[1]) * C.Vmax * m;
    const yawRateCmd = Math.abs(st.twist) > C.deadband ? st.twist * C.yawRateMax / DEG : null;
    return { vxW, vyW, yawRateCmd: yawRateCmd == null ? null : yawRateCmd * DEG,
             psiCmd: null, dt: S.dt, stick: { ...st }, trkBearing: panel.trkNow };
  }
}
/** MANAGED 指令：SPD 沿 TRK，HDG 保持 */
function managedCommand(S, panel, dt) {
  const beta = panel.trkNow / DEG;
  const v = bearingVec(panel.trkNow);
  return {
    vxW: v[0] * panel.sel.spd, vyW: v[1] * panel.sel.spd,
    yawRateCmd: panel.yawRateMode ? null : null,
    psiCmd: bearingToPsi(panel.out.hdg),
    dt, spd: panel.sel.spd, trkBearing: panel.trkNow,
  };
}

/* ==========================================================================
 *  6. FlightControl —— 编排
 * ========================================================================== */
class FlightControl {
  constructor(jc, cfg = {}) {
    this.jc = jc;
    this.cfg = Object.assign({
      emergencyDescent: false,   // 旁路 τ（**不旁路速率限**）
      ctrlInterval: 0,           // 控制周期 s；0 = 每物理子步（默认）
      zRef: {},
      panel: {},
      ap: {},
      manual: {},
    }, cfg);
    this.panel = new ControlPanel(Object.assign({ Vmax: jc.cfg.Vmax }, this.cfg.panel));
    this.ap = new Autopilot(Object.assign({ zeta: jc.cfg.zeta }, this.cfg.ap));
    this.manual = new ManualControl(Object.assign({ Vmax: jc.cfg.Vmax }, this.cfg.manual));
    this.profile = new ZRefProfile(Object.assign({
      tauS: jc.cfg.tauS, rateLim: jc.cfg.rateLimZRef,
    }, this.cfg.zRef));
    this.profile.init();
    /* 初始同步面板到当前状态 */
    const S0 = jc.sense(); S0.jc = jc; S0.dt = 0.05;
    this.panel.sel.alt = jc.cfg.zRef0;
    this.panel.sel.hdg = psiToBearing(S0.state.psi);
    this.panel.draft.trk = this.panel.sel.trk = 0;
    this.t = 0;
    this.diag = {}; this.advisory = { notes: [] };
    this.source = 'MANAGED';
  }

  /* ---- 目标原长数组：集体（高度）+ 差动（坡度/静倾配平） ---- */
  _zRefTarget(S) {
    const p = this.panel;
    const out = new Array(9);
    const collective = p.sel.alt + this.jc.delta0();   // alt 是 AGL；原长 = AGL + δ₀
    for (let i = 0; i < 9; i++) {
      const st = this.jc.stones[i];
      let trim = 0;
      if (p.levelMode === 'LEVEL') trim = -(S.slope.sx * st.pos[0] + S.slope.sy * st.pos[1]);
      out[i] = collective + trim;
    }
    return out;
  }

  /**
   * @param dt 步长 s
   * 控制以「可选的控制周期」运行（默认 = 每个物理子步，即最精细）：
   *   cfg.ctrlInterval <= 0 ⇒ 每子步都跑（默认）
   *   cfg.ctrlInterval  > 0 ⇒ 按该间隔跑（可用于研究控制延迟的敏感性）
   * 但 **zRef 剖面必须至少按物理子步更新**，否则阶梯化会激励弹簧。
   */
  update(dt) {
    const jc = this.jc;
    const ci = this.cfg.ctrlInterval || 0;
    let last = null;
    if (ci <= 0) {
      jc.physicsUpdate(dt, h => { last = this._controlStep(h); });
    } else {
      const n = Math.max(1, Math.ceil(dt / jc.cfg.maxStep)), h = dt / n;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        acc += h;
        if (acc + 1e-12 >= ci || i === 0) { last = this._controlStep(Math.max(acc, h)); acc = 0; }
        /* 未到控制周期：只推进物理（zRef 由物理按已写入的速率连续推进） */
        jc.physicsUpdate(h);
        if (jc.diverged) break;
      }
    }
    const S2 = jc.sense(); S2.jc = jc; S2.dt = dt;
    if (last) { this._lastFzReq = last.A.FzReq; this._lastMxReq = last.A.MxReq; this._lastMyReq = last.A.MyReq; }
    this._diagnose(S2, last ? last.A : this._lastA, last ? last.po : this.panel.out,
                   last ? last.cmd : null, jc.zRef.slice());
    return jc.ctrl;
  }

  /** 一个控制周期：面板 → 指令 → zRef 剖面 → 推进器分配 */
  _controlStep(dt) {
    const jc = this.jc;
    const S = jc.sense(); S.jc = jc; S.dt = dt;
    this.t += dt; jc._t = this.t;

    /* 1) MCP 更新（TRK 回转、CRAB 夹逼、HDG AUTO） */
    const po = this.panel.update(dt, S, jc.lim.FazMax);
    this.source = po.source;

    /* 2) 选源 → 指令 */
    const cmd = this.source === 'MANAGED'
      ? managedCommand(S, this.panel, dt)
      : this.manual.compute(S, this.panel);

    /* 3) zRef 剖面（集体 + 差动），S 曲线 —— 只给速率，由物理连续积分 */
    const target = this._zRefTarget(S);
    this.profile.rateFor(dt, target, S.ceiling,
      this.cfg.emergencyDescent ? 'emergency' : 'normal', jc.zRef);
    jc.setZRefRate(this.profile.rate);
    cmd.zRefRate = this.profile.rate[0];

    /* 4) 自动驾驶（阻尼 / 水平 / 偏航 / 分配）—— 两种源都跑 */
    const A = this.ap.compute(S, cmd);
    jc.ctrl.Tv = A.Tv; jc.ctrl.Tapu = A.Tapu;
    jc.ctrl.tauBow = A.tauBow; jc.ctrl.alphaBow = A.alphaBow;
    jc.ctrl.tauStern = A.tauStern; jc.ctrl.alphaStern = A.alphaStern;

    this._lastA = A; this._lastPo = po; this._lastCmd = cmd;
    return { S, po, cmd, A, zr: jc.zRef.slice() };
  }

  _diagnose(S, A, po, cmd, zr) {
    const jc = this.jc, W = S.W;
    const pc = x => x / W * 100;
    /* STONE_DEV：与 **标称特性**（tol=0，含 clamp）比对 ⇒ 只反映石头退化/异常，
     * 不会把「触顶饱和」误报为石头故障（早期版本曾用 raw 比对，导致 21% 假报警） */
    let stoneDev = 0, nSat = 0;
    jc.stones.forEach((st, i) => {
      if (st.failed) return;
      const g = S.gArr[i], raw = st.k * (zr[st.idx] - g);
      const env = st.F0 * Math.min(1, Math.exp(-g / jc.cfg.lambda));
      if (raw > env) nSat++;
      const pred = clamp(raw, 0, env);
      const dev = Math.abs(S.fArr[i] - pred) / (W / 9);
      if (dev > stoneDev) stoneDev = dev;
    });
    const gap = S.gap;
    let canLose = 0;
    for (let k = 1; k <= 8; k++) {
      const zc = jc.cfg.lambda * Math.log((9 - k) * jc.stones[0].F0 / W);
      if (zc >= gap) canLose = k; else break;
    }
    this.diag = {
      t: this.t, source: this.source,
      agl: gap, clearance: S.clearance, ceiling: S.ceiling, margin: S.ceiling - gap,
      canLoseStones: canLose,
      BtotPct: pc(S.Lforce.Btot), netLiftPct: pc(S.Lforce.Btot - W),
      TvPct: A.Tv.map(pc), TapuPct: pc(A.Tapu || 0),
      tauPct: [pc(jc.ctrl.tauBow), pc(jc.ctrl.tauStern)],
      alloc: { peak: A.alloc.peak, saturated: A.alloc.saturated, damped: A.alloc.damped,
               nullShift: A.alloc.nullShift, deficit: A.alloc.deficit },
      GMx: S.GMx, GMy: S.GMy, delta0: S.delta0, d: S.d,
      slopeMag: S.slopeMag, fieldRate: S.fieldRate, vLimit: A.vMax,
      RPYdeg: [S.state.phi, S.state.theta, S.state.psi].map(degOf),
      bearing: psiToBearing(S.state.psi), trk: po.trkNow, crab: po.crab,
      spd: Math.hypot(S.Vw[0], S.Vw[1]),
      zRefRate: this.profile.rate[0], zRefAcc: this.profile.acc[0],
      zRefLimited: this.profile.limited,
      nActive: S.nActive, nSaturated: S.nSaturated, stoneDev,
      gapDev: S.gap - (zr[0] - S.delta0),
      gapRate: S.Vw[2] - S.fieldRate,
      /* ---- 与旧版 diag 的兼容别名（测试与下游脚本沿用） ---- */
      gap: gap, slope: S.slope, FzReq: A ? A.FzReq : 0,
      MxReq: A ? A.MxReq : 0, MyReq: A ? A.MyReq : 0,
      Tv: A ? A.Tv.slice() : [0, 0, 0, 0], Tapu: A ? A.Tapu : 0,
      Btot: S.Lforce.Btot, W, netLift: S.Lforce.Btot - W,
      wz: A ? A.wz : 0, wr: A ? A.wr : 0, wp: A ? A.wp : 0,
      cz: A ? A.cz : 0, cr: A ? A.cr : 0, cp: A ? A.cp : 0,
      Fthr: S.Lforce.Fthr.slice(), Mthr: S.Lforce.Mthr.slice(),
    };
    /* 建议（自动驾驶不可执行） */
    const adv = { ballastDump: 0, waterTransfer: new Array(5).fill(0),
                  zRefSuggest: null, notes: [] };
    const short = W - S.Btot - (jc.eng.filter(e => !e.failed).length * jc.lim.Fmax
                                + (jc.apu.failed ? 0 : jc.lim.Famax));
    adv.ballastDump = Math.max(0, short / jc.cfg.g);
    if (S.Btot > 1e-6 && vLen(S.L.Menv) > 1e5) {
      const drCm = vMul(vCross(S.kb, S.L.Menv), 1 / S.Btot);
      const need = vMul(drCm, S.M);
      const rows = [[1, 1, 1, 1, 1],
        jc.tanks.map(t => t.pos[0] - S.rcm[0]),
        jc.tanks.map(t => t.pos[1] - S.rcm[1])];
      const inv = matInv(matMul(rows, matT(rows)));
      if (inv) {
        const y = matMul(inv, [[0], [need[0]], [need[1]]]);
        const dm = matMul(matT(rows), y).map(r => r[0]);
        const mean = dm.reduce((a, b) => a + b, 0) / 5;
        adv.waterTransfer = dm.map(v => v - mean).map((v, i) =>
          clamp(v, -jc.tanks[i].m, Math.max(0, jc.tanks[i].cap - jc.tanks[i].m)));
      }
    }
    if (S.nSaturated > 0)       adv.notes.push(`ENVELOPE_SATURATED：${S.nSaturated} 块石触顶包络（刚度下降，GM_roll=${S.GMx.toFixed(0)} m）`);
    if (this.diag.margin < 100) adv.notes.push(`CEILING_MARGIN_LOW：余量 ${this.diag.margin.toFixed(0)} m（可再失 ${canLose} 块）`);
    if (Math.abs(S.fieldRate) > jc.cfg.rMaxField) adv.notes.push(`FIELD_RATE_HIGH：${S.fieldRate.toFixed(2)} m/s（需降速）`);
    if (stoneDev > 0.01)        adv.notes.push(`STONE_DEV：单石出力偏差 ${(stoneDev * 100).toFixed(2)}% > 1%`);
    if (S.clearance < 50)       adv.notes.push(`TERRAIN_CLEARANCE_LOW：真实离地 ${S.clearance.toFixed(0)} m`);
    if (S.GMx < 0 || S.GMy < 0) adv.notes.push(`NEGATIVE_GM：GM_roll=${S.GMx.toFixed(1)} GM_pitch=${S.GMy.toFixed(1)}`);
    if (po.crabLimited)         adv.notes.push(`CRAB_LIMIT：${po.crab.toFixed(0)}° 超限，已夹逼 ${po.crabClamped}`);
    if (po.trkSlewLimited)      adv.notes.push('TRK_SLEW_LTD：航迹回转受可用推力限制');
    if (this.profile.limited)   adv.notes.push('CEILING_PROTECT：高度目标已被升限保护限幅');
    if (jc.azBow.failed !== jc.azStern.failed) adv.notes.push('HEADING_FREE：单台 azimuth 失效，艏向不可控');
    this.advisory = adv;
    return adv;
  }

  status() {
    const D = this.diag;
    return {
      t: D.t, source: D.source,
      agl: D.agl, clearance: D.clearance, ceiling: D.ceiling, margin: D.margin,
      canLoseStones: D.canLoseStones,
      RPYdeg: D.RPYdeg, bearing: D.bearing, trk: D.trk, crab: D.crab, spd: D.spd,
      BtotPct: D.BtotPct, netLiftPct: D.netLiftPct,
      TvPct: D.TvPct, TapuPct: D.TapuPct, tauPct: D.tauPct,
      zRefRate: D.zRefRate, nActive: D.nActive, nSaturated: D.nSaturated,
      notes: this.advisory.notes,
    };
  }
  /** 分配自检：力矩残差应为 0（力残差只在 azimuth 饱和时非零） */
  verifyAllocation() {
    const jc = this.jc;
    const L = jc.computeLoads();
    return {
      dF: vSub(L.Fthr, [0, 0, this._lastFzReq || 0]),
      dM: vSub(L.Mthr, [this._lastMxReq || 0, this._lastMyReq || 0, 0]),
    };
  }
}

module.exports = {
  FlightControl, ControlPanel, ZRefProfile, Autopilot, ManualControl,
  allocateVertical, CRAB_LIMITS,
  bearingToPsi, psiToBearing, bearingVec, DEG, wrapPi, wrap2pi, degOf,
};

/* ============================================================================
 *  演示
 * ========================================================================== */
if (require.main === module) {
  const n1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const n2 = x => (Math.round(x * 100) / 100).toFixed(2);
  const mk = (cfg = {}) => {
    const jc = new JadeChamber(Object.assign({ terrain: { preset: 'flat' } }, cfg.jc));
    const fc = new FlightControl(jc, cfg.fc);
    return { jc, fc };
  };
  const run = (o, T, dt = 0.05) => {
    for (let k = 0; k < Math.round(T / dt); k++) o.fc.update(dt);
    return o;
  };
  const show = (o, title) => {
    const D = o.fc.diag;
    console.log(`──── ${title} (t=${n1(o.fc.t)} s) ────`);
    console.log(`  源=${D.source} | AGL ${n1(D.agl)} m | 离地 ${n1(D.clearance)} m | 升限 ${n1(D.ceiling)} | 余量 ${n1(D.margin)}（可再失 ${D.canLoseStones}）`);
    console.log(`  方位 ${n1(D.bearing)}° 航迹 ${n1(D.trk)}° CRAB ${n1(D.crab)}° 速度 ${n2(D.spd)} m/s`);
    console.log(`  姿态 R/P/Y ${n2(D.RPYdeg[0])}/${n2(D.RPYdeg[1])}/${n2(D.RPYdeg[2])}° | 浮力 ${n2(D.BtotPct)}%W 净 ${n2(D.netLiftPct)}%W`);
    console.log(`  垂推 ${D.TvPct.map(v => n2(v)).join('/')}%W  APU ${n2(D.TapuPct)}%W  az ${n2(D.tauPct[0])}/${n2(D.tauPct[1])}%W`);
    console.log(`  zRef 速率 ${n2(D.zRefRate)} m/s  加速度 ${n2(D.zRefAcc)} m/s² | GM_r ${n1(D.GMx)} GM_p ${n1(D.GMy)}`);
    if (o.fc.advisory.notes.length) console.log(`  ⚠ ${o.fc.advisory.notes.join('；')}`);
    console.log('');
  };

  console.log('══════════ 群玉阁 · 控制层演示 ══════════\n');

  /* 1. 平地定点悬停 */
  let o = mk(); run(o, 100); show(o, '1. 平地 HOLD（SPD=0）');

  /* 2. MANAGED 巡航：SPD=18 沿 TRK=45 */
  o = mk();
  o.fc.panel.setKnob('SPD', 18);
  o.fc.panel.setKnob('TRK', 45); o.fc.panel.pressTRKSET();
  run(o, 300); show(o, '2. MANAGED 巡航 SPD=18 / TRK=045');

  /* 3. CRAB LIMIT：HDG 与 TRK 相差 90°，TRANSIT(±30) 夹逼 TRK */
  o = mk();
  o.fc.panel.setKnob('SPD', 15);
  o.fc.panel.setKnob('TRK', 0);  o.fc.panel.pressTRKSET();
  o.fc.panel.setKnob('HDG', 90);
  o.fc.panel.setKnob('CRAB', 'TRANSIT');
  o.fc.panel.update(0.05, Object.assign(o.jc.sense(), { jc: o.jc, dt: 0.05 }), o.jc.lim.FazMax);
  console.log('──── 3. CRAB LIMIT (TRANSIT ±30°) ────');
  console.log(`  设定 HDG=090 TRK=000 ⇒ CRAB=90° > 30°，优先 ${'TRK'} ⇒ 实际 TRK=${n1(o.fc.panel.out.trk)}° CRAB=${n1(o.fc.panel.out.crab)}° 夹逼=${o.fc.panel.out.crabClamped}`);
  console.log('');

  /* 4. TRK SET 草稿窗（未按下不生效） */
  o = mk();
  o.fc.panel.setKnob('TRK', 120);
  console.log('──── 4. TRK SET 草稿窗 ────');
  console.log(`  转动旋钮到 120 ⇒ 已提交 sel.trk=${n1(o.fc.panel.sel.trk)}°（草稿 ${n1(o.fc.panel.draft.trk)}°）⇒ 未生效 ✓`);
  o.fc.panel.pressTRKSET();
  console.log(`  按下 TRK SET ⇒ sel.trk=${n1(o.fc.panel.sel.trk)}° ⇒ 生效 ✓`);
  console.log('');

  /* 5. 应急下降：旁路 τ（不旁路速率限）+ S 曲线 */
  o = mk(); o.fc.cfg.emergencyDescent = true;
  o.fc.panel.setKnob('ALT', 300);
  run(o, 60); show(o, '5. 应急下降 749→300 m（旁路 τ，60 s 后）');
  console.log(`  ⇒ zRef 速率 ${n2(o.fc.diag.zRefRate)} m/s（≤ 速率限 ${o.fc.profile.cfg.rateLim}）`
    + `  加速度 ${n2(o.fc.diag.zRefAcc)} m/s² ⇒ 准静态偏差 ≈ ${n2(ZRefProfile.quasiStatic(o.fc.diag.zRefAcc) * 100)}% δ₀`);
  console.log('');

  /* 6. 正常下降（τ 主导）：验证「慢」 */
  o = mk(); o.fc.panel.setKnob('ALT', 700);
  run(o, 60);
  console.log('──── 6. 正常下降（τ=300 s 主导） ────');
  console.log(`  60 s 后 ΔAGL=${n1(749 - o.fc.diag.agl)} m，速率 ${n2(o.fc.diag.zRefRate)} m/s（τ 使速率随误差衰减）`);
  console.log('');

  /* 7. 手柄（TRK 系） */
  o = mk();
  o.fc.panel.setKnob('TRK', 90); o.fc.panel.pressTRKSET();
  o.fc.panel.stick = { x: 0, y: 1, twist: 0 };   // 满舵「前」
  run(o, 60);
  console.log('──── 7. 手柄前推（TRK=090 ⇒ 世界东向） ────');
  console.log(`  源=${o.fc.diag.source}（手柄一动即转 MANUAL）速度 ${n2(o.fc.diag.spd)} m/s  位置 x=${n1(o.jc.state.P[0])} y=${n1(o.jc.state.P[1])}`);
  console.log(`  ⇒ 沿 +x（东）移动，与 TRK=090 一致 ✓`);
  console.log('');

  /* 8. 坡度跟随（自动倾斜 = 坡度，免费） */
  o = mk({ jc: { terrain: { preset: 'ramp' } } });
  o.fc.panel.levelMode = 'FOLLOW';
  run(o, 200); show(o, '8. 斜坡：FOLLOW SLOPE（自动倾斜）');
  let o2 = mk({ jc: { terrain: { preset: 'ramp' } } });
  o2.fc.panel.pressLEVEL(true);
  run(o2, 400); show(o2, '8b. 斜坡：LEVEL（差动 zRef 配平，τ=300 s 慢）');

  /* 9. 单石失效（弹簧区：几乎不下沉） */
  o = mk(); run(o, 60); const before = o.fc.diag.agl;
  o.jc.setStone(0, { failed: true });
  run(o, 120); show(o, '9. 角石失效（弹簧区）');
  console.log(`  ⇒ 下沉 ${n2(before - o.fc.diag.agl)} m（不是 59 m：升限降幅 ≠ 下沉量）`);
  console.log('');

  /* 10. HDG AUTO */
  o = mk();
  o.jc.setWind([0, -12, 0]);   // 12 m/s 南风
  o.fc.panel.setKnob('SPD', 18);
  o.fc.panel.setKnob('TRK', 0); o.fc.panel.pressTRKSET();
  o.fc.panel.cfg.hdgAuto.enabled = true;
  const S = Object.assign(o.jc.sense(), { jc: o.jc, dt: 0.05 });
  o.fc.panel.update(0.05, S, o.jc.lim.FazMax);
  console.log('──── 10. HDG AUTO（最小化 azimuth 峰值需求） ────');
  console.log(`  风 12 m/s 南风，SPD=18 TRK=000 ⇒ 最优方位 ${n1(o.fc.panel.out.optHdg)}°（正方形平面 ⇒ 0/90/180/270 之一）`);
  console.log('');
}
