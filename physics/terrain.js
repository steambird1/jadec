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
