/* ============================================================================
 *  ui-smoke.mjs —— 无浏览器冒烟测试
 *
 *  用最小 DOM shim 跑通：
 *      SimCore 帧 → CockpitUI → panel 组件 + Canvas 仪表
 *      组件事件 → 命令
 *
 *  目的不是替代浏览器，而是让 CI/无头环境能发现：
 *    - 面板 JSON 与 UI 绑定的 id 不一致
 *    - Canvas 绘制代码访问了不存在的字段
 *    - 远端回写触发了命令回声
 *
 *  运行：node connection/tests/ui-smoke.mjs
 * ========================================================================== */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 *  最小 DOM shim
 * ------------------------------------------------------------------ */
const registry = new Map();

class ClassList {
  constructor() { this._set = new Set(); }
  add(...names) { names.forEach(n => this._set.add(n)); }
  remove(...names) { names.forEach(n => this._set.delete(n)); }
  contains(name) { return this._set.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this._set.has(name) : !!force;
    if (next) this._set.add(name); else this._set.delete(name);
    return next;
  }
}

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.classList = new ClassList();
    this._listeners = new Map();
    this.textContent = '';
    this.tabIndex = 0;
    this.parentNode = null;
    this._id = '';
  }

  set id(value) {
    this._id = String(value);
    registry.set(this._id, this);
  }
  get id() { return this._id; }

  get children() { return this.childNodes.filter(node => node.nodeType === 1); }

  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
    if (node.id) registry.set(node.id, node);
    return node;
  }

  insertBefore(node, reference) {
    const index = this.childNodes.indexOf(reference);
    node.parentNode = this;
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  querySelector(selector) {
    const want = selector.startsWith('.') ? selector.slice(1) : null;
    const visit = node => {
      for (const child of node.children) {
        if (want && child.classList.contains(want)) return child;
        if (!want && child.tagName === selector.toUpperCase()) return child;
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this);
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type, data = {}) {
    for (const handler of this._listeners.get(type) || []) handler(data);
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'id') this.id = value;
  }
  getAttribute(key) { return this.attributes[key]; }

  focus() {}
  setPointerCapture() {}
  releasePointerCapture() {}

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 120, bottom: 120, width: 120, height: 120 };
  }
}

function makeContext(canvas) {
  const gradient = { addColorStop() {} };
  const target = {
    canvas,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  return new Proxy(target, {
    get(object, key) {
      if (key in object) return object[key];
      return () => {};
    },
    set(object, key, value) { object[key] = value; return true; },
  });
}

class CanvasElement extends Element {
  constructor() {
    super('canvas');
    this.width = 300;
    this.height = 150;
    this._ctx = makeContext(this);
  }
  getContext() { return this._ctx; }
}

const documentShim = {
  body: new Element('body'),
  createElement(tag) {
    return String(tag).toLowerCase() === 'canvas'
      ? new CanvasElement() : new Element(tag);
  },
  getElementById(id) { return registry.get(String(id)) || null; },
  addEventListener() {},
  removeEventListener() {},
};

globalThis.document = documentShim;
globalThis.window = globalThis;
globalThis.HTMLCanvasElement = CanvasElement;
globalThis.devicePixelRatio = 1;
globalThis.addEventListener = globalThis.addEventListener || (() => {});
globalThis.removeEventListener = globalThis.removeEventListener || (() => {});
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 16);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

/* ------------------------------------------------------------------ *
 *  测试
 * ------------------------------------------------------------------ */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const projectPath = path.resolve(HERE, '../shared/panels/jade-cockpit.json');
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));

const { physics } = await import('../browser-only/physics-bundle.mjs');
const { SimCore } = await import('../shared/sim-core.mjs');
const { CockpitUI } = await import('../shared/ui/cockpit-ui.mjs');

const container = documentShim.createElement('div');
container.id = 'panels-container';

const commands = [];
const ui = new CockpitUI({
  container,
  project,
  mode: 'smoke-test',
  onCommand: (command, key) => commands.push({ command, key }),
});

const sim = new SimCore(physics);
ui.applyFrame(sim.frame);
ui.applyFrame(sim.step(0.05));

const expected = project.panels.reduce((sum, panel) => sum + panel.components.length, 0);
if (ui.components.size !== expected) {
  throw new Error(`组件数量不一致: UI=${ui.components.size} JSON=${expected}`);
}
console.log(`✓ 挂载 ${project.panels.length} 个面板 / ${ui.components.size} 个组件`);

/* 输入 → 命令 */
ui.comp('knob-spd')._emit('change', { value: 12 });
ui.comp('btn-trk-set')._emit('click', {});
ui.comp('lever-level')._emit('change', { position: 1 });
ui.comp('knob-crab')._emit('change', { position: 1 });
if (commands.length !== 4) throw new Error('输入命令数量不正确: ' + commands.length);
const actions = commands.map(item => item.command.action).join(',');
if (!actions.includes('setKnob') || !actions.includes('trkSet')
    || !actions.includes('level')) {
  throw new Error('输入命令翻译不完整: ' + actions);
}
console.log('✓ 旋钮 / 按钮 / 拨杆 → 命令：' + actions);

/* 命令 → 物理 → 帧 → 远端回写（不应产生命令回声） */
commands.length = 0;
sim.applyCommands([
  { action: 'setKnob', name: 'ALT', value: 500 },
  { action: 'setKnob', name: 'SPD', value: 12 },
  { action: 'trkSet' },
]);
for (let i = 0; i < 20; i++) ui.applyFrame(sim.step(0.05));
if (Math.abs(ui.comp('knob-alt').getValue() - 500) > 1e-6) {
  throw new Error('knob-alt 未跟随远端值: ' + ui.comp('knob-alt').getValue());
}
if (Math.abs(ui.comp('knob-spd').getValue() - 12) > 1e-6) {
  throw new Error('knob-spd 未跟随远端值: ' + ui.comp('knob-spd').getValue());
}
if (commands.length !== 0) {
  throw new Error('远端回写产生了命令回声: ' + JSON.stringify(commands));
}
console.log('✓ 远端回写 + 回声抑制');

/* 告警 / 故障帧不会让绘制崩溃 */
sim.applyCommands([{ action: 'toggleStone', index: 0 }]);
for (let i = 0; i < 60; i++) ui.applyFrame(sim.step(0.05));
if (!sim.frame.data.stones.rows[0].failed) throw new Error('故障注入未生效');
const masterWarn = ui.comp('light-master-warn').getBrightness();
if (!(masterWarn > 0)) throw new Error('主警告灯未点亮');
console.log(`✓ 故障帧：STONE_LOST / 主警告亮度 ${masterWarn}`);

/* 地形/风/重置路径 */
sim.applyCommands([
  { action: 'setWind', speed: 5, dirDeg: 90 },
  { action: 'reset', terrainPreset: 'ramp' },
]);
ui.applyFrame(sim.frame);
if (sim.frame.meta.terrainPreset !== 'ramp') throw new Error('地形重置失败');
console.log('✓ 风 / 地形重置帧');

console.log('\nALL SMOKE TESTS PASSED');
process.exit(0);
