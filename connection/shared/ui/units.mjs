/* ============================================================================
 *  units.mjs —— 物理单位 ↔ 仪表单位的唯一换算点
 *
 *  physics/instruments.js 全部使用 SI（m、m/s、kg、deg）。
 *  panel/ 中的传统仪表使用航空单位（kt、ft、ft/min）。
 *  任何“SI → 表盘”的换算都必须经过本文件，避免在 UI 各处散落常数。
 * ========================================================================== */
'use strict';

export const M_TO_FT = 3.280839895013123;
export const FT_TO_M = 0.3048;
export const MS_TO_KT = 1.943844492440604;
export const KT_TO_MS = 0.5144444444444445;
export const MS_TO_FPM = 196.8503937007874;

/** 标准大气常量（与 panel/scripts/physics.js 的 AirspeedCalculator 一致） */
const KAPPA = 1.4;
const R_AIR = 287;

export const mToFt = v => v * M_TO_FT;
export const ftToM = v => v * FT_TO_M;
export const msToKt = v => v * MS_TO_KT;
export const ktToMs = v => v * KT_TO_MS;
export const msToFpm = v => v * MS_TO_FPM;

/** 真空速（kt）→ 马赫数；TAT 默认 15 °C */
export function machFromKnots(knots, tatC = 15) {
  const a = Math.sqrt((tatC + 273.15) * KAPPA * R_AIR);
  return (Number(knots) * 1852 / 3600) / a;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function wrap180(deg) {
  let d = ((Number(deg) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

export function wrap360(deg) {
  return ((Number(deg) % 360) + 360) % 360;
}

/** 数字格式化：避免 -0、NaN 泄漏到表盘 */
export function num(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '---';
  const fixed = n.toFixed(digits);
  return /^-0(\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
}

export function pct(value, digits = 0) {
  return `${num(value, digits)}%`;
}
