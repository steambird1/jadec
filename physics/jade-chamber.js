/* ============================================================================
 *  jade-chamber.js —— 群玉阁 6-DOF 仿真 + 自动驾驶
 *
 *  【v2 · 两尺度浮空场模型】（与 v1 的「浮空石 = 恒力」模型的根本区别）
 *
 *  1) 慢包络（Yukawa / 屏蔽场）：  F_max(g) = F0 · e^(−g/λ)
 *        g  = 石头到场参考面 S 的间隙（m），λ = 500 m 为量程
 *        ⇒ 自然升限 z_ceiling = λ·ln(9·F0/W)
 *  2) 快刚度（局部间隙调节）：     f_k = k·(zRef_k − g_k)，k = F0/δ_ref
 *        ⇒ 静态下沉量 δ₀ = W/(9k)；平衡间隙 g = zRef − δ₀
 *        ⇒ 倾覆/恢复力矩自动出现：M = W·d·φ − k·Σx²·φ   （船的稳心公式）
 *
 *  石头力 = clamp( 弹簧 , 0 , 包络 )
 *
 *  由此产生的设计后果（相对 v1）：
 *    · 高度由 zRef 设定（慢，τ=300 s），推进器在垂向只有 ±(F/W)·δ₀ 的厘米级权限
 *    · 推进器的垂向/姿态工作退化为「阻尼器」，稳态出力为零
 *    · 遇地形时自动跟随高度 + 自动倾斜对准坡度（免费）
 *    · 无「升力缺口」⇒ APU 只在触顶时需要
 *
 *  地形：由 terrain.js 提供（接口 (xNM,yNM)→ft），场参考面 S 为地形的锥形膨胀，
 *        满足 S ≥ T 且 |∇S| ≤ sMax。
 * ========================================================================== */
'use strict';
const { createTerrain } = require('./terrain.js');

/* ==========================================================================
 *  0. 向量 / 矩阵工具
 * ========================================================================== */
const vAdd   = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vSub   = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vMul   = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vDot   = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1],
                          a[2] * b[0] - a[0] * b[2],
                          a[0] * b[1] - a[1] * b[0]];
const vLen   = a => Math.hypot(a[0], a[1], a[2]);
const clamp  = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const wrapPi = x => { while (x >  Math.PI) x -= 2 * Math.PI;
                      while (x < -Math.PI) x += 2 * Math.PI; return x; };

function matMul(A, B) {
  const n = A.length, m = B[0].length, p = B.length, C = [];
  for (let i = 0; i < n; i++) { C.push([]); for (let j = 0; j < m; j++) {
    let s = 0; for (let k = 0; k < p; k++) s += A[i][k] * B[k][j]; C[i].push(s); } }
  return C;
}
const matT   = A => A[0].map((_, j) => A.map(r => r[j]));
const matVec = (A, v) => A.map(r => vDot(r, v));
function matInv(A) {                                   // Gauss-Jordan
  const n = A.length;
  const M = A.map((r, i) => r.concat(Array.from({ length: n }, (_, j) => i === j ? 1 : 0)));
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (Math.abs(M[p][i]) < 1e-300) return null;
    [M[i], M[p]] = [M[p], M[i]];
    const d = M[i][i];
    for (let c = 0; c < 2 * n; c++) M[i][c] /= d;
    for (let r = 0; r < n; r++) if (r !== i) {
      const f = M[r][i]; if (!f) continue;
      for (let c = 0; c < 2 * n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map(r => r.slice(n));
}
function eulerToR(phi, theta, psi) {
  const cf = Math.cos(phi), sf = Math.sin(phi);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const cp = Math.cos(psi), sp = Math.sin(psi);
  return [
    [cp * ct, cp * st * sf - sp * cf, cp * st * cf + sp * sf],
    [sp * ct, sp * st * sf + cp * cf, sp * st * cf - cp * sf],
    [-st,     ct * sf,                ct * cf],
  ];
}
const rApply  = (R, v) => [vDot(R[0], v), vDot(R[1], v), vDot(R[2], v)]; // 体→世界
const rtApply = (R, v) => [R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
                           R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
                           R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]];
const inertiaBox = (m, a, b, c) => [
  [m * (4 * b * b + 4 * c * c) / 12, 0, 0],
  [0, m * (4 * a * a + 4 * c * c) / 12, 0],
  [0, 0, m * (4 * a * a + 4 * b * b) / 12]];
function inertiaPoint(m, r) {
  const [x, y, z] = r, r2 = vDot(r, r);
  return [[m * (r2 - x * x), -m * x * y, -m * x * z],
          [-m * x * y, m * (r2 - y * y), -m * y * z],
          [-m * x * z, -m * y * z, m * (r2 - z * z)]];
}
const matAdd = (A, B) => A.map((r, i) => r.map((v, j) => v + B[i][j]));

/* ==========================================================================
 *  JadeChamber
 * ========================================================================== */
class JadeChamber {
  constructor(cfg = {}) {
    const C = this.cfg = Object.assign({
      /* ---- 几何（半尺寸，m） ---- */
      a: 60, b: 60, c: 40,
      /* ---- 质量 ---- */
      g: 9.81,
      MDry: 1.0e7,                  // 干重（不含浮空石），kg
      mStoneRatio: 0.5,             // 浮空石总质量 / 干重  ⇒ 石头占全重 1/3
      fStructure: 0.86, fWater: 0.12, fFuel: 0.01, fPayload: 0.01,  // 占 MDry
      rDry: [0, 0, 0], rPayload: [0, 0, 0],
      /* ---- 浮空场 ---- */
      lambda: 500,                  // 量程 m
      alpha: 20,                    // 石头升重比 ⇒ 渐近天花板 λ·lnα
      deltaRef: 2.0,                // 调节带 ⇒ k = F0/δ_ref
      zRef0: 749.3,                 // 初始命令间隙（平衡 AGL = zRef − δ₀）
      tauS: 300,                    // zRef 作动一阶时间常数 s
      rateLimZRef: 1.5,             // zRef 速率上限 m/s（超出会冲出弹簧线性区）
      sMax: 0.04,                   // 场参考面坡度上限
      rMaxField: 1.0,               // 遭遇场变化率上限 m/s ⇒ V ≤ rMax/s
      /* ---- 推进器极限（以 W 的倍数给出） ---- */
      Fmin: -0.02, Fmax: 0.05,      // 垂直发动机 ×4
      FazMax: 0.02,                 // 单台 azimuth
      Famin: 0.02, Famax: 0.15,     // APU
      Vmax: 22,                     // 水平速度上限 m/s
      /* ---- 阻尼设计 ---- */
      zeta: 0.10,
      /* ---- 环境 ---- */
      windWorld: [0, 0, 0],
      kDragQuad: 6000, kDragAng: 5e7,
      apuFuelFlow: 2.0,
      maxStep: 0.01,
      /* ---- 自动驾驶 ---- */
      gain: { kpPos: 0.05, kdPos: 0.45, aMax: 0.5, kpYaw: 0.02, kdYaw: 0.5 },
      attitudeHold: false,          // true = 用推进器强制保持水平（坡上会饱和）
      autoSlopeTrim: false,         // true = 自动驾驶持续用差动 zRef 抵消坡度
      /* ---- 地形 ---- */
      terrain: { preset: 'flat' },
    }, cfg);

    this.g = C.g;

    /* ---------------------------------------------------- 几何：安装坐标 */
    const { a, b, c } = C;
    this.eng = [
      { name: 'FL', pos: [-7 * a / 8, +3 * b / 8, -c / 2], failed: false },
      { name: 'FR', pos: [+7 * a / 8, +3 * b / 8, -c / 2], failed: false },
      { name: 'RL', pos: [-7 * a / 8, -3 * b / 8, -c / 2], failed: false },
      { name: 'RR', pos: [+7 * a / 8, -3 * b / 8, -c / 2], failed: false },
    ];
    this.azBow   = { name: 'bow',   pos: [0, +5 * b / 6, 0], failed: false };
    this.azStern = { name: 'stern', pos: [0, -5 * b / 6, 0], failed: false };
    this.apu     = { pos: [0, 0, -c / 2], failed: false };
    this.rFuel   = [0, 0, -3 * c / 4];
    this.tanks = [
      { name: 'W1(FL↑)', pos: [-7 * a / 8, +3 * b / 8, +c / 2] },
      { name: 'W2(FR↑)', pos: [+7 * a / 8, +3 * b / 8, +c / 2] },
      { name: 'W3(RL↑)', pos: [-7 * a / 8, -3 * b / 8, +c / 2] },
      { name: 'W4(RR↑)', pos: [+7 * a / 8, -3 * b / 8, +c / 2] },
      { name: 'W5(ctr)', pos: [0, 0, +c / 4] },
    ];

    /* 浮空石 3×3：基盘在底面 z = −c（官方「基盘 + 其上建宫殿」） */
    this.stones = [];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        this.stones.push({
          idx: i * 3 + j,
          pos: [(i - 1) * a / 2, (j - 1) * b / 6, -c],
          tol: 0,                   // 制造公差（±1%）——仅作健康诊断用
          failed: false,
        });

    /* ---------------------------------------------------- 质量 */
    this.mStone     = C.mStoneRatio * C.MDry;
    this.mStructure = C.fStructure * C.MDry;
    this.mFuel      = C.fFuel      * C.MDry;
    this.mPayload   = C.fPayload   * C.MDry;
    const wEach = C.fWater * C.MDry / 5;
    this.tanks.forEach(t => { t.m = wEach; t.cap = Infinity; });
    this.mStoneEach = this.mStone / 9;

    /* ---------------------------------------------------- 场参数 */
    this.terrain = createTerrain(Object.assign({ sMax: C.sMax }, C.terrain));
    this.W = (C.MDry + this.mStone) * C.g;          // 标称重量
    this.G = this.W;                                 // %G 基准
    for (const st of this.stones) {
      st.F0 = C.alpha * this.mStone * C.g / 9;       // 单石 gap=0 时的最大出力
      st.k  = st.F0 / C.deltaRef;                    // 局部刚度（常量）
    }
    this.lim = {
      Fmin: C.Fmin * this.W, Fmax: C.Fmax * this.W,
      FazMax: C.FazMax * this.W,
      Famin: C.Famin * this.W, Famax: C.Famax * this.W,
    };

    /* ---------------------------------------------------- 状态 */
    this.state = { P: [0, 0, 0], V: [0, 0, 0], phi: 0, theta: 0, psi: 0, omega: [0, 0, 0] };
    this.ctrl  = { Tv: [0, 0, 0, 0], Tapu: 0, tauBow: 0, alphaBow: 0, tauStern: 0, alphaStern: 0 };
    /* zRef：命令值（集体）与差动量（配平） */
    this.zRefCmd  = C.zRef0;
    this.zRefTrim = new Array(9).fill(0);
    this.zRef     = new Array(9).fill(C.zRef0);
    this.zRefRate = new Array(9).fill(0);   // 控制层写入，物理子步内连续积分
    this.setpoint = { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, agl: null };
    this.diag = {}; this.advisory = {}; this._apuOn = false;
    this.stiffnessFailed = false; this.diverged = false; this.frozenF = null;

    this.updateMassProperties();
    /* 初始就位：AGL = zRef0 − δ₀ */
    this.placeAt(0, 0, C.zRef0 - this.delta0());
    this.computeLoads();
  }

  /* -------------------------------------------------- 派生量 */
  delta0()  { return this.mp.W / (9 * this.stones[0].k); }      // 静态下沉量
  ceiling() { const nA = this.stones.filter(s => !s.failed).length;
              return this.cfg.lambda * Math.log(nA * this.stones[0].F0 / this.mp.W); }

  /* ==================================================================== *
   *  1. 质量特性
   * ==================================================================== */
  updateMassProperties() {
    const C = this.cfg;
    let M = 0, acc = [0, 0, 0];
    const addPoint = (m, r) => { M += m; acc = vAdd(acc, vMul(r, m)); };
    addPoint(this.mStructure, C.rDry);
    addPoint(this.mPayload,   C.rPayload);
    addPoint(this.mFuel,      this.rFuel);
    for (const t of this.tanks) addPoint(t.m, t.pos);
    for (const st of this.stones) addPoint(this.mStoneEach, st.pos);   // 石头是死重！

    const rcm = vMul(acc, 1 / M);
    let I = inertiaBox(this.mStructure, C.a, C.b, C.c);
    I = matAdd(I, inertiaPoint(this.mStructure, vSub(C.rDry, rcm)));
    const pts = [[this.mPayload, C.rPayload], [this.mFuel, this.rFuel],
                 ...this.tanks.map(t => [t.m, t.pos]),
                 ...this.stones.map(s => [this.mStoneEach, s.pos])];
    for (const [m, r] of pts) I = matAdd(I, inertiaPoint(m, vSub(r, rcm)));

    this.mp = { M, rcm, I };
    this.mp.W = M * this.g;
    return this.mp;
  }

  /* ==================================================================== *
   *  2. 受力 / 力矩（体轴）—— 仿真与自动驾驶共用
   * ==================================================================== */
  computeLoads() {
    const s = this.state, { rcm } = this.mp;
    const R  = eulerToR(s.phi, s.theta, s.psi);
    const kb = rtApply(R, [0, 0, 1]);                 // 世界竖直在体轴

    /* ---- 浮空石：间隙 → 弹簧力，再被慢包络 clamp ---- */
    const lam = this.cfg.lambda;
    let Btot = 0, sat = 0;
    const Fenv = [0, 0, 0], Menv = [0, 0, 0];
    const fArr = [], gArr = [], kArr = [];
    let kY2 = 0, kX2 = 0;                  // Σ k_i·y_i² ，Σ k_i·x_i²  （恢复力矩系数）
    for (const st of this.stones) {
      const pw = vAdd(s.P, rApply(R, st.pos));        // 石头世界位置
      const g  = pw[2] - this.terrain.fieldM(pw[0], pw[1]);
      let f = 0, keff = 0;
      if (st.failed) { f = 0; }
      else if (this.stiffnessFailed) {
        /* 刚度丧失 = 只剩开环出力（无间隙反馈）⇒ 中性浮力体，倒立摆 */
        f = this.frozenF[st.idx]; keff = 0;
      } else {
        const env = st.F0 * Math.min(1, Math.exp(-g / lam));
        const raw = st.k * (1 + st.tol) * (this.zRef[st.idx] - g);
        f = clamp(raw, 0, env);
        if (raw > env) { sat++; keff = f / lam; }     // 触顶：只剩包络的极软刚度
        else keff = st.k * (1 + st.tol);
      }
      kY2 += keff * st.pos[1] * st.pos[1];
      kX2 += keff * st.pos[0] * st.pos[0];
      kArr.push(keff);
      fArr.push(f); gArr.push(g);
      Btot += f;
      if (f > 0) {
        const arm = vSub(st.pos, rcm);
        const m = vCross(arm, vMul(kb, f));
        Fenv[0] += kb[0] * f; Fenv[1] += kb[1] * f; Fenv[2] += kb[2] * f;
        Menv[0] += m[0]; Menv[1] += m[1]; Menv[2] += m[2];
      }
    }
    /* 重力（世界竖直） */
    const W = this.mp.W;
    Fenv[0] -= kb[0] * W; Fenv[1] -= kb[1] * W; Fenv[2] -= kb[2] * W;

    /* ---- 推进器 ---- */
    const Fthr = [0, 0, 0], Mthr = [0, 0, 0];
    const addT = (pos, Fb) => {
      Fthr[0] += Fb[0]; Fthr[1] += Fb[1]; Fthr[2] += Fb[2];
      const m = vCross(vSub(pos, rcm), Fb);
      Mthr[0] += m[0]; Mthr[1] += m[1]; Mthr[2] += m[2];
    };
    this.eng.forEach((e, i) => addT(e.pos, [0, 0, this.ctrl.Tv[i]]));
    addT(this.apu.pos, [0, 0, this.ctrl.Tapu]);
    const azF = [[this.azBow.pos,   [this.ctrl.tauBow   * Math.sin(this.ctrl.alphaBow),
                                     this.ctrl.tauBow   * Math.cos(this.ctrl.alphaBow), 0]],
                 [this.azStern.pos, [this.ctrl.tauStern * Math.sin(this.ctrl.alphaStern),
                                     this.ctrl.tauStern * Math.cos(this.ctrl.alphaStern), 0]]];
    for (const [pos, F] of azF) addT(pos, F);

    /* ---- 气动阻力（相对气流） ---- */
    const Vw  = rApply(R, s.V);
    const Vrel = vSub(Vw, this.cfg.windWorld);
    const vr = vLen(Vrel);
    const FdragW = vr > 1e-9 ? vMul(Vrel, -this.cfg.kDragQuad * vr) : [0, 0, 0];
    const Fdrag  = rtApply(R, FdragW);
    const Mdrag  = vMul(s.omega, -this.cfg.kDragAng);

    const L = {
      R, kb, Btot, W, netLift: Btot - W,
      Fenv, Menv, Fthr, Mthr, Fdrag, Mdrag,
      Fb: vAdd(vAdd(Fenv, Fthr), Fdrag),
      Mb: vAdd(vAdd(Menv, Mthr), Mdrag),
      Vworld: Vw,
      fArr, gArr, kArr, kY2, kX2, nSaturated: sat,
      gapMean: gArr.reduce((a, b) => a + b, 0) / gArr.length,
    };
    this.loads = L;
    return L;
  }

  /* ==================================================================== *
   *  3. 物理积分
   * ==================================================================== */
  /**
   * @param dt         步长 s
   * @param onSubstep  可选：(h) => void，在 **每个物理子步之前** 调用。
   *                   控制层必须用它来更新 zRef 与推进器指令——否则 zRef 会以
   *                   控制帧率呈阶梯变化，持续激励弹簧（实测产生 13%δ₀ 的伪振荡）。
   */
  physicsUpdate(dt, onSubstep) {
    const n = Math.max(1, Math.ceil(dt / this.cfg.maxStep));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (onSubstep) onSubstep(h);
      this._integrate(h);
      if (this.diverged) break;
    }
    return this.state;
  }
  _integrate(h) {
    const s = this.state, { M, I } = this.mp;
    /* 原长按控制层给定的速率连续推进。
     * 采用 **半步分裂**：先推进 h/2 → 算载荷（参考与平台位置同处子步中点）
     * → 积分 → 再推进 h/2。这样可消除一阶离散偏移（否则会残留 rate·h 的假偏差）。*/
    for (let i = 0; i < 9; i++) this.zRef[i] += this.zRefRate[i] * h * 0.5;
    const L = this.computeLoads();
    this.loadsAtStep = L;      // 本子步 **实际用于积分** 的载荷（诊断应取这个）
    const Vb = s.V, om = s.omega;
    /* 平动 */
    const acc = vMul(L.Fb, 1 / M);
    const cor = vCross(om, Vb);
    s.V = vAdd(Vb, vMul(vSub(acc, cor), h));
    /* 转动 */
    const invI = matInv(I);
    const gyro = vCross(om, matVec(I, om));
    const dOm = matVec(invI, vSub(L.Mb, gyro));
    s.omega = vAdd(om, vMul(dOm, h));
    /* 运动学 */
    const R = eulerToR(s.phi, s.theta, s.psi);
    s.P = vAdd(s.P, vMul(rApply(R, s.V), h));
    const [p, q, r] = s.omega;
    const cf = Math.cos(s.phi), sf = Math.sin(s.phi), ct = Math.cos(s.theta);
    if (Math.abs(ct) < 1e-6) this.eulerWarn = true;
    const ctSafe = Math.abs(ct) < 1e-6 ? 1e-6 * Math.sign(ct || 1) : ct;
    s.phi   += (p + q * sf * Math.tan(s.theta) + r * cf * Math.tan(s.theta)) * h;
    s.theta += (q * cf - r * sf) * h;
    s.psi   += (q * sf + r * cf) / ctSafe * h;
    s.phi   = clamp(s.phi, -Math.PI / 2 * 0.995, Math.PI / 2 * 0.995);
    s.theta = clamp(s.theta, -Math.PI / 2 * 0.995, Math.PI / 2 * 0.995);
    s.psi   = wrapPi(s.psi);
    for (let i = 0; i < 9; i++) this.zRef[i] += this.zRefRate[i] * h * 0.5;   // 后半步
    /* 燃油消耗 */
    if (this.ctrl.Tapu > 0) { this.mFuel = Math.max(0, this.mFuel - this.cfg.apuFuelFlow * h);
                              this.updateMassProperties(); }
    /* 发散保护：NaN 或姿态超过 ±75° 即判定翻覆并停止积分 */
    const bad = !Number.isFinite(s.P[0] + s.P[1] + s.P[2] + s.phi + s.theta + s.psi);
    if (bad || Math.abs(s.phi) > 1.30 || Math.abs(s.theta) > 1.30) this.diverged = true;
  }

  /* ==================================================================== *
   *  6. 工具 / 失效注入
   * ==================================================================== */
  /** 纯物理步进（不含任何控制） */
  step(dt) { this.physicsUpdate(dt); return this.state; }

  /** 设置各石头的「弹簧原长」——由控制层（zRef 剖面生成器）写入 */
  setZRef(arr) { for (let i = 0; i < 9; i++) this.zRef[i] = arr[i]; }
  /** 设置「原长变化率」m/s —— 由控制层写入，物理在每个子步内连续积分
   *  （这样控制帧率与物理步长解耦，且 zRef 不再呈阶梯变化激励弹簧） */
  setZRefRate(arr) { for (let i = 0; i < 9; i++) this.zRefRate[i] = arr[i]; }

  /* ------------------------------------------------------------------ *
   *  sense()：控制层所需的全部观测量（物理侧只提供，不做决策）
   * ------------------------------------------------------------------ */
  sense() {
    const s = this.state, C = this.cfg;
    const L = this.computeLoads();
    const { M, I, rcm, W } = this.mp;
    const R = L.R;
    const sl = this.terrain.slopeAt(s.P[0], s.P[1]);
    const sMag = Math.hypot(sl.sx, sl.sy);
    const Vw = L.Vworld;
    const fieldRate = sl.sx * Vw[0] + sl.sy * Vw[1];
    const wz = Math.sqrt(9 * this.stones[0].k / M);
    const d  = rcm[2] - (-C.c);
    const Kr = L.kY2 - W * d, Kp = L.kX2 - W * d;
    return {
      t: this._t || 0,
      state: s, R, kb: L.kb, Vw,
      M, I, rcm, W, G: this.W,
      L, Btot: L.Btot, netLift: L.netLift,
      gap: L.gapMean, gArr: L.gArr, fArr: L.fArr, kArr: L.kArr,
      clearance: s.P[2] - C.c - this.terrain.terrainM(s.P[0], s.P[1]),
      terrainM: this.terrain.terrainM(s.P[0], s.P[1]),
      fieldM: this.terrain.fieldM(s.P[0], s.P[1]),
      slope: sl, slopeMag: sMag, fieldRate,
      ceiling: this.ceiling(), delta0: this.delta0(), d,
      kX2: L.kX2, kY2: L.kY2, Kr, Kp,
      GMx: Kr / W, GMy: Kp / W,
      wz, wr: Math.sqrt(Math.max(Kr, 1) / I[0][0]), wp: Math.sqrt(Math.max(Kp, 1) / I[1][1]),
      nActive: this.stones.filter(x => !x.failed).length,
      nSaturated: L.nSaturated,
      zRef: this.zRef.slice(),
      /* 积分时实际施加的载荷（诊断用；与「当前」读数相差半步，下降中约 rate·h/2） */
      Lforce: this.loadsAtStep || L,
      ctrl: this.ctrl,
    };
  }
  placeAt(x, y, agl) {
    this.state.P = [x, y, this.terrain.fieldM(x, y) + this.cfg.c + agl];
    this.state.V = [0, 0, 0]; this.state.omega = [0, 0, 0];
    this.state.phi = 0; this.state.theta = 0; this.state.psi = 0;
    this.setpoint.pos = [x, y, 0];
    this.computeLoads(); return this.state;
  }
  resetState({ clearFailures = false } = {}) {
    this.state.V = [0, 0, 0]; this.state.omega = [0, 0, 0];
    this.state.phi = 0; this.state.theta = 0; this.state.psi = 0;
    this.ctrl = { Tv: [0, 0, 0, 0], Tapu: 0, tauBow: 0, alphaBow: 0, tauStern: 0, alphaStern: 0 };
    this.eulerWarn = false; this._apuOn = false;
    this.stiffnessFailed = false; this.diverged = false; this.frozenF = null;
    if (clearFailures) {
      this.eng.forEach(e => e.failed = false);
      this.stones.forEach(s => { s.failed = false; s.tol = 0; });
      this.apu.failed = false; this.azBow.failed = false; this.azStern.failed = false;
      this.zRefTrim.fill(0);
    }
    this.updateMassProperties(); this.computeLoads(); return this.state;
  }
  transferWater(dm) {
    dm.forEach((v, i) => {
      const t = this.tanks[i];
      t.m = clamp(t.m + v, 0, t.cap === Infinity ? 1e12 : t.cap);
    });
    this.updateMassProperties(); return dm.slice();
  }
  dumpBallast(mass) {
    const per = mass / 5, out = [];
    this.tanks.forEach(t => { const d = Math.min(t.m, per); t.m -= d; out.push(-d); });
    this.updateMassProperties(); return out;
  }
  setStone(i, { failed, tol } = {}) {
    if (failed !== undefined) this.stones[i].failed = !!failed;
    if (tol   !== undefined) this.stones[i].tol = tol;
    this.updateMassProperties(); this.computeLoads();
  }
  setEngineFailed(i, f) { this.eng[i].failed = !!f; }
  setApuFailed(f) { this.apu.failed = !!f; }
  /** 刚度丧失：石头失去间隙反馈，冻结为当前开环出力 ⇒ 中性浮力体（倒立摆） */
  setStiffnessFailed(f) {
    if (f) { const L = this.computeLoads(); this.frozenF = L.fArr.slice(); }
    else this.frozenF = null;
    this.stiffnessFailed = !!f;
  }
  setWind(w) { this.cfg.windWorld = w.slice(); }
  cmdZRef(z) { this.zRefCmd = z; }

  status() {
    const A = this.diag, s = this.state, pc = x => (x / this.W * 100);
    return {
      pos: s.P.slice(), agl: A.agl, clearance: A.clearance,
      RPYdeg: [s.phi, s.theta, s.psi].map(x => x * 180 / Math.PI),
      gap: A.gap, ceiling: A.ceiling, margin: A.margin,
      BtotPct: pc(A.Btot), netLiftPct: pc(A.netLift),
      TvPct: A.Tv.map(pc), TapuPct: pc(A.Tapu || 0),
      tauPct: [pc(this.ctrl.tauBow), pc(this.ctrl.tauStern)],
      slopeMag: A.slopeMag, fieldRate: A.fieldRate,
      GMx: A.GMx, GMy: A.GMy, delta0: A.delta0,
      nActive: A.nActive, canLoseStones: A.canLoseStones,
      notes: this.advisory.notes,
    };
  }
}

module.exports = { JadeChamber, createTerrain,
                   matMul, matT, matInv, vCross, vSub, eulerToR };
module.exports.__utils = { vAdd, vSub, vMul, vDot, vLen, clamp };

/* ============================================================================
 *  物理侧自检（纯物理，不含控制）
 *  完整演示（含自动驾驶与驾驶舱逻辑）见 flight-control.js
 * ========================================================================== */
if (require.main === module) {
  const n1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const n2 = x => (Math.round(x * 100) / 100).toFixed(2);
  const jc = new JadeChamber({ terrain: { preset: 'flat' } });
  console.log('══════════ 群玉阁 · 物理侧（不含控制） ══════════');
  console.log(`总重 ${(jc.mp.M / 1e3).toFixed(0)} t（石头占 ${(jc.mStone / jc.mp.M * 100).toFixed(1)}%）`);
  console.log(`λ=${jc.cfg.lambda} m  α=${jc.cfg.alpha}  δ_ref=${jc.cfg.deltaRef} m ⇒ k=${jc.stones[0].k.toExponential(2)} N/m`);
  console.log(`δ₀=${n2(jc.delta0())} m   升限=${n1(jc.ceiling())} m   渐近天花板=${n1(jc.cfg.lambda * Math.log(jc.cfg.alpha))} m`);
  const S = jc.sense();
  console.log(`重心 z=${n2(S.rcm[2])} m  d=${n2(S.d)} m  GM_roll=${n1(S.GMx)} m  GM_pitch=${n1(S.GMy)} m`);
  console.log(`垂荡 T=${n2(2 * Math.PI / S.wz)} s  滚转 T=${n2(2 * Math.PI / S.wr)} s  俯仰 T=${n2(2 * Math.PI / S.wp)} s`);
  console.log(`初始间隙 ${n1(S.gap)} m  浮力 ${n2(S.Btot / S.G * 100)}%W  净升力 ${n2(S.netLift / S.G * 100)}%W`);
  console.log('\n（无控制输入：平台保持静止，浮力自动等于重量）');
  for (let k = 0; k < 200; k++) jc.step(0.05);
  const S2 = jc.sense();
  console.log(`10 s 后：间隙 ${n1(S2.gap)} m  净升力 ${n2(S2.netLift / S2.G * 100)}%W  位置 z=${n1(jc.state.P[2])} m`);
}
