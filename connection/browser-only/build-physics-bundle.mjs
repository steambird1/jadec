/* ============================================================================
 *  build-physics-bundle.mjs —— 把 physics/*.js（CommonJS）打包成浏览器 ESM
 *
 *  物理代码保持单一真相源：不复制、不改写 physics/ 下的任何文件。
 *  本脚本按顺序把 4 个模块包进一个极小的 CommonJS 运行时，
 *  输出 browser-only/physics-bundle.mjs。
 *
 *  用法（在仓库根目录或任意目录）：
 *      node connection/browser-only/build-physics-bundle.mjs
 * ========================================================================== */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHYSICS_DIR = path.resolve(HERE, '../../physics');
const OUTPUT = path.resolve(HERE, 'physics-bundle.mjs');

/* 顺序无关，但固定顺序便于 diff；field-test.js 是命令行自检，不打包 */
const MODULES = [
  'terrain.js',
  'jade-chamber.js',
  'flight-control.js',
  'instruments.js',
];

function main() {
  const chunks = [];
  chunks.push(`/* ============================================================================
 *  physics-bundle.mjs —— 自动生成，请勿手工编辑
 *
 *  源文件：${MODULES.join(', ')}
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
`);

  for (const name of MODULES) {
    const full = path.join(PHYSICS_DIR, name);
    const source = fs.readFileSync(full, 'utf8');
    chunks.push(`\n/* ==================== physics/${name} ==================== */`);
    chunks.push(`__modules.set(${JSON.stringify('./' + name)}, function (module, exports, require) {`);
    chunks.push(source);
    chunks.push(`});`);
  }

  chunks.push(`
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
`);

  fs.writeFileSync(OUTPUT, chunks.join('\n'), 'utf8');
  const bytes = fs.statSync(OUTPUT).size;
  console.log(`[physics-bundle] wrote ${path.relative(process.cwd(), OUTPUT)} (${bytes} bytes)`);
}

main();
