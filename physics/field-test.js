/*  field-test.js —— v2 两尺度模型的回归测试（带断言）
 *  运行： node field-test.js
 */
'use strict';
const { createTerrain, NM_TO_M, FT_TO_M } = require('./terrain.js');
const { JadeChamber } = require('./jade-chamber.js');
const { FlightControl, ControlPanel, ZRefProfile, CRAB_LIMITS, DEG } = require('./flight-control.js');
const deg = r => r * 180 / Math.PI;
let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  (cond ? pass++ : fail++);
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '   ' + detail : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* mk() 返回物理对象 j，并把控制层挂载上去：
 *   j.update(dt) → fc.update(dt)   j.diag → fc.diag   j.advisory → fc.advisory
 *   j.setpoint / j.cmdZRef 保留为控制层的便捷入口 */
const mk = (preset = 'flat', cfg = {}, fcfg = {}) => {
  const j = new JadeChamber(Object.assign({ terrain: { preset } }, cfg));
  const fc = new FlightControl(j, fcfg);
  j.fc = fc;
  j.update = dt => fc.update(dt);
  Object.defineProperty(j, 'diag',     { get: () => fc.diag, configurable: true });
  Object.defineProperty(j, 'advisory', { get: () => fc.advisory, configurable: true });
  Object.defineProperty(j, 'setpoint', { get: () => fc.panel, configurable: true });
  j.cmdZRef = z => { fc.panel.setKnob('ALT', z - j.delta0()); return z; };
  j.verifyAllocation = () => fc.verifyAllocation();
  fc.panel.setKnob('ALT', 749);
  return j;
};
const settle = (j, T, dt = 0.05) => { for (let k = 0; k < Math.round(T / dt); k++) j.update(dt); };

/* ══════════════════════════════════════════════ 1. 地形模块 */
console.log('\n【1】地形模块');
{
  const t = createTerrain({ preset: 'hills', sMax: 0.04 });
  /* 接口单位： (xNM,yNM) → ft */
  const xNM = 1.0, xm = xNM * NM_TO_M;
  ok('接口单位换算一致',
     near(t.elevationM(xm, 0), t.elevationFt(xNM, 0) * FT_TO_M, 1e-9),
     `elevationM=${t.elevationM(xm, 0).toFixed(3)} m`);
  /* S ≥ T（安全侧） */
  let vio = 0;
  for (let n = 0; n < 3000; n++) {
    const x = -7000 + Math.random() * 14000, y = -7000 + Math.random() * 14000;
    if (t.fieldM(x, y) < t.terrainM(x, y) - 1e-6) vio++;
  }
  ok('场参考面 S ≥ 真实地形 T（间隙恒为安全下界）', vio === 0, `违例 ${vio}/3000`);
  /* |∇S| ≤ sMax（插值后的实际使用值） */
  let steep = 0, gmax = 0;
  for (let n = 0; n < 3000; n++) {
    const x = -7000 + Math.random() * 14000, y = -7000 + Math.random() * 14000;
    const g = t.slopeAt(x, y), m = Math.hypot(g.sx, g.sy);
    gmax = Math.max(gmax, m); if (m > 0.0401) steep++;
  }
  ok('插值后 |∇S| ≤ sMax', steep === 0, `max=${gmax.toFixed(4)}，超限 ${steep}/3000`);
  /* 陡峰被锥形抹宽 */
  const tp = createTerrain({ preset: 'peak', sMax: 0.04, x0: -3000, x1: 5000, y0: -3000, y1: 5000 });
  const cx = 0.8 * NM_TO_M, cy = 0.5 * NM_TO_M;
  const zPeak = tp.fieldM(cx, cy), zOut = tp.fieldM(cx + 1500, cy);
  const effSlope = (zPeak - zOut) / 1500;
  ok('陡峰被抹宽成坡度 ≤sMax 的锥', near(zPeak, tp.terrainM(cx, cy), 1.0) && effSlope <= 0.041,
     `峰 ${zPeak.toFixed(0)} m，1.5 km 外 ${zOut.toFixed(0)} m，等效坡度 ${effSlope.toFixed(4)}`);
}

/* ══════════════════════════════════════════════ 2. 场的基本恒等式 */
console.log('\n【2】两尺度场：δ₀ = W/(9k)，升限 = λ·ln(9F₀/W)');
{
  const j = mk();
  ok('δ₀ = W/(9k) = 0.30 m', near(j.delta0(), 0.30, 1e-6), `${j.delta0().toFixed(4)} m`);
  ok('升限 = λ·ln(α·m_s/M) = 948.6 m', near(j.ceiling(), 948.6, 0.5), `${j.ceiling().toFixed(1)} m`);
  ok('渐近天花板 λ·lnα = 1497.9 m', near(500 * Math.log(20), 1497.9, 0.5));
  ok('石头占全重 1/3', near(j.mStone / j.mp.M, 1 / 3, 1e-9), `${(j.mStone / j.mp.M * 100).toFixed(1)}%`);
  /* 垂荡周期 */
  const wz = Math.sqrt(9 * j.stones[0].k / j.mp.M);
  ok('垂荡周期 T = 2π√(δ₀/g) = 1.10 s', near(2 * Math.PI / wz, 1.10, 0.02), `${(2 * Math.PI / wz).toFixed(3)} s`);
}

/* ══════════════════════════════════════════════ 3. 定点悬停：零出力 */
console.log('\n【3】平地定点悬停');
{
  const j = mk(); j.placeAt(0, 0, 749); j.cmdZRef(749.3);
  settle(j, 200);
  ok('间隙稳定在 749 m', near(j.diag.gap, 749, 0.5), `${j.diag.gap.toFixed(2)} m`);
  ok('推进器稳态零出力（阻尼器特性）',
     Math.max(...j.diag.Tv.map(Math.abs)) / j.W < 1e-3 && j.ctrl.Tapu < 1,
     `max|T|=${(Math.max(...j.diag.Tv.map(Math.abs)) / j.W * 100).toFixed(4)}%W`);
  ok('姿态保持水平', Math.abs(j.state.phi) < 1e-4 && Math.abs(j.state.theta) < 1e-4);
  ok('升限余量 199.6 m ⇒ 可再失 2 块石', near(j.diag.margin, 199.6, 1) && j.diag.canLoseStones === 2,
     `余量 ${j.diag.margin.toFixed(1)} m，可失 ${j.diag.canLoseStones} 块`);
}

/* ══════════════════════════════════════════════ 4. 地形跟随：自动倾斜 */
console.log('\n【4】飞越缓坡：自动倾斜 = 坡度（免费）');
{
  const j = mk('ramp'); j.placeAt(0, -3000, 749); j.cmdZRef(749.3);
  j.fc.panel.setKnob('SPD', 15);
  j.fc.panel.setKnob('TRK', 0); j.fc.panel.pressTRKSET();
  settle(j, 400);
  const sl = j.terrain.slopeAt(j.state.P[0], j.state.P[1]);
  const d = j.mp.rcm[2] - (-j.cfg.c);
  const BMx = 600 / (9 * j.delta0()), BMy = 5400 / (9 * j.delta0());
  const phiTh = sl.sy * BMx / (BMx - d), thTh = -sl.sx * BMy / (BMy - d);
  ok('滚转自动对准坡度（含倒立摆修正）', near(j.state.phi, phiTh, 2e-4),
     `实测 ${deg(j.state.phi).toFixed(3)}° vs 理论 ${deg(phiTh).toFixed(3)}°（坡度 ${sl.sy.toFixed(4)}）`);
  ok('俯仰同理', near(j.state.theta, thTh, 2e-4), `${deg(j.state.theta).toFixed(3)}° vs ${deg(thTh).toFixed(3)}°`);
  ok('倾斜免费：推进器仍≈零', Math.max(...j.diag.Tv.map(Math.abs)) / j.W < 5e-3,
     `max|T|=${(Math.max(...j.diag.Tv.map(Math.abs)) / j.W * 100).toFixed(3)}%W`);
  ok('间隙保持 749 m（自动跟随高度）', near(j.diag.gap, 749, 1.0), `${j.diag.gap.toFixed(2)} m`);
}

/* ══════════════════════════════════════════════ 5. 陡峰：离地间隙安全 */
console.log('\n【5】飞越陡峰：S ≥ T ⇒ 离地间隙恒 ≥ 设定值');
{
  const j = mk('peak');
  const cx = 0.8 * NM_TO_M, cy = 0.5 * NM_TO_M;
  j.placeAt(cx - 3000, cy, 749); j.cmdZRef(749.3);
  j.fc.panel.setKnob('SPD', 18);
  j.fc.panel.setKnob('TRK', 90); j.fc.panel.pressTRKSET();
  let minClr = Infinity;
  for (let k = 0; k < 8000; k++) { j.update(0.05); minClr = Math.min(minClr, j.diag.clearance); }
  ok('真实离地间隙自始至终 ≥ 间隙设定值', minClr >= 749 - 2, `min=${minClr.toFixed(1)} m`);
  ok('未触地、未翻覆', !j.diverged);
}

/* ══════════════════════════════════════════════ 6. 单石失效（弹簧区） */
console.log('\n【6】角石失效：弹簧区几乎不下沉，推进器零持续出力');
{
  const j = mk('flat', {}, { zRef: { ceilingMargin: 0 } });   // 关掉升限保护，隔离弹簧行为
  j.placeAt(0, 0, 749); j.cmdZRef(749.3);
  settle(j, 200);
  const g0 = j.diag.gap;
  j.setStone(0, { failed: true });              // 角石 (−30,−10)
  settle(j, 400);
  const sink = g0 - j.diag.gap;
  ok('下沉仅厘米级（非 v1 的 59 m 级）', sink < 0.5, `下沉 ${(sink * 100).toFixed(1)} cm`);
  ok('静倾 < 1.5°（可容忍，无需顶平）', Math.abs(deg(j.state.phi)) < 1.5,
     `φ=${deg(j.state.phi).toFixed(2)}° θ=${deg(j.state.theta).toFixed(2)}°`);
  ok('推进器持续出力≈0（倾角为静平衡，非被顶住）',
     Math.max(...j.diag.Tv.map(Math.abs)) / j.W < 5e-3,
     `max|T|=${(Math.max(...j.diag.Tv.map(Math.abs)) / j.W * 100).toFixed(3)}%W`);
  ok('新升限 889.7 m（v1 的「11%G 缺口」不再出现）', near(j.ceiling(), 889.7, 1), `${j.ceiling().toFixed(1)} m`);
  ok('无抛压载建议', j.advisory.ballastDump < 1, `${(j.advisory.ballastDump / 1000).toFixed(1)} t`);
}

/* ══════════════════════════════════════════════ 7. 阻尼（无场阻尼，靠推进器） */
console.log('\n【7】主动阻尼：ζ=0.1 ⇒ 1.7 s 衰减');
{
  const j = mk(); j.placeAt(0, 0, 749); j.cmdZRef(749.3);
  settle(j, 100);
  j.state.P[2] += 0.30;                          // 3 dm 垂荡扰动（= δ₀）
  let peak = 0, t = 0; const dt = 0.02;
  const g0 = j.diag.gap;
  for (let k = 0; k < Math.round(60 / dt); k++) {
    j.update(dt); t += dt;
    peak = Math.max(peak, Math.abs(j.diag.FzReq));
  }
  ok('扰动被吸收，回到 749 m', near(j.diag.gap, g0, 0.02), `${j.diag.gap.toFixed(3)} m`);
  ok('阻尼峰值力在 20%G 权限内', peak / j.W < 0.20, `峰值 ${(peak / j.W * 100).toFixed(2)}%W`);
}

/* ══════════════════════════════════════════════ 8. 升限是硬屏障 */
console.log('\n【8】升限：不是「飞不高」，而是「飞到就翻」');
{
  /* 8a. 升限保护 ON（默认）：命令 1400 m 会被限幅 ⇒ 安全 */
  const j = mk(); j.placeAt(0, 0, 749); j.cmdZRef(1400);
  j.state.omega = [0.002, 0, 0];
  let minGM = Infinity;
  for (let k = 0; k < Math.round(1200 / 0.05); k++) { j.update(0.05); minGM = Math.min(minGM, j.diag.GMx); if (j.diverged) break; }
  ok('升限保护生效：命令 1400 m 被限幅到 升限−150', j.diag.zRefLimited && !j.diverged,
     `AGL=${j.diag.agl.toFixed(1)} m（限幅目标 ${(j.ceiling() - 150).toFixed(1)}）`);
  ok('保护下 GM 始终为正', minGM > 0, `GM_roll 最低 ${minGM.toFixed(1)} m`);

  /* 8b. 关掉保护 ⇒ 爬到包络 ⇒ 刚度塌缩 ⇒ 翻覆 */
  const j2 = mk('flat', {}, { zRef: { ceilingMargin: -1e9 } });
  j2.placeAt(0, 0, 749); j2.cmdZRef(1400);
  j2.state.omega = [0.002, 0, 0];
  let t = 0, minGM2 = Infinity;
  for (let k = 0; k < Math.round(1200 / 0.05); k++) { j2.update(0.05); t += 0.05; minGM2 = Math.min(minGM2, j2.diag.GMx); if (j2.diverged) break; }
  ok('无保护：包络饱和 ⇒ 有效刚度塌缩 ⇒ GM < 0', minGM2 < 0, `过程中 GM_roll 最低 ${minGM2.toFixed(1)} m`);
  ok('无保护：最终翻覆', j2.diverged, `t=${t.toFixed(0)} s`);
  ok('实用升限（−200 m 余量）确有必要', 749 < j.ceiling() - 150);
}

/* ══════════════════════════════════════════════ 9. 刚度丧失 */
console.log('\n【9】刚度丧失：2 秒量级翻覆');
{
  const j = mk(); j.placeAt(0, 0, 749); j.cmdZRef(749.3);
  j.fc.update(0.05);
  j.setStiffnessFailed(true);
  j.state.omega = [0.002, 0, 0];
  const d = j.mp.rcm[2] - (-j.cfg.c);
  const tauTh = 1 / Math.sqrt(j.mp.W * d / j.mp.I[0][0]);
  let t = 0, tBig = null; const dt = 0.02;
  for (let k = 0; k < Math.round(180 / dt); k++) {
    j.update(dt); t += dt;
    if (!tBig && Math.abs(j.state.phi) > 0.2) tBig = t;
    if (j.diverged) break;
  }
  const tTh = tauTh * Math.log(0.2 / 0.002);
  ok('发散时间常数与理论一致', tauTh > 1.5 && tauTh < 4, `τ=${tauTh.toFixed(2)} s`);
  ok('实测到达 11.5° 的时间 ≈ 理论', tBig !== null && near(tBig, tTh, 0.35 * tTh),
     `实测 ${tBig && tBig.toFixed(1)} s vs 理论 ${tTh.toFixed(1)} s`);
  ok('推进器无法挽回', j.diverged);
}

/* ══════════════════════════════════════════════ 10. 载荷线 */
console.log('\n【10】载荷线：稳定性 vs 升限');
{
  const j = mk();
  const d = j.mp.rcm[2] - (-j.cfg.c);
  const Sy = j.stones.reduce((a, s) => a + s.pos[1] ** 2, 0);
  const crit = (Sy / 9) / d;                     // δ₀ 上限
  ok('稳定性判据 δ₀ < ⟨y²⟩/d', near(crit, 2.39, 0.05), `${crit.toFixed(2)} m（现 ${j.delta0().toFixed(2)}，余量 ${(crit / j.delta0()).toFixed(1)}×）`);
  ok('δ₀ ∝ W ⇒ 稳定性载荷线 ≈ 8×W', near(crit / j.delta0(), 8, 0.6), `${(crit / j.delta0()).toFixed(1)}× W_nom`);
  /* 升限约束更紧：载荷 x 使升限降到 749 */
  let xMax = 0;
  for (let x = 0; x < 3; x += 0.001) {
    const zc = 500 * Math.log(20 * 0.5e7 / (1.5e7 + x * 1e7));
    if (zc >= 749) xMax = x; else break;
  }
  ok('升限约束的载荷上限 ≈ +0.74×W（比稳定性的 8× 紧得多）', xMax > 0.65 && xMax < 0.85,
     `+${(xMax * 100).toFixed(0)}% W_nom = ${(xMax * 1e7 / 1e3).toFixed(0)} t`);
}

/* ══════════════════════════════════════════════ 11. 分配器 */
console.log('\n【11】可重构分配器');
{
  const j = mk(); j.placeAt(0, 0, 749); j.cmdZRef(749.3);
  j.state.V = [0.5, -0.3, 0.05]; j.state.omega = [0.002, -0.002, 0.001];
  j.fc.update(0.05);
  const v = j.verifyAllocation();
  ok('力矩通道分配精确', Math.abs(v.dM[0]) < 1e-4 && Math.abs(v.dM[1]) < 1e-4,
     `ΔM=(${v.dM[0].toExponential(1)}, ${v.dM[1].toExponential(1)})`);
  /* 1 台垂推失效后仍能精确 */
  j.resetState(); j.placeAt(0, 0, 749);
  j.setEngineFailed(0, true);
  j.state.omega = [0.003, -0.002, 0];
  j.fc.update(0.05);
  const v2 = j.verifyAllocation();
  ok('失效 1 台后仍精确重构', Math.abs(v2.dM[0]) < 1e-4 && Math.abs(v2.dM[1]) < 1e-4,
     `ΔM=(${v2.dM[0].toExponential(1)}, ${v2.dM[1].toExponential(1)})`);
}

/* ══════════════════════════════════════════════ 12. zRef 剖面：S 曲线 / τ / 速率限 */
console.log('\n【12】zRef 剖面（控制层）：S 曲线 ≠ 快速，但允许快速');
{
  const j = mk(); const fc = j.fc, pr = fc.profile;
  const wz = Math.sqrt(9 * j.stones[0].k / j.mp.M), d0 = j.delta0();
  ok('ω_z²·δ₀ = g（准静态判据的钥匙）', near(wz * wz * d0, 9.81, 0.02), `${(wz * wz * d0).toFixed(3)}`);
  ok('阶跃速率的安全上限 δ₀·ω_z = 1.72 m/s', near(d0 * wz, 1.72, 0.02), `${(d0 * wz).toFixed(3)} m/s`);

  /* S 曲线：加速度被限制在 aMax = rateLim/tRamp */
  let aMaxSeen = 0, rMaxSeen = 0;
  const p2 = new ZRefProfile({ tauS: 300, rateLim: 1.5, tRamp: 5 });
  let cur = new Array(9).fill(749.3);
  for (let k = 0; k < 4000; k++) {
    const { rate } = p2.rateFor(0.05, new Array(9).fill(300.3), 948.6, 'emergency', cur);
    aMaxSeen = Math.max(aMaxSeen, Math.abs(p2.acc[0]));
    rMaxSeen = Math.max(rMaxSeen, Math.abs(rate[0]));
    cur = cur.map((z, i) => z + rate[i] * 0.05);
  }
  ok('加速度被限制在 aMax = rateLim/tRamp', aMaxSeen <= 1.5 / 5 + 1e-3, `max|a|=${aMaxSeen.toFixed(4)} m/s²`);
  ok('速率限在任何模式下都不被旁路', rMaxSeen <= 1.5 + 1e-9, `max|rate|=${rMaxSeen.toFixed(4)} m/s`);
  ok('准静态偏差 ≈ a/ω_z²（远小于阶跃的 u/ω_z）',
     ZRefProfile.quasiStatic(aMaxSeen) < 0.04,
     `${(ZRefProfile.quasiStatic(aMaxSeen) * 100).toFixed(1)}% δ₀（阶跃 1.5 m/s 会是 ${(1.5 / wz / d0 * 100).toFixed(0)}%）`);

  /* 应急 = 旁路 τ（**不是**旁路速率限）：到达时间显著缩短 */
  const timeTo = (mode) => {
    const jj = mk('flat', {}, { emergencyDescent: mode === 'emergency' });
    jj.placeAt(0, 0, 749); jj.cmdZRef(749.3); settle(jj, 20);
    jj.fc.panel.setKnob('ALT', 300);
    let t = 0;
    for (let k = 0; k < 60000; k++) { jj.update(0.05); t += 0.05; if (jj.diag.agl <= 301) break; }
    return t;
  };
  const tN = timeTo('normal'), tE = timeTo('emergency');
  ok('应急下降（旁路 τ）显著快于正常（τ 主导）', tE < tN * 0.6, `正常 ${(tN / 60).toFixed(1)} min → 应急 ${(tE / 60).toFixed(1)} min`);
  ok('应急下降的下限由速率限决定（449 m / 1.5 m/s ≈ 5.0 min）', tE > 290 && tE < 320, `${(tE / 60).toFixed(1)} min`);
  ok('正常下降被 τ 拖住（指数尾巴）', tN > 25 * 60, `${(tN / 60).toFixed(1)} min`);
}

/* ══════════════════════════════════════════════ 13. TRK SET 草稿窗 */
console.log('\n【13】TRK SET：旋钮阻尼的替代方案（草稿窗 + 按钮）');
{
  const j = mk(); const p = j.fc.panel;
  p.setKnob('TRK', 120);
  ok('转动旋钮只写入草稿，不生效', p.sel.trk === 0 && p.draft.trk === 120,
     `sel=${p.sel.trk}° draft=${p.draft.trk}°`);
  p.pressTRKSET();
  ok('按下 TRK SET 后生效', p.sel.trk === 120, `sel=${p.sel.trk}°`);
  ok('按下 TRK SET 同时回到 MANAGED', p.source === 'MANAGED');
  /* SYNC */
  p.pressSYNC('HDG', { hdg: 33 }); ok('SYNC HDG 取当前艏向', p.sel.hdg === 33);
  p.pressSYNC('ALT', { alt: 500 }); ok('SYNC ALT 取当前高度', p.sel.alt === 500);
}

/* ══════════════════════════════════════════════ 14. CRAB LIMIT */
console.log('\n【14】CRAB LIMIT：谁让位取决于模式');
{
  const run = mode => {
    const j = mk(); const p = j.fc.panel;
    p.setKnob('TRK', 0); p.pressTRKSET();
    p.setKnob('HDG', 90);
    p.setKnob('CRAB', mode);
    const S = Object.assign(j.sense(), { jc: j, dt: 0.05 });
    return p.update(0.05, S, j.lim.FazMax);
  };
  const c = run('CRUISE');
  ok('CRUISE(OFF)：不夹逼', !c.crabLimited && near(Math.abs(c.crab), 90, 1e-6), `CRAB=${c.crab.toFixed(1)}°`);
  const t = run('TRANSIT');
  ok('TRANSIT(±30°)：TRK 优先，TRK 被夹逼', t.crabLimited && t.crabClamped === 'TRK' && near(t.crab, 30, 1e-6),
     `CRAB=${t.crab.toFixed(1)}° TRK=${t.trk.toFixed(1)}°`);
  const b = run('BERTH');
  ok('BERTH(±5°)：HDG 优先，HDG 被夹逼', b.crabLimited && b.crabClamped === 'HDG' && near(b.crab, 5, 1e-6),
     `CRAB=${b.crab.toFixed(1)}° HDG=${b.hdg.toFixed(1)}°`);
  ok('档位表完整', Object.keys(CRAB_LIMITS).length === 4);
}

/* ══════════════════════════════════════════════ 15. 手柄 = TRK 系 */
console.log('\n【15】手柄坐标系 = TRK 系（一个系、无开关、无指示灯）');
{
  const dirOf = trk => {
    const j = mk(); const p = j.fc.panel;
    p.setKnob('TRK', trk); p.pressTRKSET();
    p.stick = { x: 0, y: 1, twist: 0 };     // 满舵「前」
    settle(j, 40);
    const v = [j.state.P[0], j.state.P[1]];
    const n = Math.hypot(v[0], v[1]);
    return { brg: (Math.atan2(v[0], v[1]) * DEG + 360) % 360, n };
  };
  const a = dirOf(0), b = dirOf(90), c = dirOf(180);
  ok('TRK=000 推「前」⇒ 向 +y（北）', near(a.brg, 0, 3) && a.n > 100, `方位 ${a.brg.toFixed(1)}°`);
  ok('TRK=090 推「前」⇒ 向 +x（东）', near(b.brg, 90, 3) && b.n > 100, `方位 ${b.brg.toFixed(1)}°`);
  ok('TRK=180 推「前」⇒ 向 −y（南）', near(c.brg, 180, 3) && c.n > 100, `方位 ${c.brg.toFixed(1)}°`);
  const j = mk(); j.fc.panel.stick = { x: 0, y: 1, twist: 0 };
  j.fc.update(0.05);
  ok('手柄一动即转 MANUAL（触碰接管）', j.fc.diag.source === 'MANUAL');
}

/* ══════════════════════════════════════════════ 16. MANAGED 巡航 + 控制周期鲁棒性 */
console.log('\n【16】MANAGED 巡航与控制周期鲁棒性');
{
  const j = mk();
  j.fc.panel.setKnob('SPD', 18);
  j.fc.panel.setKnob('TRK', 45); j.fc.panel.pressTRKSET();
  settle(j, 300);
  const D = j.fc.diag;
  ok('达到 SPD 设定值', near(D.spd, 18, 0.2), `${D.spd.toFixed(2)} m/s`);
  ok('航迹跟随（TRK 回转到位）', near(D.trk, 45, 1), `${D.trk.toFixed(1)}°`);
  ok('稳态推进器仅克服阻力（<4%W 单台）',
     Math.max(D.tauPct[0], D.tauPct[1]) < 4.1, `${Math.max(D.tauPct[0], D.tauPct[1]).toFixed(2)}%W`);

  /* 控制周期：0（每子步）/ 0.05 / 0.2 s —— 都不应发散 */
  for (const ci of [0, 0.05, 0.2]) {
    const jj = mk('flat', {}, { ctrlInterval: ci });
    jj.placeAt(0, 0, 749); jj.cmdZRef(749.3);
    jj.state.omega = [0.002, 0, 0];
    settle(jj, 120);
    const mx = Math.max(Math.abs(jj.state.phi), Math.abs(jj.state.theta));
    ok(`控制周期 ${ci === 0 ? '每子步' : ci + ' s'}：姿态收敛不发散`, mx < 0.02 && !jj.diverged,
       `max|angle|=${(mx * DEG).toFixed(3)}°`);
  }
}

/* ══════════════════════════════════════════════ 17. 分层：物理不含控制 */
const fs = require('fs');
console.log('\n【17】分层检查：物理模块不含控制逻辑');
{
  const src = fs.readFileSync(__dirname + '/jade-chamber.js', 'utf8');
  ok('jade-chamber.js 不含 autopilot/allocate/ControlPanel 等控制符号',
     !/class\s+(Autopilot|ControlPanel|FlightControl|ManualControl)/.test(src)
     && !/autopilotUpdate|_allocate|updateAdvisory/.test(src));
  const csrc = fs.readFileSync(__dirname + '/flight-control.js', 'utf8');
  ok('flight-control.js 不含刚体积分（_integrate / inertiaBox）',
     !/_integrate\s*\(|inertiaBox/.test(csrc));
  ok('控制层与物理层的接触面只有 sense/ctrl/setZRefRate',
     /\.sense\(\)/.test(csrc) && /setZRefRate/.test(csrc) && /jc\.ctrl\./.test(csrc));
}

console.log(`\n══════ 结果：${pass} 通过 / ${fail} 失败 ══════\n`);
process.exit(fail ? 1 : 0);
