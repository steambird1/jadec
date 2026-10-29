/* ============================================================================
 *  cockpit-ui.mjs —— 把 SimCore 帧“接”到 panel/ 组件库
 *
 *  这是两种部署共用的前端：
 *    - browser-only   : 帧来自 Web Worker
 *    - browser-server : 帧来自 SSE
 *
 *  职责：
 *    1) 挂载 connection/shared/panels/jade-cockpit.json 中的 6 个面板；
 *    2) 把 Panel 组件（旋钮/按钮/拨杆/灯/鼓轮）的事件翻译成协议命令；
 *    3) 把 InstrumentSuite.read() 的 16 个分组分发给对应仪表；
 *    4) 在“远端回写”时抑制组件的 change 事件，避免命令回声。
 * ========================================================================== */
'use strict';

import { mountProject } from '../../../../panel/scripts/panels.js';
import { PrimaryFlightDisplay } from '../../../../panel/scripts/pfd.js';
import { AltitudeIndication } from '../../../../panel/scripts/alt.js';
import {
  CeilingGauge, SpeedGauge, VsiGauge, CompassRose, ProfileDisplay, PolarDisplay,
  ClearanceTape, StoneLoadDisplay, PropulsionDisplay, PlanPage, AnnuncPage, StatusPage,
} from './canvas-instruments.mjs';
import { M_TO_FT, MS_TO_KT, num } from './units.mjs';

/* 面板上 CRAB 旋钮的档位文本 → physics/ControlPanel 的 CRAB_LIMITS 键 */
const CRAB_MODES = ['CRUISE', 'TRANSIT', 'PRECISION', 'BERTH'];
const CRAB_LABELS = ['OFF', '±30', '±10', '±5'];
const TERRAIN_KEYS = ['flat', 'ramp', 'hills', 'ridge', 'peak', 'liyue'];
/* 3×3 面板显示顺序（上→下、左→右）：前排 #6–#8 在上，后排 #0–#2 在下 */
const STONE_FACE_ORDER = [6, 7, 8, 3, 4, 5, 0, 1, 2];

/* 告警代码 → 告警灯组件 id（annunciator-panel） */
const ANNUNCIATOR_IDS = {
  STIFFNESS_LOSS: 'light-warn-stiffness',
  SATURATED: 'light-warn-saturated',
  NEGATIVE_GM: 'light-warn-negative-gm',
  STONE_LOST: 'light-warn-stone-lost',
  CEILING_MARGIN: 'light-warn-ceiling-margin',
  TERRAIN_CLEARANCE: 'light-warn-terrain-clearance',
  HEADING_FREE: 'light-warn-heading-free',
  DIVERGED: 'light-warn-diverged',
  STONE_DEV: 'light-caution-stone-dev',
  FIELD_RATE: 'light-caution-field-rate',
  TRIM_PERSISTENT: 'light-caution-trim',
  CRAB_LIMIT: 'light-caution-crab',
  TRK_SLEW_LTD: 'light-caution-trk-slew',
  CEILING_PROTECT: 'light-caution-ceiling-protect',
  TRK_PENDING: 'light-caution-trk-pending',
  NO_TRACK: 'light-adv-no-track',
  ZREF_DIFFERENTIAL: 'light-adv-zref-diff',
  LEVEL_MODE: 'light-adv-level',
  MANUAL: 'light-adv-manual',
};

export class CockpitUI {
  /**
   * @param {object} options
   * @param {HTMLElement|string} options.container 挂载容器
   * @param {object} options.project 面板 JSON
   * @param {(command:object, coalesceKey?:string)=>void} options.onCommand 命令出口
   * @param {string} [options.mode] 显示在状态页上的部署模式
   */
  constructor(options) {
    this.container = options.container;
    this.project = options.project;
    this.onCommand = options.onCommand || (() => {});
    this.mode = options.mode || 'browser';
    this.status = {
      mode: this.mode,
      link: 'connecting',
      transport: '-',
      endpoint: '-',
      ageMs: 0,
      commandsSent: 0,
      lastCommand: '-',
      lastError: '',
    };
    this.lastFrame = null;

    this._suppress = new Set();
    this._drumCache = new Map();
    this._drumTime = new Map();
    this._lightGroupTextCache = new Map();
    this.custom = new Map();

    const renderers = {};
    const customFactory = {
      'disp-ceiling': c => new CeilingGauge(c.getCanvas()),
      'disp-speed': c => new SpeedGauge(c.getCanvas()),
      'disp-vsi': c => new VsiGauge(c.getCanvas()),
      'disp-compass': c => new CompassRose(c.getCanvas()),
      'disp-clearance': c => new ClearanceTape(c.getCanvas()),
      'disp-profile': c => new ProfileDisplay(c.getCanvas()),
      'disp-polar': c => new PolarDisplay(c.getCanvas()),
      'disp-stone-load': c => new StoneLoadDisplay(c.getCanvas()),
      'disp-propulsion': c => new PropulsionDisplay(c.getCanvas()),
      'disp-plan': c => new PlanPage(c.getCanvas()),
      'disp-annunc': c => new AnnuncPage(c.getCanvas()),
      'disp-status': c => new StatusPage(c.getCanvas()),
    };
    for (const [id, factory] of Object.entries(customFactory)) {
      renderers[id] = comp => {
        this.custom.set(id, factory(comp));
      };
    }

    const mounted = mountProject(this.container, this.project, {
      displayRenderers: renderers,
    });
    this.root = mounted.root;
    this.panels = mounted.panels;
    this.components = mounted.components;

    /* panel/scripts 已有的仪表 */
    const attDisplay = this.components.get('disp-attitude');
    this.pfd = new PrimaryFlightDisplay(attDisplay.getCanvas());
    const altDisplay = this.components.get('disp-alt-agl');
    this.altAgl = new AltitudeIndication(altDisplay.getCanvas());

    this._bindControls();
    this.refreshStatus();
  }

  /* ================================================================== *
   *  组件读取 / 远端回写
   * ================================================================== */
  comp(id) { return this.components.get(id); }

  _remote(id, fn) {
    this._suppress.add(id);
    try { fn(); } finally { this._suppress.delete(id); }
  }

  _on(id, event, handler) {
    const component = this.comp(id);
    if (!component) {
      console.warn(`[cockpit-ui] 缺少组件 ${id}`);
      return;
    }
    component.on(event, data => {
      if (this._suppress.has(id)) return;
      handler(data);
    });
  }

  _send(command, coalesceKey) {
    this.status.commandsSent += 1;
    this.status.lastCommand = command.action;
    this.onCommand(command, coalesceKey);
  }

  _setKnob(id, value) {
    const component = this.comp(id);
    if (!component || !Number.isFinite(Number(value))) return;
    if (Math.abs(Number(component.getValue?.() ?? component.getPosition?.() ?? NaN) - Number(value)) < 1e-4) {
      return;
    }
    this._remote(id, () => {
      if (typeof component.setValue === 'function') component.setValue(Number(value));
      else if (typeof component.setPosition === 'function') component.setPosition(Number(value));
    });
  }

  _setPosition(id, index) {
    const component = this.comp(id);
    if (!component || !Number.isInteger(index)) return;
    if (component.getPosition() === index) return;
    this._remote(id, () => component.setPosition(index));
  }

  _setDrum(id, value) {
    const component = this.comp(id);
    if (!component || !Number.isFinite(Number(value))) return;
    const previous = this._drumCache.get(id);
    if (previous !== undefined && Math.abs(previous - Number(value)) < 1e-9) return;
    /* 鼓轮是机械件：~8 Hz 足够，避免高度变化时每帧重建 DOM */
    const now = Date.now();
    if (now - (this._drumTime.get(id) || 0) < 120) return;
    this._drumTime.set(id, now);
    this._drumCache.set(id, Number(value));
    this._remote(id, () => component.setValue(Number(value)));
  }

  _setLight(id, on, brightness = 85) {
    const component = this.comp(id);
    if (!component || typeof component.setBrightness !== 'function') return;
    component.setBrightness(on ? brightness : 0);
  }

  _setGroupTexts(id, texts) {
    const component = this.comp(id);
    if (!component || typeof component.setLightText !== 'function') return;
    const cache = this._lightGroupTextCache.get(id) || [];
    texts.forEach((value, index) => {
      const next = String(value ?? '');
      if (cache[index] === next) return;
      cache[index] = next;
      this._remote(id, () => component.setLightText(index, next));
    });
    this._lightGroupTextCache.set(id, cache);
  }

  /* ================================================================== *
   *  输入 → 协议命令
   * ================================================================== */
  _bindControls() {
    /* --- MCP 旋钮 --- */
    this._on('knob-spd', 'change', d =>
      this._send({ action: 'setKnob', name: 'SPD', value: d.value }, 'SPD'));
    this._on('knob-trk', 'change', d =>
      this._send({ action: 'setKnob', name: 'TRK', value: d.value }, 'TRK'));
    this._on('knob-hdg', 'change', d =>
      this._send({ action: 'setKnob', name: 'HDG', value: d.value }, 'HDG'));
    this._on('knob-alt', 'change', d =>
      this._send({ action: 'setKnob', name: 'ALT', value: d.value }, 'ALT'));
    this._on('knob-crab', 'change', d =>
      this._send({ action: 'setKnob', name: 'CRAB', value: CRAB_MODES[d.position] || 'CRUISE' }));

    /* --- 按钮 / 拨杆 --- */
    this._on('btn-trk-set', 'click', () => this._send({ action: 'trkSet' }));
    this._on('btn-sync-hdg', 'click', () => this._send({ action: 'sync', kind: 'HDG' }));
    this._on('btn-sync-trk', 'click', () => this._send({ action: 'sync', kind: 'TRK' }));
    this._on('btn-sync-alt', 'click', () => this._send({ action: 'sync', kind: 'ALT' }));
    this._on('btn-managed', 'click', () => this._send({ action: 'managed' }));
    this._on('btn-ap', 'click', () => this._send({ action: 'toggleSwitch', name: 'AP' }));
    this._on('btn-hdg-auto', 'click', () =>
      this._send({ action: 'toggleSwitch', name: 'HDG_AUTO' }));
    this._on('btn-emerg-descent', 'click', () =>
      this._send({ action: 'toggleSwitch', name: 'EMERGENCY_DESCENT' }));
    this._on('lever-level', 'change', d =>
      this._send({ action: 'level', value: d.position === 1 }));

    /* --- FE / 系统 --- */
    this._on('btn-dump', 'click', () =>
      this._send({ action: 'dumpBallast', mass: 100000 }));
    this._on('btn-reset', 'click', () => {
      const knob = this.comp('knob-terrain');
      const key = TERRAIN_KEYS[knob ? knob.getPosition() : 0] || 'flat';
      this._send({ action: 'reset', terrainPreset: key });
    });
    this._on('btn-toggle-stone', 'click', () => {
      const knob = this.comp('knob-fail-stone');
      this._send({ action: 'toggleStone', index: knob ? knob.getPosition() : 0 });
    });
    this._on('btn-toggle-engine', 'click', () => {
      const knob = this.comp('knob-fail-engine');
      this._send({ action: 'toggleEngine', index: knob ? knob.getPosition() : 0 });
    });
    this._on('btn-stiffness', 'click', () =>
      this._send({ action: 'toggleSwitch', name: 'STIFFNESS_LOSS' }));
    this._on('btn-apply-wind', 'click', () => {
      const dir = this.comp('knob-wind-dir');
      const speed = this.comp('knob-wind-speed');
      this._send({
        action: 'setWind',
        dirDeg: dir ? dir.getValue() : 0,
        speed: speed ? speed.getValue() : 0,
      });
    });
  }

  /* ================================================================== *
   *  帧 → 仪表
   * ================================================================== */
  applyFrame(frame) {
    if (!frame || frame.type !== 'frame') return;
    this.lastFrame = frame;
    const D = frame.data;
    const M = frame.meta;
    const flags = M.flags;
    const mcp = D.mcp;
    const ui = M.ui;

    this.status.ageMs = Math.max(0, Date.now() - Number(frame.wallTime || Date.now()));

    /* ---- 姿态 / PFD ---- */
    const att = D.attitude;
    const follow = att.levelMode === 'FOLLOW';
    const fma = [
      [
        flags.managed ? 'MANAGED' : 'MANUAL',
        flags.ap ? 'AP' : 'AP OFF',
        flags.hdgAuto ? 'HDG AUTO' : 'HDG SEL',
        att.levelMode,
      ],
      [
        mcp ? `SPD ${num(mcp.SPD.selected, 1)}` : 'SPD --',
        mcp ? `TRK ${num(mcp.TRK.selected, 0)}` : 'TRK --',
        mcp ? `ALT ${num(mcp.ALT.selected, 0)}` : 'ALT --',
        mcp ? `CRAB ${mcp.CRAB.mode}` : 'CRAB --',
      ],
    ];
    this.pfd.updateDisplay(att.theta, att.phi, {
      fma,
      flightDirector: follow
        ? { targetPitch: att.followTarget.theta, targetRoll: att.followTarget.phi }
        : { targetPitch: 0, targetRoll: 0 },
      attitudeFailure: flags.diverged,
    });

    /* ---- 双高度表（离场参考面 AGL） ---- */
    this.altAgl.updateDisplay(
      D.altimetry.gap * M_TO_FT,
      29.92,
      { value: mcp ? mcp.ALT.selected * M_TO_FT : null, color: '#37d67a' },
    );

    /* ---- MCP 回写 ---- */
    if (mcp) {
      this._setKnob('knob-spd', mcp.SPD.selected);
      this._setKnob('knob-trk', mcp.TRK.draft);
      this._setKnob('knob-hdg', mcp.HDG.selected);
      this._setKnob('knob-alt', mcp.ALT.selected);
      this._setPosition('knob-crab', Math.max(0, CRAB_MODES.indexOf(mcp.CRAB.mode)));
      this._setPosition('lever-level', mcp.switches.LEVEL === 'LEVEL' ? 1 : 0);

      this._setDrum('drum-spd', mcp.SPD.selected);
      this._setDrum('drum-trk-draft', mcp.TRK.draft);
      this._setDrum('drum-trk-sel', mcp.TRK.selected);
      this._setDrum('drum-hdg', mcp.HDG.selected);
      this._setDrum('drum-alt', mcp.ALT.selected);
      this._setDrum('drum-alt-actual', D.altimetry.gap);

      this._setLight('light-alt-limited', !!mcp.ALT.limited);
      this._setLight('light-trk-pending', !!mcp.TRK.pending);
      this._setLight('light-managed', !!mcp.switches.MANAGED || flags.managed);
      this._setLight('light-ap', !!flags.ap);
      this._setLight('light-hdg-auto', !!flags.hdgAuto);
      this._setLight('light-level-mode', mcp.switches.LEVEL === 'LEVEL', 70);
      this._setLight('light-emergency', !!flags.emergencyDescent);
    }
    this._setLight('light-ceiling-protect',
      !!D.annunciators.caution.some(a => a.code === 'CEILING_PROTECT'));

    /* ---- 主仪表板聚合灯 ---- */
    this._setLight('light-master-warn', D.annunciators.masterWarning, 100);
    this._setLight('light-master-caution', D.annunciators.masterCaution, 100);
    this._setLight('light-saturated',
      D.annunciators.warning.some(a => a.code === 'SATURATED'), 100);
    this._setLight('light-terrain-clearance',
      D.annunciators.warning.some(a => a.code === 'TERRAIN_CLEARANCE'), 100);
    this._setLight('light-ceiling-margin',
      D.annunciators.warning.some(a => a.code === 'CEILING_MARGIN'), 100);
    this._setLight('light-heading-free',
      D.annunciators.warning.some(a => a.code === 'HEADING_FREE'), 100);

    /* ---- 可失石数灯条 ---- */
    const canLose = Math.max(0, Math.min(8, Number(D.ceiling.canLoseStones) || 0));
    const group = this.comp('lightgroup-remain-stones');
    if (group) {
      group.setBrightnesses(Array.from({ length: 9 }, (_, i) => (i < canLose ? 85 : 0)));
    }

    /* ---- 告警灯板 ---- */
    const codes = new Set(D.annunciators.list.map(a => a.code));
    for (const [code, id] of Object.entries(ANNUNCIATOR_IDS)) {
      this._setLight(id, codes.has(code), 85);
    }
    this._setLight('light-annunc-master-warn', D.annunciators.masterWarning, 100);
    this._setLight('light-annunc-master-caution', D.annunciators.masterCaution, 100);
    this._setLight('light-link', this.status.link === 'online', 80);

    /* ---- FE ---- */
    this._setLight('light-trim',
      D.annunciators.caution.some(a => a.code === 'TRIM_PERSISTENT'));
    this._setLight('light-stone-dev', D.stones.stoneDevAlarm);
    this._setLight('light-fe-level', D.attitude.levelMode === 'LEVEL', 70);

    const stoneTexts = STONE_FACE_ORDER.map(i => {
      const r = D.stones.rows[i];
      return `#${r.idx} ${r.failed ? 'LOST' : r.saturated ? 'SAT' : `${num(r.frac * 100, 0)}%`}`;
    });
    this._setGroupTexts('lightgroup-stones', stoneTexts);
    const stoneGroup = this.comp('lightgroup-stones');
    if (stoneGroup) {
      stoneGroup.setBrightnesses(STONE_FACE_ORDER.map(i => {
        const r = D.stones.rows[i];
        return r.failed ? 0 : r.saturated ? 100 : 60;
      }));
    }
    D.stones.rows.forEach((row, i) => this._setDrum(`drum-zref-${i}`, row.zRef));

    this._setDrum('drum-margin', D.ceiling.margin);
    this._setDrum('drum-lost', D.ceiling.canLoseStones);
    this._setDrum('drum-total-weight', D.weight.M / 1000);
    this._setDrum('drum-payload-margin', D.weight.loadLine.margin / 1000);
    const water = D.weight.tanks.reduce((sum, t) => sum + Number(t.m || 0), 0);
    this._setDrum('drum-water', water / 1000);
    this._setDrum('drum-trim-spread', D.stones.trimSpread);

    const stiff = this.comp('btn-stiffness');
    if (stiff) stiff.updateLights(flags.stiffnessFailed ? 100 : 0,
      flags.stiffnessFailed ? 0 : 85);

    /* ---- 自绘仪表 ---- */
    for (const instrument of this.custom.values()) {
      try {
        if (instrument instanceof StatusPage) instrument.render(frame, this.status);
        else instrument.render(frame);
      } catch (error) {
        console.error('[cockpit-ui] 仪表绘制失败', error);
      }
    }
  }

  /* ================================================================== *
   *  连接状态
   * ================================================================== */
  setLinkState(partial) {
    Object.assign(this.status, partial);
    this.refreshStatus();
  }

  setError(message) {
    this.status.lastError = message ? String(message) : '';
    this.refreshStatus();
  }

  refreshStatus() {
    const page = this.custom.get('disp-status');
    if (!page) return;
    if (this.lastFrame) page.render(this.lastFrame, this.status);
    else {
      const stub = {
        seq: 0, simTime: 0, wallTime: Date.now(),
        meta: {
          flags: {},
          environment: { windWorld: [0, 0, 0] },
          terrainPreset: '-',
          controls: { source: '-' },
          ui: { warningCount: 0, cautionCount: 0 },
        },
      };
      page.render(stub, this.status);
    }
  }
}
