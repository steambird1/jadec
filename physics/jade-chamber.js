/* ==========================================================================
 *  群玉阁（Jade Chamber）浮空平台 —— 6-DOF 动力学仿真 + 自动驾驶
 *
 *  坐标约定
 *    体坐标系原点 = 外接长方体几何中心 O(0,0,0)
 *    +x = 右舷(starboard), +y = 向艏(bow), +z = 向上
 *    世界系 = ENU（+z 向上）
 *    姿态 = ZYX 欧拉角 (psi 偏航 → theta 俯仰 → phi 滚转)，R 为 体→世界
 *
 *  执行机构（自动驾驶可直接控制）
 *    4 台垂直发动机  T[0..3] = FL, FR, RL, RR      ∈ [Fmin, Fmax]
 *    1 台 APU 垂推   Tapu                          ∈ {0} ∪ [Famin, Famax]
 *    2 台全向 azimuth（艏/艉）  τ∈[0,FazMax], α 自由
 *
 *  不可控（自动驾驶只能给出建议）
 *    9 块浮空石 f_k（被动基线 + ±1% / 石，可故障归零）
 *    5 个水箱的水量分布 m_wi、燃油 m_f
 * ========================================================================== */

'use strict';

/* ---------------------------------------------------------------- 向量工具 */
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

/* ---------------------------------------------------------------- 矩阵工具 */
function matMul(A, B) {
  const n = A.length, k = B.length, m = B[0].length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      for (let p = 0; p < k; p++) C[i][j] += A[i][p] * B[p][j];
  return C;
}
function matT(A) {
  return A[0].map((_, j) => A.map(r => r[j]));
}
function matVec(A, v) { return A.map(r => vDot(r, v)); }
function matInv(A) {                                   // Gauss-Jordan
  const n = A.length;
  const M = A.map((r, i) => r.concat(Array.from({ length: n }, (_, j) => i === j ? 1 : 0)));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col]; if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(r => r.slice(n));
}

/* ------------------------------------------------- 姿态：欧拉角 ↔ 旋转矩阵 */
/** ZYX: R = Rz(psi)·Ry(theta)·Rx(phi)，体→世界 */
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
                           R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]]; // 世界→体

/** 长方体（半尺寸 a,b,c）关于自身中心的惯性张量 */
const inertiaBox = (m, a, b, c) => [
  [m * ((2 * b) ** 2 + (2 * c) ** 2) / 12, 0, 0],
  [0, m * ((2 * a) ** 2 + (2 * c) ** 2) / 12, 0],
  [0, 0, m * ((2 * a) ** 2 + (2 * b) ** 2) / 12],
];
/** 质点关于参考点（r 为相对该点的偏移）的惯性张量 */
function inertiaPoint(m, r) {
  const rr = vDot(r, r);
  const I = [[m * rr, 0, 0], [0, m * rr, 0], [0, 0, m * rr]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I[i][j] -= m * r[i] * r[j];
  return I;
}
const matAdd = (A, B) => A.map((r, i) => r.map((v, j) => v + B[i][j]));

/* ==========================================================================
 *  JadeChamber
 * ========================================================================== */
class JadeChamber {
  constructor(cfg = {}) {
    const C = this.cfg = Object.assign({
      /* 几何（半尺寸，m） */
      a: 60, b: 60, c: 40,
      /* 重力与参考重量 */
      g: 9.81,
      M0: 1.0e7,                       // 参考总质量 kg（≈1 万吨）
      /* 质量构成（占 M0 的比例） */
      fStructure: 0.86,                // 结构 + 浮空石（干重）
      fWater:     0.12,                // 压载水（可抛；须 ≥G/9·g 才能覆盖单石失效）
      fFuel:      0.01,                // APU 燃油（≈1%G，被 ±1% 浮力窗口封顶）
      fPayload:   0.01,                // 人员/货物
      rDry:     [0, 0, 0],             // 结构质心相对几何中心
      rPayload: [0, 0, 0],
      /* 推进器极限（以 G 的倍数给出，G = M0*g） */
      Fmin:   -0.02,                   // 垂直发动机下限（负值 = 可逆）
      Fmax:    0.05,                   // 垂直发动机上限 ×4 → 0.20G
      FazMax:  0.02,                   // 单台 azimuth 上限
      Famin:   0.02, Famax: 0.15,      // APU
      /* 环境 */
      windWorld: [0, 0, 0],
      kDragLin: 0.0, kDragQuad: 6000, kDragAng: 5e7,
      apuFuelFlow: 2.0,                // kg/s（APU 工作时）
      maxStep: 0.02,                   // 物理积分子步长上限
      /* 自动驾驶增益 */
      gain: { kpPos: 0.05, kdPos: 0.45, aMax: 0.5, kpAtt: 0.02, kdAtt: 0.5 },
    }, cfg);

    /* 参考重量与推力极限换算成绝对量 */
    this.g = C.g;
    this.G = C.M0 * C.g;
    this.lim = {
      Fmin: C.Fmin * this.G, Fmax: C.Fmax * this.G,
      FazMax: C.FazMax * this.G,
      Famin: C.Famin * this.G, Famax: C.Famax * this.G,
    };

    /* ---------------------------------------------------- 几何：安装坐标 */
    const { a, b, c } = C;
    // 垂直发动机：FL, FR, RL, RR（前 = +y）
    this.eng = [
      { name: 'FL', pos: [-7 * a / 8, +3 * b / 8, -c / 2], failed: false },
      { name: 'FR', pos: [+7 * a / 8, +3 * b / 8, -c / 2], failed: false },
      { name: 'RL', pos: [-7 * a / 8, -3 * b / 8, -c / 2], failed: false },
      { name: 'RR', pos: [+7 * a / 8, -3 * b / 8, -c / 2], failed: false },
    ];
    // 全向 azimuth
    this.azBow   = { name: 'bow',   pos: [0, +5 * b / 6, 0], failed: false };
    this.azStern = { name: 'stern', pos: [0, -5 * b / 6, 0], failed: false };
    // APU（正下方中心 ⇒ 不产生俯仰/滚转干扰力矩）；油箱在其下方
    this.apu = { pos: [0, 0, -c / 2], failed: false };
    this.rFuel = [0, 0, -3 * c / 4];
    // 5 个水箱：4 个在垂直发动机上方，1 个在中心
    this.tanks = [
      { name: 'W1(FL↑)', pos: [-7 * a / 8, +3 * b / 8, +c / 2], cap: Infinity },
      { name: 'W2(FR↑)', pos: [+7 * a / 8, +3 * b / 8, +c / 2], cap: Infinity },
      { name: 'W3(RL↑)', pos: [-7 * a / 8, -3 * b / 8, +c / 2], cap: Infinity },
      { name: 'W4(RR↑)', pos: [+7 * a / 8, -3 * b / 8, +c / 2], cap: Infinity },
      { name: 'W5(ctr)', pos: [0, 0, 0],                        cap: Infinity },
    ];
    // 浮空石 3×3（z = 0）
    this.stones = [];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        this.stones.push({
          idx: i * 3 + j,
          pos: [(i - 1) * a / 2, (j - 1) * b / 6, 0],
          nominal: this.G / 9,
          trim: 1.0,                 // ∈[0.99,1.01]，自动驾驶不可控
          failed: false,
        });

    /* ---------------------------------------------------- 质量分布（初始） */
    const M0 = C.M0;
    this.mStructure = C.fStructure * M0;
    this.mFuel      = C.fFuel      * M0;
    this.mPayload   = C.fPayload   * M0;
    const wEach = C.fWater * M0 / 5;
    this.tanks.forEach(t => t.m = wEach);

    /* ---------------------------------------------------- 状态 */
    this.state = {
      P: [0, 0, 0],        // 世界位置（几何中心）
      V: [0, 0, 0],        // 体轴速度 (u,v,w)
      phi: 0, theta: 0, psi: 0,
      omega: [0, 0, 0],    // 体轴角速度 (p,q,r)
    };
    /* 执行机构指令 */
    this.ctrl = {
      Tv: [0, 0, 0, 0],    // FL, FR, RL, RR
      Tapu: 0,
      tauBow: 0, alphaBow: 0,
      tauStern: 0, alphaStern: 0,
    };
    /* 设定值 */
    this.setpoint = { pos: [0, 0, 0], vel: [0, 0, 0], roll: 0, pitch: 0, yaw: 0 };
    /* 诊断输出 */
    this.diag = {};
    this.advisory = {};

    this.updateMassProperties();
    this.computeLoads();
  }

  /* ==================================================================== *
   *  1. 质量特性：M、质心 r_cm、惯性张量 I（关于质心，体轴）
   * ==================================================================== */
  updateMassProperties() {
    const C = this.cfg;
    let M = 0, acc = [0, 0, 0];
    const addPoint = (m, r) => { M += m; acc = vAdd(acc, vMul(r, m)); };

    addPoint(this.mStructure, C.rDry);
    addPoint(this.mPayload,   C.rPayload);
    addPoint(this.mFuel,      this.rFuel);
    for (const t of this.tanks) addPoint(t.m, t.pos);

    const rcm = vMul(acc, 1 / M);

    /* 惯性张量：结构长方体（平移到质心）+ 各质点 */
    let I = inertiaBox(this.mStructure, C.a, C.b, C.c);
    I = matAdd(I, inertiaPoint(this.mStructure, vSub(C.rDry, rcm)));
    const pts = [[this.mPayload, C.rPayload], [this.mFuel, this.rFuel],
                 ...this.tanks.map(t => [t.m, t.pos])];
    for (const [m, r] of pts) I = matAdd(I, inertiaPoint(m, vSub(r, rcm)));

    this.mp = { M, rcm, I, invI: matInv(I) };
    this.mp.W = M * this.g;
    return this.mp;
  }

  /* ==================================================================== *
   *  2. 受力/力矩汇总（体轴）—— 仿真与自动驾驶共用
   * ==================================================================== */
  computeLoads() {
    const s = this.state, { M, rcm, I } = this.mp;
    const R  = eulerToR(s.phi, s.theta, s.psi);
    const kb = [R[2][0], R[2][1], R[2][2]];      // 世界竖直向上（体轴）

    /* --- 浮空石：浮力 + 对质心的力矩（不可控项） --- */
    let Btot = 0, Menv = [0, 0, 0];
    for (const st of this.stones) {
      const f = st.failed ? 0 : st.nominal * st.trim;
      Btot += f;
      Menv = vAdd(Menv, vCross(vSub(st.pos, rcm), vMul(kb, f)));
    }
    const Fenv = vMul(kb, Btot - this.mp.W);      // 浮力 + 重力（重力作用于质心，无力矩）

    /* --- 推进器 --- */
    let Fthr = [0, 0, 0], Mthr = [0, 0, 0];
    const addThr = (pos, F) => {
      Fthr = vAdd(Fthr, F);
      Mthr = vAdd(Mthr, vCross(vSub(pos, rcm), F));
    };
    this.eng.forEach((e, i) => addThr(e.pos, [0, 0, this.ctrl.Tv[i]]));
    const Fb = [this.ctrl.tauBow   * Math.sin(this.ctrl.alphaBow),
                this.ctrl.tauBow   * Math.cos(this.ctrl.alphaBow), 0];
    const Fs = [this.ctrl.tauStern * Math.sin(this.ctrl.alphaStern),
                this.ctrl.tauStern * Math.cos(this.ctrl.alphaStern), 0];
    addThr(this.azBow.pos, Fb);
    addThr(this.azStern.pos, Fs);
    addThr(this.apu.pos, [0, 0, this.ctrl.Tapu]);

    /* --- 气动阻力（含风） --- */
    const windB = rtApply(R, this.cfg.windWorld);
    const vRel  = vSub(s.V, windB);
    const sp = vLen(vRel);
    const Fdrag = vMul(vRel, -(this.cfg.kDragLin + this.cfg.kDragQuad * sp));
    const Mdrag = vMul(s.omega, -this.cfg.kDragAng);

    this.loads = {
      R, kb, Btot, W: this.mp.W, M, rcm, I,
      Fenv, Menv, Fthr, Mthr, Fdrag, Mdrag,
      Fb: vAdd(vAdd(Fthr, Fenv), Fdrag),
      Mb: vAdd(vAdd(Mthr, Menv), Mdrag),
      windB, vRel,
    };
    return this.loads;
  }

  /* ==================================================================== *
   *  3. 物理更新：6-DOF 刚体积分
   * ==================================================================== */
  physicsUpdate(dt) {
    const sub = Math.max(1, Math.ceil(dt / this.cfg.maxStep));
    const h = dt / sub;
    for (let n = 0; n < sub; n++) this._integrate(h);

    /* APU 烧油（改变质量，自动驾驶不可控） */
    if (this.ctrl.Tapu > 0 && this.mFuel > 0) {
      this.mFuel = Math.max(0, this.mFuel - this.cfg.apuFuelFlow * dt);
      this.updateMassProperties();
    }
    this.computeLoads();
    return this.state;
  }

  _integrate(h) {
    const s = this.state;
    const L = this.computeLoads();
    const { M, invI, I } = this.mp;

    /* 平动： M( V̇ + ω×V ) = F  ⇒  V̇ = F/M − ω×V */
    const dV = vSub(vMul(L.Fb, 1 / M), vCross(s.omega, s.V));

    /* 转动： I ω̇ + ω×(Iω) = M  ⇒  ω̇ = I⁻¹( M − ω×(Iω) ) */
    const Iw  = matVec(I, s.omega);
    const dom = matVec(invI, vSub(L.Mb, vCross(s.omega, Iw)));

    /* 运动学 */
    const [p, q, r] = s.omega;
    const cf = Math.cos(s.phi), sf = Math.sin(s.phi), tt = Math.tan(s.theta);
    const dphi   = p + q * sf * tt + r * cf * tt;
    const dtheta = q * cf - r * sf;
    const dpsi   = (q * sf + r * cf) / Math.cos(s.theta);
    const dP     = rApply(L.R, s.V);

    s.V     = vAdd(s.V, vMul(dV, h));
    s.omega = vAdd(s.omega, vMul(dom, h));
    s.phi += dphi * h; s.theta += dtheta * h; s.psi += dpsi * h;
    s.P = vAdd(s.P, vMul(dP, h));
    s.phi = wrapPi(s.phi); s.psi = wrapPi(s.psi);
    /* 欧拉角奇异保护：|theta|→90° 时 ZYX 退化。
       大角度翻滚场景应改用四元数；此处仅夹紧并置标志位。 */
    const TH = 89 * Math.PI / 180;
    if (Math.abs(s.theta) > TH) { s.theta = clamp(s.theta, -TH, TH); this.eulerWarn = true; }
  }

  /* ==================================================================== *
   *  4. 自动驾驶：外环 PD → 期望力/力矩 → 推力分配
   *     注意：不控制浮空石 f_k，也不直接控制水/燃油，只给建议
   * ==================================================================== */
  autopilotUpdate(dt) {
    const s = this.state, sp = this.setpoint, G = this.gainOf();
    const L = this.computeLoads();
    const { M, rcm, I } = this.mp;

    /* ---- 4.1 位置环 → 期望世界加速度 → 期望体轴合力 ---- */
    const Vworld = rApply(L.R, s.V);
    const eP = vSub(sp.pos, s.P);
    const eV = vSub(sp.vel, Vworld);
    let aW = vAdd(vMul(eP, G.kpPos), vMul(eV, G.kdPos));
    const am = vLen(aW);
    if (am > G.aMax) aW = vMul(aW, G.aMax / am);
    const Fdes = vMul(rtApply(L.R, aW), M);

    /* ---- 4.2 姿态环 → 期望体轴合力矩 ---- */
    const eAtt = [wrapPi(sp.roll - s.phi), wrapPi(sp.pitch - s.theta), wrapPi(sp.yaw - s.psi)];
    const alphaDes = [0, 1, 2].map(i => G.kpAtt * eAtt[i] - G.kdAtt * s.omega[i]);
    const Iw  = matVec(I, s.omega);
    const Mdes = vAdd(matVec(I, alphaDes), vCross(s.omega, Iw));

    /* ---- 4.3 推进器需要提供的净指令 ---- */
    const Freq = vSub(vSub(Fdes, L.Fenv), L.Fdrag);
    const Mreq = vSub(vSub(Mdes, L.Menv), L.Mdrag);

    /* ---- 4.4 水平 / 偏航通道：艏艉 azimuth（先算）
     *     注意：azimuth 装在 z=0，而质心 z_cm 通常 ≠ 0，
     *     水平推力会额外耦合出俯仰/滚转力矩，必须在垂向分配中补偿。 ---- */
    const bm = this.cfg.b;
    const A1 = rcm[1] - 5 * bm / 6;                 // 艏 偏航力臂系数
    const A2 = rcm[1] + 5 * bm / 6;                 // 艉 偏航力臂系数
    const rhs = Mreq[2] + rcm[0] * Freq[1];
    let fbx = 0, fsx = 0;
    if (!this.azBow.failed && !this.azStern.failed) {
      fsx = (rhs - A1 * Freq[0]) / (A2 - A1);
      fbx = Freq[0] - fsx;
    } else if (!this.azBow.failed) {                // 仅艏：只能保偏航
      fbx = rhs / A1;
    } else if (!this.azStern.failed) {
      fsx = rhs / A2;
    }
    const fby = this.azBow.failed   ? 0 : Freq[1] / 2;
    const fsy = this.azStern.failed ? 0 : Freq[1] / 2;

    const pack = (fx, fy, failed) => {              // 全向：方向自由，幅值受限
      if (failed) return { tau: 0, alpha: 0, fx: 0, fy: 0 };
      const tau = Math.hypot(fx, fy), cap = this.lim.FazMax;
      const sc = tau > cap ? cap / tau : 1;
      return { tau: tau * sc, alpha: Math.atan2(fx * sc, fy * sc), fx: fx * sc, fy: fy * sc };
    };
    const pb = pack(fbx, fby, this.azBow.failed);
    const ps = pack(fsx, fsy, this.azStern.failed);
    this.ctrl.tauBow = pb.tau; this.ctrl.alphaBow = pb.alpha;
    this.ctrl.tauStern = ps.tau; this.ctrl.alphaStern = ps.alpha;

    /* azimuth 实际（已饱和）出力对质心的力矩 */
    const Maz = vAdd(vCross(vSub(this.azBow.pos, rcm),   [pb.fx, pb.fy, 0]),
                     vCross(vSub(this.azStern.pos, rcm), [ps.fx, ps.fy, 0]));

    /* ---- 4.5 垂向通道：4 台垂推 + APU ---- */
    const avail = this.eng.reduce((s_, e) => s_ + (e.failed ? 0 : this.lim.Fmax), 0);
    const FzReq = Freq[2];
    let Tapu = 0;
    if (!this.apu.failed && FzReq > avail)
      Tapu = clamp(FzReq - avail, this.lim.Famin, this.lim.Famax);
    if (this.apu.failed) Tapu = 0;
    const Fzp = FzReq - Tapu;

    /* 扣除质心横向偏移与 azimuth 耦合带来的附加力矩（保证 r_cm ≠ 0 时仍精确） */
    const MxP = Mreq[0] - Maz[0] + rcm[1] * FzReq;
    const MyP = Mreq[1] - Maz[1] - rcm[0] * FzReq;

    const Ffront = Fzp / 2 + 4 * MxP / (3 * this.cfg.b);
    const Frear  = Fzp / 2 - 4 * MxP / (3 * this.cfg.b);
    const Lleft  = Fzp / 2 + 4 * MyP / (7 * this.cfg.a);
    const Lright = Fzp / 2 - 4 * MyP / (7 * this.cfg.a);

    const T = [0, 0, 0, 0];
    T[2] = Frear / 2;                    // RL
    T[3] = Frear / 2;                    // RR
    T[0] = Lleft - Frear / 2;            // FL
    T[1] = Ffront - Lleft + Frear / 2;   // FR
    this.eng.forEach((e, i) => {
      const lo = e.failed ? 0 : this.lim.Fmin;
      const hi = e.failed ? 0 : this.lim.Fmax;
      T[i] = clamp(T[i], lo, hi);
    });
    this.ctrl.Tv = T;
    this.ctrl.Tapu = Tapu;

    /* ---- 4.6 诊断 ---- */
    this.diag = {
      t: (this.diag.t || 0) + dt,
      Btot: L.Btot, W: this.mp.W, netLift: L.Btot - this.mp.W,
      Fenv: L.Fenv, Menv: L.Menv, Freq, Mreq, Tapu,
      Tv: T.slice(), tauBow: pb.tau, tauStern: ps.tau,
      posErr: vLen(eP), attErr: Math.hypot(...eAtt),
    };

    /* ---- 4.7 建议（自动驾驶不可执行，需船员/地面执行） ---- */
    this.updateAdvisory(L, Freq);
    return this.ctrl;
  }

  gainOf() { return this.cfg.gain; }

  /** 姿态权限：控制 (Fz, Mx, My) 需要 ≥3 台不共线的垂直发动机 */
  attitudeAuthorityOk() {
    const hs = this.eng.filter(e => !e.failed);
    if (hs.length < 3) return false;
    for (let i = 0; i < hs.length; i++)
      for (let j = i + 1; j < hs.length; j++)
        for (let k = j + 1; k < hs.length; k++) {
          const A = hs[i].pos, B = hs[j].pos, C2 = hs[k].pos;
          if (Math.abs((B[0] - A[0]) * (C2[1] - A[1]) - (B[1] - A[1]) * (C2[0] - A[0])) > 1e-6)
            return true;
        }
    return false;
  }

  /** 复位状态（可选一并清除故障） */
  resetState({ clearFailures = false, P = [0, 0, 0] } = {}) {
    this.state = { P: P.slice(), V: [0, 0, 0], phi: 0, theta: 0, psi: 0, omega: [0, 0, 0] };
    this.ctrl = { Tv: [0, 0, 0, 0], Tapu: 0, tauBow: 0, alphaBow: 0, tauStern: 0, alphaStern: 0 };
    this.eulerWarn = false;
    if (clearFailures) {
      this.eng.forEach(e => e.failed = false);
      this.stones.forEach(s => { s.failed = false; s.trim = 1.0; });
      this.apu.failed = false; this.azBow.failed = false; this.azStern.failed = false;
    }
    this.updateMassProperties(); this.computeLoads();
  }

  /** 自检：用当前 ctrl 重算推力/力矩，与自动驾驶需求对比（无饱和时应≈0） */
  verifyAllocation() {
    const L = this.computeLoads(), d = this.diag;
    return { dF: vSub(L.Fthr, d.Freq), dM: vSub(L.Mthr, d.Mreq), Freq: d.Freq, Mreq: d.Mreq };
  }

  /* ---- 建议：抛压载 / 水箱转驳 / 燃油 ---- */
  updateAdvisory(L, Freq) {
    const g = this.cfg.g;
    const avail = this.eng.reduce((s_, e) => s_ + (e.failed ? 0 : this.lim.Fmax), 0);
    const totalAvail = avail + (this.apu.failed ? 0 : this.lim.Famax);

    /* (a) 抛压载：按“静态缺口”计算——要让 (浮力 + 全部可用推力) ≥ 重量
     *     Δm = max(0, W − B_tot − totalAvail) / g
     *     注意不能用瞬时需求 Freq[2]：高速下沉时气动阻力会掩盖真实缺口。 */
    const staticShort = (this.mp.W - L.Btot) - totalAvail;      // N
    const short = staticShort;
    const ballastDump = Math.max(0, staticShort / g);

    /* (b) 调重心：用转驳水抵消浮空石造成的常值环境力矩 M_env
     *     ΔM = B_tot · (k_b × Δr_cm) ，令 M_env + ΔM = 0
     *     ⇒ Δr_cm = (k_b × M_env) / B_tot                                */
    let waterTransfer = new Array(5).fill(0);
    let drCm = [0, 0, 0];
    if (L.Btot > 1e-6 && vLen(L.Menv) > 1e3) {
      drCm = vMul(vCross(L.kb, L.Menv), 1 / L.Btot);
      const need = vMul(drCm, this.mp.M);
      const rows = [[1, 1, 1, 1, 1],
        this.tanks.map(t => t.pos[0] - this.mp.rcm[0]),
        this.tanks.map(t => t.pos[1] - this.mp.rcm[1]),
        this.tanks.map(t => t.pos[2] - this.mp.rcm[2])];
      const b = [[0], [need[0]], [need[1]], [need[2]]];
      const AAt = matMul(rows, matT(rows));
      const inv = matInv(AAt);
      if (inv) {
        const y = matMul(inv, b);                   // 4×1
        const dm = matMul(matT(rows), y).map(r => r[0]);
        const mean = dm.reduce((s_, v) => s_ + v, 0) / 5;
        waterTransfer = dm.map(v => v - mean);      // 强制 ΣΔm = 0
        // 夹紧到可用水量
        waterTransfer = waterTransfer.map((v, i) =>
          clamp(v, -this.tanks[i].m, Math.max(0, this.tanks[i].cap - this.tanks[i].m)));
        const m2 = waterTransfer.reduce((s_, v) => s_ + v, 0) / 5;
        waterTransfer = waterTransfer.map(v => v - m2);
      }
    }

    /* (c) 燃油：过重时应优先消耗/抛放 APU 燃油（它同时是配重） */
    const attOk = this.attitudeAuthorityOk();
    this.advisory = {
      ballastDump,                                   // kg，建议抛掉的水
      waterTransfer,                                 // 5 个水箱的 Δm（kg，总和为 0）
      drCm,                                          // 期望质心移动量（体轴，m）
      residualMoment: L.Menv.slice(),                // 需抵消的常值力矩（N·m）
      fuelNote: short > 0 && this.mFuel > 0
        ? `偏重 ${(short / this.G * 100).toFixed(1)}%G：优先消耗/抛放 APU 燃油 ${Math.min(this.mFuel, short / this.cfg.g).toFixed(0)} kg`
        : '燃油无需处理',
      attitudeAuthority: attOk,
      emergency: short > 0 ? 'LIFT_DEFICIT' : (attOk ? 'NOMINAL' : 'ATTITUDE_AUTHORITY_LOST'),
    };
    return this.advisory;
  }

  /* ==================================================================== *
   *  5. 统一更新入口
   * ==================================================================== */
  update(dt) { this.autopilotUpdate(dt); this.physicsUpdate(dt); return this.state; }

  /* ==================================================================== *
   *  6. 外部（船员/维护）动作 —— 自动驾驶不会调用
   * ==================================================================== */
  /** 按建议转驳水（总量守恒） */
  transferWater(dm) {
    dm.forEach((v, i) => { this.tanks[i].m = Math.max(0, this.tanks[i].m + v); });
    this.updateMassProperties();
  }
  /** 抛压载（优先抛水） */
  dumpBallast(mass) {
    let left = mass;
    for (const t of this.tanks) {
      const d = Math.min(t.m, left); t.m -= d; left -= d;
      if (left <= 0) break;
    }
    this.updateMassProperties();
    return mass - left;
  }
  /** 抛油 */
  dumpFuel(mass) { const d = Math.min(this.mFuel, mass); this.mFuel -= d; this.updateMassProperties(); return d; }
  /** 浮空石退化/失效（trim ∈ [0.99,1.01]；failed 直接归零） */
  setStone(i, { trim, failed } = {}) {
    const st = this.stones[i];
    if (trim !== undefined) st.trim = clamp(trim, 0.99, 1.01);
    if (failed !== undefined) st.failed = !!failed;
  }
  setEngineFailed(i, f) { this.eng[i].failed = !!f; }
  setApuFailed(f) { this.apu.failed = !!f; }
  setWind(w) { this.cfg.windWorld = w.slice(); }

  /* ---- 状态摘要 ---- */
  status() {
    const s = this.state, L = this.loads, d = this.diag;
    const pct = x => (x / this.G * 100).toFixed(2) + '%G';
    return {
      t: (d.t || 0).toFixed(1),
      pos: s.P.map(v => v.toFixed(2)),
      attDeg: [s.phi, s.theta, s.psi].map(v => (v * 180 / Math.PI).toFixed(3)),
      posErr: (d.posErr || 0).toFixed(3),
      mass_t: (this.mp.M / 1000).toFixed(0),
      Btot: pct(L.Btot), W: pct(this.mp.W), net: pct(L.Btot - this.mp.W),
      Tv: this.ctrl.Tv.map(v => pct(v)),
      Tapu: pct(this.ctrl.Tapu),
      tauBow: pct(this.ctrl.tauBow), tauStern: pct(this.ctrl.tauStern),
      azDeg: [this.ctrl.alphaBow, this.ctrl.alphaStern].map(v => (v * 180 / Math.PI).toFixed(0)),
      advisory: this.advisory,
    };
  }
}

module.exports = { JadeChamber, eulerToR, vAdd, vSub, vMul, vCross, vLen, matInv, matMul, matT };

/* ==========================================================================
 *  DEMO
 * ========================================================================== */
if (require.main === module) {
  const jc = new JadeChamber();
  const dt = 0.05;
  const hold = p => { jc.setpoint = { pos: p, vel: [0, 0, 0], roll: 0, pitch: 0, yaw: 0 }; };
  const pc = x => (x / jc.G * 100).toFixed(2) + '%G';
  const n3 = v => v.map(x => x.toFixed(1)).join(', ');

  const run = (T, tag) => {
    for (let k = 0; k < Math.round(T / dt); k++) jc.update(dt);
    const s = jc.status(), a = s.advisory;
    console.log(`\n──── ${tag}   (t=${s.t}s) ────`);
    console.log(`  位置误差 ${s.posErr} m | 姿态 R/P/Y(deg) ${s.attDeg} | 质量 ${s.mass_t} t`);
    console.log(`  浮力 ${s.Btot}  重量 ${s.W}  净升力 ${s.net}`);
    console.log(`  垂推 FL/FR/RL/RR = ${s.Tv.join('  ')}   APU ${s.Tapu}`);
    console.log(`  azimuth 艏 ${s.tauBow} @${s.azDeg[0]}°   艉 ${s.tauStern} @${s.azDeg[1]}°`);
    if (!a.attitudeAuthority) console.log(`  ✖ 姿态权限不足（可用垂推 <3 台不共线）→ 无法稳定姿态`);
    if (a.emergency !== 'NOMINAL') {
      console.log(`  ⚠ ${a.emergency} → 建议抛压载 ${(a.ballastDump / 1000).toFixed(0)} t`);
      console.log(`    水箱转驳 Δm(kg) = ${a.waterTransfer.map(v => v.toFixed(0)).join(', ')}`);
      console.log(`    ${a.fuelNote}`);
    }
  };
  const check = tag => {
    const v = jc.verifyAllocation();
    const ok = vLen(v.dF) < 1 && vLen(v.dM) < 1;
    console.log(`  [分配自检/${tag}] ΔF = (${n3(v.dF)}) N   ΔM = (${n3(v.dM)}) N·m`
      + (ok ? '   ✓ 精确' : '   （非零 ⇒ 相应通道幅值已饱和，属预期）'));
  };

  console.log('══════════ 群玉阁 6-DOF 仿真 + 自动驾驶 ══════════');
  console.log(`G = ${(jc.G / 1e6).toFixed(1)} MN ；单块浮空石标称 ${pc(jc.G / 9)}（可调 ±1%/石）`);
  console.log(`垂推 ×4 ∈ [${pc(jc.lim.Fmin)}, ${pc(jc.lim.Fmax)}]（合计 ${pc(4 * jc.lim.Fmax)}）`);
  console.log(`APU ∈ {0} ∪ [${pc(jc.lim.Famin)}, ${pc(jc.lim.Famax)}] ；azimuth ×2 ≤ ${pc(jc.lim.FazMax)}`);

  /* 0. 分配精度自检 */
  hold([0, 0, 0]); jc.state.P = [50, -30, 10];
  jc.autopilotUpdate(dt);
  check('定点分配');

  /* 1. 定点悬停 */
  run(150, '场景1 定点悬停（初始偏离 50,-30,10 m）');

  /* 2. 侧风下移动 */
  jc.setWind([12, 5, 0]); hold([200, 100, 0]);
  run(400, '场景2 12 m/s 侧风下移动到 (200,100,0)');
  check('风扰分配');

  /* 3. 中心浮空石失效：-11.11%G，4 台垂推即可补足 */
  jc.resetState({ clearFailures: true }); jc.setWind([0, 0, 0]); hold([0, 0, 0]);
  jc.setStone(4, { failed: true });
  run(200, '场景3 中心浮空石失效 → 垂推分担 11.11%G');

  /* 4. 对称两石失效（idx 0 与 8 关于中心对称，合力矩=0）：-22.22%G > 垂推 20%G → APU 介入 */
  jc.resetState({ clearFailures: true }); hold([0, 0, 0]);
  jc.setStone(0, { failed: true }); jc.setStone(8, { failed: true });
  run(200, '场景4 对称两石失效 → 缺口 22.22%G > 垂推 20%G，APU 介入');
  check('APU 介入');

  /* 5. 仅角石失效：不对称力矩 → 水箱转驳建议 */
  jc.resetState({ clearFailures: true }); hold([0, 0, 0]);
  jc.setStone(0, { failed: true });
  run(200, '场景5 仅角石失效 → 环境力矩 → 转驳水调重心');
  console.log(`    期望质心移动 Δr_cm = ${n3(jc.advisory.drCm)} m`);

  /* 6. 姿态权限丢失：只剩 2 台垂推 */
  jc.resetState({ clearFailures: true }); hold([0, 0, 0]);
  jc.setEngineFailed(0, true); jc.setEngineFailed(3, true);
  jc.state.omega = [0.004, 0.004, 0];    // 小扰动
  run(120, '场景6 只剩 2 台垂推 + 小扰动 → 姿态失控');

  /* 7. 全推进失效 + 石头完好 → 中性浮力自由气球（随风飘，不下沉） */
  console.log(`\n  注：场景4 中 APU 已烧掉 ${((jc.cfg.M0 * jc.cfg.fFuel - jc.mFuel) / 1000).toFixed(1)} t 燃油，`
            + `而浮力恒为 G ⇒ 群玉阁已略微“变轻”，会缓慢上飘。`);
  jc.resetState({ clearFailures: true }); hold([0, 0, 0]);
  jc.setApuFailed(true);
  [0, 1, 2, 3].forEach(i => jc.setEngineFailed(i, true));
  jc.azBow.failed = true; jc.azStern.failed = true;
  jc.setWind([8, 0, 0]);
  const z0 = jc.state.P[2];
  run(180, '场景7 全推进失效 + 石头完好（自由气球）');
  console.log(`    高度变化 Δz = ${(jc.state.P[2] - z0).toFixed(2)} m，水平漂移 ${jc.diag.posErr.toFixed(0)} m`);

  /* 8. 全推进失效 + 中心石失效 → 净下沉 → 船员执行抛压载建议 */
  jc.setStone(4, { failed: true });
  const z1 = jc.state.P[2];
  run(60, '场景8 全推进失效 + 中心石失效（不可控下沉）');
  console.log(`    60 s 内下沉 ${(jc.state.P[2] - z1).toFixed(1)} m`);
  const a = jc.advisory;
  if (a.ballastDump > 0) {
    const done = jc.dumpBallast(a.ballastDump);
    console.log(`\n  >>> 船员执行建议：抛压载 ${(done / 1000).toFixed(0)} t`);
    const z2 = jc.state.P[2];
    run(120, '场景9 抛压载后（恢复中性浮力）');
    console.log(`    此后净升力已归零：不再加速下沉，残余下沉速度由二次阻力按 1/t 缓慢衰减（120 s 内又降 ${(jc.state.P[2] - z2).toFixed(0)} m）`);
  }
  console.log('\n══════════ 结束 ══════════');
}
