/* ============================================================================
 *  physics-bundle.mjs —— 自动生成，请勿手工编辑
 *
 *  源文件：terrain.js, jade-chamber.js, flight-control.js, instruments.js
 *  生成：node connection/browser-only/build-physics-bundle.mjs
 *
 *  这是一个极小 CommonJS 运行时 + 4 个 physics 模块。
 *  只为 Web Worker 提供 ESM 入口；Node 端仍直接 require physics/。
 * ========================================================================== */
'use strict';

const __modules = new Map();
const __cache = new Map();

function __require(id) {
  let key = String(id);
  if (!key.startsWith('.')) key = './' + key;
  if (!key.endsWith('.js')) key += '.js';
  if (__cache.has(key)) return __cache.get(key).exports;
  const factory = __modules.get(key);
  if (!factory) throw new Error('[physics-bundle] module not found: ' + key);
  const module = { exports: {} };
  __cache.set(key, module);
  factory(module, module.exports, __require);
  return module.exports;
}


/* ==================== physics/terrain.js ==================== */
__modules.set("./terrain.js", function (module, exports, require) {
/* ============================================================================
 *  terrain.js —— 地形数据与「场参考面」管理
 *
 *  对外主接口（题目要求）：
 *      elevationFt(xNM: number, yNM: number) => number      // 地形高度，单位 ft
 *          xNM, yNM 为水平坐标，单位海里（NM）
 *
 *  物理模型（与 jade-chamber 的两尺度浮空场配套）：
 *      真实地形      T(x,y)     —— 由 elevationFt 换算而来（ft → m）
 *      场参考面      S(x,y)     —— T 的「锥形膨胀」(cone dilation)，
 *                                  即满足 S ≥ T 且 |∇S| ≤ sMax 的**最小**曲面。
 *      含义：屏蔽场沿地表起伏，但不完全贴合——
 *            · 平缓处      S = T
 *            · 尖峰处      S 把峰「抹宽」成坡度 sMax 的圆锥
 *            · 窄谷处      S 把谷「架桥」填平
 *      性质：S ≥ T ⇒ 间隙 gap ≤ 真实离地间隙（安全侧）
 *            |∇S| ≤ sMax ⇒ 遭遇变化率 |dS/dt| = |∇S·V| ≤ sMax·|V|
 *
 *  单位换算：1 NM = 1852 m ；1 ft = 0.3048 m
 * ========================================================================== */
'use strict';

const FT_TO_M = 0.3048;
const NM_TO_M = 1852;

/* ---------------------------------------------------------------- 地形预设 */
/* 所有预设均以 (NM, NM) → ft 书写。
 * 设计原则：大部分区域坡度 < sMax(0.04) ⇒ S≈T；少数陡峭地貌才触发「锥形抹宽」。
 *   （坡度参考：幅值 A(ft)·0.3048 m、波长 L(NM)·1852 m ⇒ 坡度 ≈ 2π·A·0.3048/(L·1852)） */
const PRESETS = {
  /** 平原 */
  flat: () => 0,

  /** 海面（恒为 0） */
  sea: () => 0,

  /** 缓丘：主波幅 110 ft / 波长 3 NM ⇒ 坡度 ≈0.038（≈sMax）；次波 25 ft / 1.7 NM ⇒ ≈0.015
   *  合计局部可达 ~0.053 ⇒ 最陡处会有少量架桥 */
  hills: (xNM, yNM) =>
    110 * Math.sin(2 * Math.PI * xNM / 3.0) * Math.cos(2 * Math.PI * yNM / 3.7)
  + 25 * Math.sin(2 * Math.PI * (xNM + yNM) / 1.7),

  /** 恒定缓坡（y 越大越高）——用于验证「自动倾斜 = 坡度」。
   *  取 0.037 而非 0.04：3×3 chamfer 为各向异性，轴向可达坡度 ≈0.925·sMax */
  ramp: (xNM, yNM) => 0.037 * yNM * NM_TO_M / FT_TO_M,

  /** 走向 x 的长山脊（高斯横截面）：峰高 1200 ft、半宽 0.35 NM ⇒ 极陡，被抹宽成锥 */
  ridge: (xNM, yNM) =>
    1200 * Math.exp(-(yNM * yNM) / (2 * 0.35 * 0.35)) *
           (1 + 0.15 * Math.sin(2 * Math.PI * xNM / 2.3)),

  /** 孤立尖峰：高 1800 ft、半宽 0.25 NM（用于验证「锥形抹宽」） */
  peak: (xNM, yNM) =>
    1800 * Math.exp(-((xNM - 0.8) ** 2 + (yNM - 0.5) ** 2) / (2 * 0.25 * 0.25)),

  /** 璃月外海：南面海(0)、中部港口平地、北部群山（陡，被抹宽）
   *  yNM < -0.6：海； -0.6…0.4：港口缓丘； yNM > 0.8：山 */
  liyue: (xNM, yNM) => {
    if (yNM < -0.6) return 0;                                    // 海
    const land = Math.min(1, Math.max(0, (yNM + 0.6) / 0.5));      // 岸线过渡
    const mtn  = 1500 * Math.exp(-((yNM - 1.6) ** 2) / (2 * 0.5 ** 2))
                     * (1 + 0.25 * Math.sin(2 * Math.PI * xNM / 2.1));
    const hill = 90 * Math.sin(2 * Math.PI * (xNM + 0.4) / 2.6)
                    * Math.cos(2 * Math.PI * (yNM - 0.2) / 1.9);
    return land * Math.max(0, mtn + hill);
  },
};

/* ------------------------------------------------------ 锥形膨胀（cone dilation） */
/**
 * 求最小 s-Lipschitz 优函数： S(p) = max_q ( T(q) − s·|p−q| )
 * 用 8 邻域 chamfer 距离（最优 3×3 权重 a=0.9619, b=1.3604，保证低估欧氏距离
 * ⇒ 结果严格满足 |∇S| ≤ s），以 raster / antiraster 交替扫描迭代至不动点。
 */
function coneDilate(T, nx, ny, h, s, { maxIter = 400, tol = 1e-5 } = {}) {
  /* 最优 3×3 chamfer (0.9619,1.3604) 在部分方向会**高估**欧氏距离（+3.86%），
     整体除以 1.04 后严格低估 ⇒ 结果保证 |∇S| ≤ s */
  const A = 0.9619 / 1.04, Bc = 1.3604 / 1.04;
  const d1 = s * h * A, d2 = s * h * Bc;
  const S = Float64Array.from(T);
  const idx = (i, j) => j * nx + i;
  let iters = 0;
  for (; iters < maxIter; iters++) {
    let chg = 0;
    /* raster（左上 → 右下）：只取已更新的「后向」邻居 */
    for (let j = 0; j < ny; j++) {
      const hasUp = j > 0, hasDn = j < ny - 1;
      for (let i = 0; i < nx; i++) {
        const k = idx(i, j); const v = S[k]; let bv = v;
        if (i > 0)        { const c = S[idx(i - 1, j)] - d1; if (c > bv) bv = c; }
        if (hasUp) {
          const c = S[idx(i, j - 1)] - d1; if (c > bv) bv = c;
          if (i > 0)      { const c2 = S[idx(i - 1, j - 1)] - d2; if (c2 > bv) bv = c2; }
          if (i < nx - 1) { const c2 = S[idx(i + 1, j - 1)] - d2; if (c2 > bv) bv = c2; }
        }
        if (bv > v) { const d = bv - v; if (d > chg) chg = d; S[k] = bv; }
      }
    }
    /* antiraster（右下 → 左上）：取「前向」邻居 */
    for (let j = ny - 1; j >= 0; j--) {
      const hasDn = j < ny - 1;
      for (let i = nx - 1; i >= 0; i--) {
        const k = idx(i, j); const v = S[k]; let bv = v;
        if (i < nx - 1) { const c = S[idx(i + 1, j)] - d1; if (c > bv) bv = c; }
        if (hasDn) {
          const c = S[idx(i, j + 1)] - d1; if (c > bv) bv = c;
          if (i < nx - 1) { const c2 = S[idx(i + 1, j + 1)] - d2; if (c2 > bv) bv = c2; }
          if (i > 0)      { const c2 = S[idx(i - 1, j + 1)] - d2; if (c2 > bv) bv = c2; }
        }
        if (bv > v) { const d = bv - v; if (d > chg) chg = d; S[k] = bv; }
      }
    }
    if (chg < tol) { iters++; break; }
  }
  return { S, iters };
}

/* ------------------------------------------------------------- 双线性插值 */
function bilinear(grid, nx, ny, x0, y0, h, x, y) {
  const fx = (x - x0) / h, fy = (y - y0) / h;
  let i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0) i = 0; if (j < 0) j = 0;
  if (i > nx - 2) i = nx - 2; if (j > ny - 2) j = ny - 2;
  const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j));
  const k = j * nx + i;
  return (grid[k] * (1 - tx) + grid[k + 1] * tx) * (1 - ty)
       + (grid[k + nx] * (1 - tx) + grid[k + nx + 1] * tx) * ty;
}

/* ============================================================================
 *  createTerrain
 * ========================================================================== */
function createTerrain(opts = {}) {
  const preset = opts.preset || 'flat';
  const fn = PRESETS[preset];
  if (!fn) throw new Error(`unknown terrain preset: ${preset}`);

  const sMax = opts.sMax ?? 0.04;                 // 场参考面的坡度上限
  const h    = opts.h    ?? 25;                   // 网格间距 m
  const x0 = opts.x0 ?? -8000, x1 = opts.x1 ?? 8000;
  const y0 = opts.y0 ?? -8000, y1 = opts.y1 ?? 8000;

  /* ---- 题目要求的接口： (xNM, yNM) → ft ---- */
  const elevationFt = (xNM, yNM) => fn(xNM, yNM);
  /* ---- 米制便捷接口 ---- */
  const elevationM = (x, y) => elevationFt(x / NM_TO_M, y / NM_TO_M) * FT_TO_M;

  /* ---- 网格化真实地形 ---- */
  const nx = Math.round((x1 - x0) / h) + 1;
  const ny = Math.round((y1 - y0) / h) + 1;
  const T = new Float64Array(nx * ny);
  let tMin = Infinity, tMax = -Infinity;
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * h;
    for (let i = 0; i < nx; i++) {
      const v = elevationM(x0 + i * h, y);
      T[j * nx + i] = v;
      if (v < tMin) tMin = v; if (v > tMax) tMax = v;
    }
  }

  /* ---- 锥形膨胀得到场参考面 S ---- */
  const t0 = Date.now();
  const { S, iters } = coneDilate(T, nx, ny, h, sMax);
  const buildMs = Date.now() - t0;

  /* ---- S 的梯度（中心差分，供坡度前馈/遭遇率计算） ---- */
  const GX = new Float64Array(nx * ny), GY = new Float64Array(nx * ny);
  let sMagMax = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const ip = Math.min(nx - 1, i + 1), im = Math.max(0, i - 1);
      const jp = Math.min(ny - 1, j + 1), jm = Math.max(0, j - 1);
      const dx = (ip - im) * h, dy = (jp - jm) * h;
      const gx = (S[j * nx + ip] - S[j * nx + im]) / dx;
      const gy = (S[jp * nx + i] - S[jm * nx + i]) / dy;
      GX[k] = gx; GY[k] = gy;
      const m = Math.hypot(gx, gy); if (m > sMagMax) sMagMax = m;
    }
  }

  /* ---- 查询函数 ---- */
  const fieldM   = (x, y) => bilinear(S, nx, ny, x0, y0, h, x, y);
  const terrainM = (x, y) => bilinear(T, nx, ny, x0, y0, h, x, y);
  const slopeAt  = (x, y) => ({
    sx: bilinear(GX, nx, ny, x0, y0, h, x, y),
    sy: bilinear(GY, nx, ny, x0, y0, h, x, y),
  });

  /** 平台以水平速度 (vx,vy) 移动时，场参考面的遭遇变化率 dS/dt (m/s) */
  const fieldRate = (x, y, vx, vy) => {
    const s = slopeAt(x, y);
    return s.sx * vx + s.sy * vy;
  };
  /** 真实离地间隙：平台底部高度 z 减去真实地形 */
  const clearanceM = (x, y, z) => z - terrainM(x, y);
  /** 到场参考面的间隙 */
  const gapToFieldM = (x, y, z) => z - fieldM(x, y);

  return {
    preset, sMax, h, x0, x1, y0, y1, nx, ny,
    /* 接口 */
    elevationFt, elevationM,
    fieldM, terrainM, slopeAt, fieldRate, clearanceM, gapToFieldM,
    /* 网格（调试/绘图用） */
    grid: { T, S, GX, GY },
    /* 统计 */
    stats() {
      let sMin = Infinity, sMaxV = -Infinity, bridged = 0, maxBridge = 0;
      for (let k = 0; k < T.length; k++) {
        const d = S[k] - T[k];
        if (d > 1e-6) { bridged++; if (d > maxBridge) maxBridge = d; }
        if (S[k] < sMin) sMin = S[k]; if (S[k] > sMaxV) sMaxV = S[k];
      }
      return {
        preset, nx, ny, h, iters, buildMs,
        terrainMinM: tMin, terrainMaxM: tMax,
        fieldMinM: sMin, fieldMaxM: sMaxV,
        gradMax: sMagMax, gradLimit: sMax,
        bridgedCells: bridged, maxBridgeM: maxBridge,
      };
    },
  };
}

module.exports = { createTerrain, PRESETS, FT_TO_M, NM_TO_M, coneDilate };

/* ============================================================================
 *  自检（node terrain.js）
 * ========================================================================== */
if (require.main === module) {
  console.log('════ terrain.js 自检 ════\n');
  for (const p of ['flat', 'hills', 'ramp', 'ridge', 'peak', 'liyue']) {
    const t = createTerrain({ preset: p, sMax: 0.04, h: 20,
                              x0: -8000, x1: 8000, y0: -8000, y1: 8000 });
    const s = t.stats();
    console.log(`【${p.padEnd(6)}】网格 ${s.nx}×${s.ny} (h=${s.h}m)  扫描 ${s.iters} 次  ${s.buildMs} ms`);
    console.log(`   地形 ${s.terrainMinM.toFixed(1)} … ${s.terrainMaxM.toFixed(1)} m`
      + `   场 ${s.fieldMinM.toFixed(1)} … ${s.fieldMaxM.toFixed(1)} m`);
    /* 说明：节点中心差分是保守口径，在锥形折线(kink)处会略偏大；
       物理使用的是双线性插值梯度（下方抽样检验）。chamfer 各向异性
       导致轴向可达坡度 ≈0.925·sMax。 */
    console.log(`   |∇S|max(节点中心差分，保守) = ${s.gradMax.toFixed(4)}  (限 ${s.gradLimit})  `
      + `${s.gradMax <= s.gradLimit * 1.10 ? '✓ 满足(≤1.10×)' : '✗ 超限'}`);
    console.log(`   架桥格数 ${s.bridgedCells}  最大架桥 ${s.maxBridgeM.toFixed(1)} m`);
    // 采样若干点，验证 S ≥ T 与坡度
    let viol = 0, steep = 0;
    for (let n = 0; n < 4000; n++) {
      const x = -3800 + Math.random() * 7600, y = -3800 + Math.random() * 7600;
      if (t.fieldM(x, y) < t.terrainM(x, y) - 1e-6) viol++;
      const g = t.slopeAt(x, y);
      if (Math.hypot(g.sx, g.sy) > 0.0401) steep++;
    }
    console.log(`   抽样 4000 点: S<T 违例 ${viol}，坡度超限 ${steep}`);
    // 接口单位检查
    console.log(`   elevationFt(1,0) = ${t.elevationFt(1, 0).toFixed(1)} ft`);
    console.log('');
  }
  /* 尖峰被抹宽的定量验证 */
  const t = createTerrain({ preset: 'peak', sMax: 0.04, h: 20, x0: -2000, x1: 4000, y0: -2000, y1: 4000 });
  const cxm = 0.8 * NM_TO_M, cym = 0.5 * NM_TO_M;
  console.log('【peak】沿 x 过峰心的 S 剖面（验证锥形抹宽，坡度应 ≈0.04）:');
  for (let d = 0; d <= 2000; d += 250) {
    const z = t.fieldM(cxm + d, cym);
    console.log(`   x偏移 ${String(d).padStart(4)} m: S=${z.toFixed(1)} m`);
  }
  const z0 = t.fieldM(cxm, cym), z1 = t.fieldM(cxm + 100, cym);
  console.log(`   峰顶附近实测坡度 = ${Math.abs(z1 - z0) / 100 < 0.041 ? '≈' : '='} ${(Math.abs(z1 - z0) / 100).toFixed(4)}`);
}

});

/* ==================== physics/jade-chamber.js ==================== */
__modules.set("./jade-chamber.js", function (module, exports, require) {
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

});

/* ==================== physics/flight-control.js ==================== */
__modules.set("./flight-control.js", function (module, exports, require) {
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

  /* ================================================================== *
   *  前向预测（仪表用）：gapAt(t) / predictTrack(d, V, terrain)
   *
   *  ★ 单一真相源：S 曲线的 τ / 速率限 / jerk 限幅只在这里实现一次。
   *    仪表层（instruments.js）禁止二次实现，否则会与本体走偏。
   * ================================================================== */

  /**
   * 预测未来 t 秒后的间隙 gap（集体分量，索引 0）。
   * 从当前活状态 (zRef, rate, acc) 出发，用与 rateFor 相同的约束前向积分。
   * @param t        前瞻时间 s
   * @param target   目标 zRef（集体）；null ⇒ 用 fc.panel 的当前目标
   * @param mode     'normal' | 'emergency'
   * @param ceiling  当前升限 m
   * @param current  当前 zRef（集体值）
   * @param step     积分步长 s
   * @returns { gap, zRef, rate, acc }  gap = zRef − δ₀
   */
  gapAt(t, { target = null, mode = 'normal', ceiling = Infinity, current = null,
             step = 0.5, delta0 = 0.3 } = {}) {
    const C = this.cfg, aMax = this.aMax, rateLim = C.rateLim, jMax = this.jMax;
    const cur0 = current != null ? current : (this._cur0 || 0);
    const tgt0 = target != null ? target : (this._tgt0 != null ? this._tgt0 : cur0);
    /* 升限保护（与 rateFor 一致，只限集体分量） */
    const cap = ceiling - C.ceilingMargin;
    const tgt = Math.min(tgt0, cap);
    let z = cur0, v = this.rate[0], a = this.acc[0];
    const n = Math.max(1, Math.round(t / step));
    for (let i = 0; i < n; i++) {
      const err = tgt - z;
      let rDes;
      if (mode === 'emergency') {
        const stop = Math.sqrt(2 * aMax * Math.abs(err));
        rDes = Math.sign(err) * Math.min(rateLim, stop);
      } else {
        rDes = clamp(err / C.tauS, -rateLim, rateLim);
      }
      const aNeed = (rDes - v) / step;
      a = clamp(clamp(aNeed, a - jMax * step, a + jMax * step), -aMax, aMax);
      v = clamp(v + a * step, -rateLim, rateLim);
      z += v * step;
    }
    return { gap: z - delta0, zRef: z, rate: v, acc: a };
  }

  /**
   * 沿航迹方向的预测航迹与离地（供场剖面 CRT 使用）。
   * @param dists   距离数组 m
   * @param V       水平速度 m/s（0 ⇒ 用名义速度并标记 assumed）
   * @param terrain 地形模块（提供 fieldM / terrainM / slopeAt）
   * @param pos     当前世界位置 [x, y]
   * @param dir     单位方向 [ux, uy]
   * @param opt     透传给 gapAt
   * @returns 每点 { d, t, T, S, excess, gap, track, clearance }
   */
  predictTrack(dists, V, terrain, pos, dir, opt = {}) {
    const nominal = opt.nominalV || 22;
    const Vuse = V > 0.5 ? V : nominal;
    const assumed = !(V > 0.5);
    return dists.map(d => {
      const t = d / Vuse;
      const x = pos[0] + dir[0] * d, y = pos[1] + dir[1] * d;
      const T = terrain.terrainM(x, y), S = terrain.fieldM(x, y);
      const sl = terrain.slopeAt(x, y);
      const g = this.gapAt(t, opt).gap;
      return {
        d, t, T, S,
        excess: S - T,                 // ≥ 0（锥形膨胀保证）
        gap: g,
        track: S + g,                  // 预测平台高度
        clearance: g + (S - T),        // 恒等式：离地 = gap + (S−T)
        slopeMag: Math.hypot(sl.sx, sl.sy),
      };
    }).concat([]).map((p, i, arr) => p);
  }

  /** 由 fc 更新活状态（供 gapAt 缺省取用） */
  syncState(currentZRef, targetZRef) { this._cur0 = currentZRef; this._tgt0 = targetZRef; }
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
    /* 供 gapAt() 缺省取用（仪表面板无需再传参） */
    this.profile.syncState(jc.zRef[0], target[0]);

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

});

/* ==================== physics/instruments.js ==================== */
__modules.set("./instruments.js", function (module, exports, require) {
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
      /* 场剖面：主轴 = 距离，量程 = 自适应 */
      profileRange: 5000, profileN: 15,         // profileRange 保留作兜底
      profileLookaheadT: 600,                   // 前瞻时间 s ⇒ 量程恒定 10 min
      profileRangeMin: 2000, profileRangeMax: 15000,
      profileNominalV: 22,                      // 保位时预测航迹的名义速度
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
   *  2.6 场剖面（三条曲线：T / S / 预测航迹）
   *
   *  ★ 主轴 = 距离（地物固定、可标航路点）；量程 = 自适应（前瞻时间恒定）
   *  ★ 预测航迹需要 gap(t)，即 S 曲线 —— 由控制层 ZRefProfile.gapAt() 提供，
   *    本层不二次实现 S 曲线（避免走偏）
   *  ★ 恒等式：clearance = gap(t) + (S − T)，且 S ≥ T ⇒ 离地 ≥ gap
   * ==================================================================== */

  /** 建议的自适应量程 */
  lookahead(v = null) {
    const C = this.cfg, jc = this.jc;
    const V = v != null ? v : 0;
    const R = Math.min(C.profileRangeMax, Math.max(C.profileRangeMin,
      Math.max(V, 0) * C.profileLookaheadT));
    const Vuse = V > 0.5 ? V : C.profileNominalV;
    return {
      rangeM: R, lookaheadT: C.profileLookaheadT,
      V: V, lookaheadV: Vuse,
      assumedV: !(V > 0.5),                 // 保位时用名义速度，须文字标注
      actualT: V > 0.5 ? R / V : Infinity,
      rangeMin: C.profileRangeMin, rangeMax: C.profileRangeMax,
      nominalV: C.profileNominalV,
      note: V > 0.5
        ? `自适应量程 ${(R / 1000).toFixed(1)} km / ${C.profileLookaheadT} s`
        : `保位：量程取下限 ${(C.profileRangeMin / 1000).toFixed(0)} km，`
          + `航迹预测按名义 V=${C.profileNominalV} m/s（须标注）`,
    };
  }

  fieldProfile(S = null, opt = {}) {
    if (!S) S = this.sense();
    const jc = this.jc, s = S.state, C = this.cfg;
    const v = Math.hypot(S.Vw[0], S.Vw[1]);
    let dir, dirSrc;
    if (opt.dirDeg != null) { dir = opt.dirDeg / DEG; dirSrc = '指定方位（规划用）'; }
    else if (v > 0.5) { dir = Math.atan2(S.Vw[0], S.Vw[1]); dirSrc = '航迹方向'; }
    else { dir = s.psi; dirSrc = '艏向（保位）'; }
    const ux = Math.sin(dir), uy = Math.cos(dir);

    const la = this.lookahead(v);
    const R = opt.rangeM != null ? opt.rangeM : la.rangeM;
    const n = opt.n != null ? opt.n : C.profileN;
    const dists = [];
    for (let i = 0; i < n; i++) dists.push(R * i / (n - 1));

    const pos = [s.P[0], s.P[1]];
    const pr = this.fc ? this.fc.profile : null;
    const emerg = this.fc ? !!this.fc.cfg.emergencyDescent : false;
    const optG = {
      mode: emerg ? 'emergency' : 'normal',
      ceiling: S.ceiling,
      current: jc.zRef[0],
      target: this.fc ? this.fc._zRefTarget ? this.fc._zRefTarget(S)[0] : null : null,
      delta0: S.delta0,
      nominalV: C.profileNominalV,
    };

    let pts;
    if (pr) {
      /* 控制层单一真相源：同 τ / 速率限 / jerk 限幅 */
      pts = pr.predictTrack(dists, v, jc.terrain, pos, [ux, uy], optG);
    } else {
      /* 无控制层：退化为准静态（gap 不变），仍标出 S−T */
      const Vuse = v > 0.5 ? v : C.profileNominalV;
      pts = dists.map(d => {
        const x = pos[0] + ux * d, y = pos[1] + uy * d;
        const T = jc.terrain.terrainM(x, y), Fd = jc.terrain.fieldM(x, y);
        const sl = jc.terrain.slopeAt(x, y);
        const g = S.gap;
        return { d, t: d / Vuse, T, S: Fd, excess: Fd - T, gap: g,
                 track: Fd + g, clearance: g + (Fd - T),
                 slopeMag: Math.hypot(sl.sx, sl.sy) };
      });
    }

    const minClear = Math.min(...pts.map(p => p.clearance));
    const minEx = Math.min(...pts.map(p => p.excess));
    const iMinC = pts.indexOf(pts.find(p => p.clearance === minClear));
    const iMinE = pts.indexOf(pts.find(p => p.excess === minEx));
    return {
      dirDeg: brg(dir * DEG),
      /* ★ 建议的自适应量程 */
      rangeM: R, lookaheadT: la.lookaheadT, lookaheadV: la.lookaheadV,
      assumedV: la.assumedV, actualT: la.actualT,
      rangeMin: la.rangeMin, rangeMax: la.rangeMax, nominalV: la.nominalV,
      lookaheadNote: la.note,
      dirSrc, V: v,
      points: pts,
      /* 分组：terrain / field / clearance */
      terrain: { minClearance: minClear, atD: pts[iMinC].d,
                 lowAhead: minClear < this.cfg.clearanceWarn },
      field:   { minExcess: minEx, atD: pts[iMinE].d,
                 maxSlopeMag: Math.max(...pts.map(p => p.slopeMag)),
                 sRateMax: Math.max(...pts.map(p => p.slopeMag)) * la.lookaheadV },
      clearance: { min: minClear, atD: pts[iMinC].d,
                   /* 恒等式校验：min clearance ≈ gap + min(S−T) */
                   identity: S.gap + minEx,
                   gapFloor: S.gap },
      kinds: ['T 真实地形', 'S 场参考面', 'S+gap(t) 预测航迹'],
      notes: [
        'clearance = gap(t) + (S−T)，S ≥ T ⇒ 离地 ≥ gap（撞地数学上不可能，只要 gap ≥ minAGL）',
        '最险处是 (S−T) 最小处（峰顶正中），不是地形最高处',
        '主轴 = 距离；量程 = 自适应 clamp(V·T_look)；时间仅作副标尺',
      ],
    };
  }
  /** 兼容旧名 */
  terrainProfile(S = this.sense(), opt = {}) { return this.fieldProfile(S, opt); }

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
    const { eta, eta95 } = this._eta(cur, target, err0, emerg, pr);
    /* ★ 当前速率 / 加速度读**活状态**（原实现返回前向模拟的终态速度，恒 ≈0） */
    const rateNow = pr.rate[0], accNow = pr.acc[0];
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
    /* 注：rateNow/accNow 已弃用 —— zRefPlan 改读 pr.rate[0]/pr.acc[0] 活状态 */
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
      fieldProfile: this.fieldProfile(S),
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

  H('场剖面（T / S / 预测航迹）');
  F('建议的自适应量程', (R.fieldProfile.rangeM / 1000).toFixed(1), 'km');
  F('  前瞻时间 T_look', R.fieldProfile.lookaheadT, 's');
  F('  当前水平速度 V', R.fieldProfile.V.toFixed(2), 'm/s');
  F('  近似巡航速度 V', R.fieldProfile.lookaheadV, 'm/s');
  F('  量程区间', `${(R.fieldProfile.rangeMin / 1000).toFixed(0)}–${(R.fieldProfile.rangeMax / 1000).toFixed(0)}`, 'km');
  F('  保位（用名义V）', R.fieldProfile.assumedV ? '是（须标注）' : '否');
  F('  实际前瞻时间', isFinite(R.fieldProfile.actualT)
    ? (R.fieldProfile.actualT / 60).toFixed(1) + ' min' : '∞（保位）');
  F('前视最小离地', R.fieldProfile.clearance.min, 'm');
  F('  出现在', (R.fieldProfile.clearance.atD / 1000).toFixed(1), 'km');
  F('前视最小 (S−T)', R.fieldProfile.field.minExcess, 'm');
  F('  出现在', (R.fieldProfile.field.atD / 1000).toFixed(1), 'km');
  F('恒等式校验 gap+min(S−T)', R.fieldProfile.clearance.identity, 'm');
  F('曲线', R.fieldProfile.kinds.join(' / '));

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

  /* ---------- 场剖面（三条曲线 / 自适应量程 / 恒等式） ---------- */
  /* A) 自适应量程：距离轴 + clamp(V·T_look) */
  {
    const j = new JadeChamber({ terrain: { preset: 'peak' } });
    const f = new FlightControl(j);
    const it = new InstrumentSuite(j, f);
    j.placeAt(-3000, 1000, 749.3 - j.delta0());
    f.panel.setKnob('SPD', 22); f.panel.setKnob('TRK', 90); f.panel.pressTRKSET();
    j.state.psi = Math.PI / 2; j.state.V = [22, 0, 0];
    for (let i = 0; i < 400; i++) f.update(0.05);
    const R = it.read();
    const FP = R.fieldProfile;
    /* 用实测 V 反推期望量程（自动驾驶已收敛到 SPD=22，但有微小残差） */
    const wantR = Math.min(15000, Math.max(2000, FP.V * 600));
    ok(near(FP.rangeM, wantR, 1e-6),
       `自适应量程 = clamp(V·600s) = ${(wantR / 1000).toFixed(1)} km`, (FP.rangeM / 1000).toFixed(1));
    ok(FP.assumedV === false && near(FP.lookaheadV, FP.V, 1e-6),
       `巡航：用实际 V=${FP.lookaheadV.toFixed(2)} m/s，名义标注关闭`);
    ok(FP.V > 21 && near(FP.actualT, FP.rangeM / FP.V, 1e-6),
       `实际前瞻 ${(FP.actualT / 60).toFixed(1)} min ≈ T_look 600 s`);
  }

  /* B) 保位 V=0 ⇒ 量程取下限 + 名义速度标注 */
  {
    const R = inst.read();
    const FP = R.fieldProfile;
    ok(near(FP.rangeM, 2000, 1e-6) && FP.assumedV === true,
       `保位：量程取下限 ${(FP.rangeM / 1000).toFixed(0)} km，预测用名义 V=${FP.lookaheadV}（须标注）`);
    ok(!isFinite(FP.actualT), '保位：实际前瞻时间 ∞（d 到不了）');
  }

  /* C) 恒等式：min clearance = gap + min(S−T)，且 ≥ gap */
  {
    const j = new JadeChamber({ terrain: { preset: 'peak' } });
    const f = new FlightControl(j);
    const it = new InstrumentSuite(j, f);
    j.placeAt(-3000, 1000, 749.3 - j.delta0());
    f.panel.setKnob('SPD', 22); f.panel.setKnob('TRK', 90); f.panel.pressTRKSET();
    j.state.psi = Math.PI / 2; j.state.V = [22, 0, 0];
    for (let i = 0; i < 400; i++) f.update(0.05);
    const R = it.read(), FP = R.fieldProfile;
    ok(near(FP.clearance.min, FP.clearance.identity, 0.5),
       `最小离地 ${FP.clearance.min.toFixed(1)} = gap + min(S−T) ${FP.clearance.identity.toFixed(1)}`);
    ok(FP.clearance.min >= FP.clearance.gapFloor - 1e-6,
       `离地 ${FP.clearance.min.toFixed(1)} ≥ gap ${FP.clearance.gapFloor.toFixed(1)}（撞地不可能）`);
    ok(FP.field.minExcess >= -1e-6, `min(S−T) = ${FP.field.minExcess.toFixed(2)} ≥ 0（S ≥ T）`);
    ok(FP.terrain.lowAhead === false,
       `前视无低离地告警（恒等式保证；告警职责归 gap/升限）`);
  }

  /* D) 最险处 = (S−T) 最小处，不是地形最高处 */
  {
    const j = new JadeChamber({ terrain: { preset: 'peak' } });
    const f = new FlightControl(j);
    const it = new InstrumentSuite(j, f);
    j.placeAt(-3000, 1000, 749.3 - j.delta0());
    f.panel.setKnob('SPD', 22); f.panel.setKnob('TRK', 90); f.panel.pressTRKSET();
    j.state.psi = Math.PI / 2; j.state.V = [22, 0, 0];
    for (let i = 0; i < 400; i++) f.update(0.05);
    const FP = it.read().fieldProfile;
    let iMaxT = 0; FP.points.forEach((p, i) => { if (p.T > FP.points[iMaxT].T) iMaxT = i; });
    ok(Math.abs(FP.field.atD - FP.clearance.atD) < FP.rangeM / (FP.points.length - 1) + 1,
       `最小离地出现在 ${(FP.clearance.atD / 1000).toFixed(1)} km = min(S−T) 处（地形最高点在 ${(FP.points[iMaxT].d / 1000).toFixed(1)} km）`);
  }

  /* E) zRefPlan 当前速率 = 活状态（原实现恒为 0） */
  {
    const j = new JadeChamber({ terrain: { preset: 'flat' } });
    const f = new FlightControl(j);
    const it = new InstrumentSuite(j, f);
    for (let i = 0; i < 200; i++) f.update(0.05);
    f.panel.setKnob('ALT', 400);
    for (let i = 0; i < 100; i++) f.update(0.05);      // 5 s，S 曲线加速段
    const R = it.read();
    ok(near(R.zRefPlan.rateNow, f.profile.rate[0], 1e-12),
       `rateNow ${R.zRefPlan.rateNow.toFixed(3)} = profile.rate[0]（活状态）`);
    ok(Math.abs(R.zRefPlan.rateNow) > 1e-3,
       `下降中速率非零 ${R.zRefPlan.rateNow.toFixed(3)} m/s（原实现恒 0）`);
    ok(near(R.zRefPlan.accNow, f.profile.acc[0], 1e-12),
       `accNow ${R.zRefPlan.accNow.toFixed(4)} = profile.acc[0]`);
  }

  /* F) Ṡ 前视最大值恒 < r_max（锥形膨胀保证） */
  {
    const j = new JadeChamber({ terrain: { preset: 'peak' } });
    const f = new FlightControl(j);
    const it = new InstrumentSuite(j, f);
    j.placeAt(-3000, 1000, 749.3 - j.delta0());
    f.panel.setKnob('SPD', 22); f.panel.setKnob('TRK', 90); f.panel.pressTRKSET();
    j.state.psi = Math.PI / 2; j.state.V = [22, 0, 0];
    for (let i = 0; i < 400; i++) f.update(0.05);
    const FP = it.read().fieldProfile;
    ok(FP.field.sRateMax <= j.cfg.rMaxField + 1e-9,
       `前视 max Ṡ ${FP.field.sRateMax.toFixed(2)} ≤ r_max ${j.cfg.rMaxField}（永不告警）`);
  }

  /* ---------- 演示 2：斜坡 ---------- */
  console.log('\n');
  const j4 = new JadeChamber({ terrain: { preset: 'ramp' } });
  const f4 = new FlightControl(j4);
  const i4 = new InstrumentSuite(j4, f4);
  j4.placeAt(0, 0, 749.3 - j4.delta0());
  for (let i = 0; i < 2400; i++) f4.update(0.05);
  console.log(render(i4, '演示 2 · 斜坡地形（FOLLOW SLOPE）'));

  /* ---------- 演示 3：朝峰顶巡航（自适应量程 + 三线剖面） ---------- */
  console.log('\n');
  const j5 = new JadeChamber({ terrain: { preset: 'peak' } });
  const f5 = new FlightControl(j5);
  const i5 = new InstrumentSuite(j5, f5);
  j5.placeAt(-3000, 1000, 749.3 - j5.delta0());
  f5.panel.setKnob('SPD', 22); f5.panel.setKnob('TRK', 90); f5.panel.pressTRKSET();
  j5.state.psi = Math.PI / 2; j5.state.V = [22, 0, 0];
  for (let i = 0; i < 400; i++) f5.update(0.05);
  /* 钉住位置与航向，使剖面沿 +x 正对峰顶（1400,1000），便于对照 */
  j5.state.P = [-3000, 1000, j5.state.P[2]];
  j5.state.V = [22, 0, 0]; j5.state.psi = 0;
  console.log(render(i5, '演示 3 · 朝峰顶巡航（自适应量程 / 三线剖面）'));
  {
    /* 显式指向峰顶（+x 方向），便于对照 —— 默认会跟随实际航迹 */
    const FP = i5.fieldProfile(null, { dirDeg: 90, rangeM: 13200 });
    const P = FP.points;
    console.log('\n  建议的自适应量程    ' + (FP.rangeM / 1000).toFixed(1) + ' km / '
      + FP.lookaheadT + ' s   前瞻时间 ' + (FP.actualT / 60).toFixed(1) + ' min');
    console.log('  近似巡航速度 V      ' + FP.lookaheadV.toFixed(1) + ' m/s'
      + (FP.assumedV ? '（名义值，须标注）' : ''));
    console.log('\n   d(km)   t(s)        T          S      S-T     gap(t)   航迹预测   离地');
    for (let k = 0; k < P.length; k += 2) {
      const p = P[k];
      console.log('  ' + (p.d / 1000).toFixed(1).padStart(5) + p.t.toFixed(1).padStart(8)
        + p.T.toFixed(1).padStart(10) + p.S.toFixed(1).padStart(10)
        + p.excess.toFixed(1).padStart(8) + p.gap.toFixed(2).padStart(10)
        + p.track.toFixed(1).padStart(10) + p.clearance.toFixed(1).padStart(9));
    }
    console.log('\n  最小离地 ' + FP.clearance.min.toFixed(1) + ' m @ '
      + (FP.clearance.atD / 1000).toFixed(1) + ' km   最小(S−T) '
      + FP.field.minExcess.toFixed(1) + ' m @ ' + (FP.field.atD / 1000).toFixed(1) + ' km');
    console.log('  恒等式校验：gap + min(S−T) = ' + FP.clearance.identity.toFixed(1) + ' m');
  }

  console.log(`\n══════ 结果：${nPass} 通过 / ${nFail} 失败 ══════`);
  process.exit(nFail ? 1 : 0);
}

});

/* ==================== ESM 出口 ==================== */
const __inst = __require('./instruments.js');
const __jc = __require('./jade-chamber.js');
const __fc = __require('./flight-control.js');

export const InstrumentSuite = __inst.InstrumentSuite;
export const JadeChamber = __jc.JadeChamber;
export const FlightControl = __fc.FlightControl;
export const CRAB_LIMITS = __fc.CRAB_LIMITS;
export const psiToBearing = __fc.psiToBearing;
export const bearingToPsi = __fc.bearingToPsi;
export const bearingVec = __fc.bearingVec;

/** SimCore 需要的依赖包 */
export const physics = {
  JadeChamber,
  FlightControl,
  InstrumentSuite,
  CRAB_LIMITS,
  psiToBearing,
};
export default physics;
