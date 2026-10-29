/* ============================================================================
 *  canvas-instruments.mjs —— 为 panel/ 组件库补充的 Canvas 仪表
 *
 *  panel/scripts 里已有的仪表（PFD / 空速 / 高度 / VSI / 鼓轮 / 灯 / 旋钮）
 *  直接复用；本文件只实现 panel/ 没有的、群玉阁特有的图形：
 *
 *    CeilingGauge      升限余量双针表（AGL vs 升限 + 可失石数灯条）
 *    CompassRose       永久 HDG UP 圆表（罗盘卡 / 速度箭头 / CRAB 扇区 / 可行扇区）
 *    ProfileDisplay    T / S / 预测航迹 场剖面
 *    PolarDisplay      能力极坐标（24 艏向 v_max）
 *    ClearanceTape     双高度带（AGL / 真实离地）
 *    StoneLoadDisplay  3×3 石头出力图（与物理阵列同构）
 *    PropulsionDisplay 4 垂推 + 2 azimuth + APU
 *    PlanPage          升降计划 / 阻尼文本页
 *    AnnuncPage        告警文本页
 *    StatusPage        连接与系统状态页
 *
 *  所有 render() 接收 SimCore 帧，不修改数据。
 * ========================================================================== */
'use strict';

import { M_TO_FT, MS_TO_KT, num, wrap180, clamp } from './units.mjs';

export const PALETTE = {
  bg: '#070a0f',
  face: '#0d1117',
  face2: '#121821',
  line: '#39414d',
  grid: 'rgba(120, 140, 165, 0.18)',
  text: '#e3ebf5',
  dim: '#8d99a8',
  faint: '#5d6877',
  green: '#37d67a',
  amber: '#ffb020',
  red: '#ff4d4f',
  cyan: '#39c8ff',
  magenta: '#ff5cc8',
  brown: '#8b5a2b',
  sky: '#1e63a8',
  white: '#f5f8fc',
};

const RAD = Math.PI / 180;
const MONO = 'Consolas, "Cascadia Code", Menlo, monospace';
const SANS = 'Bahnschrift, "Segoe UI", Arial, sans-serif';

/* ---------------------------------------------------------------- 画布工具 */
function begin(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

function roundRect(ctx, x, y, w, h, r = 4) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function text(ctx, value, x, y, opts = {}) {
  const {
    size = 11, color = PALETTE.text, align = 'left', baseline = 'alphabetic',
    weight = '500', font = SANS,
  } = opts;
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(String(value), x, y);
  ctx.restore();
}

function line(ctx, x0, y0, x1, y1, color = PALETTE.line, width = 1, dash = null) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

function panelFrame(ctx, x, y, w, h, title = '') {
  roundRect(ctx, x, y, w, h, 5);
  ctx.fillStyle = PALETTE.face;
  ctx.fill();
  ctx.strokeStyle = PALETTE.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  if (title) text(ctx, title, x + 8, y + 13, { size: 9, color: PALETTE.dim, weight: '700' });
}

/** 罗盘角（0°=上，顺时针）→ 画布坐标 */
function compassPoint(cx, cy, r, deg) {
  const a = (deg - 90) * RAD;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function compassArc(ctx, cx, cy, r, fromDeg, toDeg) {
  ctx.arc(cx, cy, r, (fromDeg - 90) * RAD, (toDeg - 90) * RAD, false);
}

/* ========================================================================== *
 *  1. 升限余量双针表
 * ========================================================================== */
export class CeilingGauge {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const I = frame.data.ceiling;
    const A = frame.data.altimetry;
    const cx = w / 2;
    const cy = h / 2 - 4;
    const R = Math.min(w, h) * 0.45;
    const MAX = 1200;
    const START = 225;
    const SWEEP = 270;
    const toDeg = v => START + SWEEP * clamp(Number(v) || 0, 0, MAX) / MAX;

    /* 表壳 */
    const bez = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    bez.addColorStop(0, '#f2f5f9');
    bez.addColorStop(0.35, '#9aa3b0');
    bez.addColorStop(0.7, '#4b535f');
    bez.addColorStop(1, '#191d24');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = bez;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 6, 0, Math.PI * 2);
    const face = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, 2, cx, cy, R);
    face.addColorStop(0, '#2b333e');
    face.addColorStop(0.6, '#141a22');
    face.addColorStop(1, '#080b10');
    ctx.fillStyle = face;
    ctx.fill();

    /* 刻度（0–1200，每 50 小刻度、每 100 大刻度、每 200 数字） */
    for (let v = 0; v <= MAX; v += 50) {
      const major = v % 100 === 0;
      const deg = toDeg(v);
      const [x0, y0] = compassPoint(cx, cy, R - 9, deg);
      const [x1, y1] = compassPoint(cx, cy, R - (major ? 20 : 15), deg);
      line(ctx, x0, y0, x1, y1, major ? PALETTE.white : PALETTE.faint, major ? 1.6 : 0.8);
      if (v % 200 === 0) {
        const [tx, ty] = compassPoint(cx, cy, R - 30, deg);
        text(ctx, v, tx, ty + 3, {
          size: 9, color: PALETTE.dim, align: 'center', baseline: 'middle', font: MONO,
        });
      }
    }

    /* 三条固定红线：实用升限 / 最大升限 / 过载升限 */
    const marks = [
      { v: 749, label: '749', color: PALETTE.green },
      { v: 948.6, label: '949', color: PALETTE.amber },
      { v: 1060, label: '1060', color: PALETTE.red },
    ];
    for (const m of marks) {
      const deg = toDeg(m.v);
      const [x0, y0] = compassPoint(cx, cy, R - 20, deg);
      const [x1, y1] = compassPoint(cx, cy, R - 7, deg);
      line(ctx, x0, y0, x1, y1, m.color, 2.4);
      const [tx, ty] = compassPoint(cx, cy, R - 44, deg);
      text(ctx, m.label, tx, ty + 3, {
        size: 7, color: m.color, align: 'center', baseline: 'middle', font: MONO, weight: '700',
      });
    }

    /* 指针 */
    const needle = (value, color, width, len) => {
      const deg = toDeg(value);
      const [x, y] = compassPoint(cx, cy, len, deg);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 2;
      line(ctx, cx, cy, x, y, color, width);
      ctx.restore();
    };
    needle(I.ceiling, PALETTE.red, 3.2, R - 26);
    needle(I.agl, PALETTE.white, 2.6, R - 38);

    /* 中心轴 */
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#c9d1db';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1f27';
    ctx.fill();

    /* 余量文字 */
    const levelColor = I.level === 'OK' ? PALETTE.green
      : I.level === 'CAUTION' ? PALETTE.amber : PALETTE.red;
    text(ctx, 'MARGIN', cx, cy + 34, {
      size: 8, color: PALETTE.dim, align: 'center', weight: '700',
    });
    text(ctx, `${num(I.margin, 0)} m`, cx, cy + 51, {
      size: 17, color: levelColor, align: 'center', weight: '700', font: MONO,
    });
    text(ctx, `${num(I.margin * M_TO_FT, 0)} ft`, cx, cy + 63, {
      size: 8, color: PALETTE.dim, align: 'center', font: MONO,
    });

    /* 可失石数灯条（9 段） */
    const n = Math.max(0, Math.min(8, Math.round(I.canLoseStones)));
    const barW = Math.min(w - 48, 138);
    const segW = barW / 9;
    const bx = cx - barW / 2;
    const by = h - 24;
    for (let i = 0; i < 9; i++) {
      const lit = i < n + 1; /* 0 块也点亮第 1 格：表示“当前还能失 0 块” */
      ctx.fillStyle = lit ? (n >= 2 ? PALETTE.green : PALETTE.amber) : '#1b212a';
      roundRect(ctx, bx + i * segW + 0.6, by, segW - 1.2, 7, 1.5);
      ctx.fill();
    }
    text(ctx, `REMAIN STONE LOSS  ${n}`, cx, h - 6, {
      size: 7.5, color: PALETTE.dim, align: 'center', weight: '700',
    });
  }
}

/* ========================================================================== *
 *  1b. 空速表 0–30 m/s（机械表 + 红色限速游标 + SPD 选择游标）
 * ========================================================================== */
export class SpeedGauge {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const D = frame.data;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.45;
    const MAX = 30;
    const START = 210;
    const SWEEP = 240;
    const toDeg = v => START + SWEEP * clamp(v, 0, MAX) / MAX;

    const bez = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    bez.addColorStop(0, '#eef2f7');
    bez.addColorStop(0.5, '#8b939f');
    bez.addColorStop(1, '#1a1e25');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = bez;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 6, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0f15';
    ctx.fill();

    /* 绿带 = 可用速度区间 0..Vmax */
    const vLim = Math.max(0, D.fieldRate.vLimit);
    ctx.beginPath();
    compassArc(ctx, cx, cy, R - 10, toDeg(0), toDeg(vLim));
    ctx.strokeStyle = 'rgba(55,214,122,.5)';
    ctx.lineWidth = 4;
    ctx.stroke();

    for (let v = 0; v <= MAX; v += 1) {
      const major = v % 5 === 0;
      const deg = toDeg(v);
      const [x0, y0] = compassPoint(cx, cy, R - 9, deg);
      const [x1, y1] = compassPoint(cx, cy, R - (major ? 20 : 15), deg);
      line(ctx, x0, y0, x1, y1, major ? PALETTE.white : PALETTE.faint, major ? 1.5 : 0.7);
      if (major) {
        const [tx, ty] = compassPoint(cx, cy, R - 31, deg);
        text(ctx, v, tx, ty + 3, {
          size: 8, color: PALETTE.dim, align: 'center', baseline: 'middle', font: MONO,
        });
      }
    }

    /* 限速游标（红） */
    const bug = (value, color, width) => {
      const deg = toDeg(value);
      const [x0, y0] = compassPoint(cx, cy, R - 4, deg);
      const [x1, y1] = compassPoint(cx, cy, R - 16, deg);
      line(ctx, x0, y0, x1, y1, color, width);
    };
    bug(vLim, PALETTE.red, 3);
    if (D.mcp) bug(D.mcp.SPD.selected, PALETTE.cyan, 2.2);

    /* 指针 */
    const sv = D.compass.speed;
    const [nx, ny] = compassPoint(cx, cy, R - 26, toDeg(sv));
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;
    line(ctx, cx, cy, nx, ny, PALETTE.white, 3);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#c9d1db';
    ctx.fill();

    /* 数字窗 */
    roundRect(ctx, cx - 30, cy + 18, 60, 22, 3);
    ctx.fillStyle = '#04070b';
    ctx.fill();
    ctx.strokeStyle = PALETTE.line;
    ctx.stroke();
    text(ctx, `${num(sv, 1)}`, cx, cy + 34, {
      size: 15, color: PALETTE.white, align: 'center', font: MONO, weight: '700',
    });
    text(ctx, 'm/s', cx, cy + 47, {
      size: 7, color: PALETTE.dim, align: 'center', font: MONO,
    });
    text(ctx, `MACH ${num((sv * 3.6) / 340.3, 2)}`, cx, cy + 60, {
      size: 7, color: PALETTE.faint, align: 'center', font: MONO,
    });
    text(ctx, `LIM ${num(vLim, 1)}`, cx, cy - 12, {
      size: 8, color: vLim < MAX - 0.05 ? PALETTE.amber : PALETTE.dim,
      align: 'center', font: MONO,
    });
  }
}

/* ========================================================================== *
 *  1c. VSI：针 = ż（阻尼），游标 = Ṡ
 * ========================================================================== */
export class VsiGauge {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const V = frame.data.vsi;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.45;
    const MAX = 2.5;
    const START = 150;   /* -2.5 */
    const SWEEP = 240;   /* 0 在 270°（左），+2.5 在 390° */
    const toDeg = v => START + SWEEP * clamp((v + MAX) / (2 * MAX), 0, 1);

    const bez = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    bez.addColorStop(0, '#eef2f7');
    bez.addColorStop(0.5, '#8b939f');
    bez.addColorStop(1, '#1a1e25');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = bez;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 6, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0f15';
    ctx.fill();

    /* 绿带：纯地形跟随 ±0.9 m/s 附近 */
    ctx.beginPath();
    compassArc(ctx, cx, cy, R - 10, toDeg(-0.9), toDeg(0.9));
    ctx.strokeStyle = 'rgba(55,214,122,.4)';
    ctx.lineWidth = 4;
    ctx.stroke();

    for (let v = -MAX; v <= MAX + 1e-9; v += 0.25) {
      const major = Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;
      const deg = toDeg(v);
      const [x0, y0] = compassPoint(cx, cy, R - 9, deg);
      const [x1, y1] = compassPoint(cx, cy, R - (major ? 19 : 14), deg);
      line(ctx, x0, y0, x1, y1, major ? PALETTE.white : PALETTE.faint, major ? 1.4 : 0.7);
      if (major && Math.abs(v) > 0.01) {
        const [tx, ty] = compassPoint(cx, cy, R - 30, deg);
        text(ctx, v.toFixed(1), tx, ty + 3, {
          size: 7, color: PALETTE.dim, align: 'center', baseline: 'middle', font: MONO,
        });
      }
    }
    {
      const [tx, ty] = compassPoint(cx, cy, R - 30, toDeg(0));
      text(ctx, '0', tx, ty + 3, {
        size: 8, color: PALETTE.dim, align: 'center', baseline: 'middle', font: MONO,
      });
    }

    /* Ṡ 游标（红） */
    const bugDeg = toDeg(V.bug);
    const [bx0, by0] = compassPoint(cx, cy, R - 4, bugDeg);
    const [bx1, by1] = compassPoint(cx, cy, R - 16, bugDeg);
    line(ctx, bx0, by0, bx1, by1, PALETTE.red, 3);

    /* 针（白） */
    const deg = toDeg(V.zdot);
    const [nx, ny] = compassPoint(cx, cy, R - 26, deg);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;
    line(ctx, cx, cy, nx, ny, PALETTE.white, 3);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#c9d1db';
    ctx.fill();

    /* 数字 */
    const col = V.following ? PALETTE.green : PALETTE.text;
    text(ctx, `${V.zdot >= 0 ? '+' : ''}${num(V.zdot, 2)}`, cx, cy + 36, {
      size: 14, color: col, align: 'center', font: MONO, weight: '700',
    });
    text(ctx, 'm/s', cx, cy + 48, {
      size: 7, color: PALETTE.dim, align: 'center', font: MONO,
    });
    text(ctx, V.following ? 'FOL' : `DEV ${num(V.deviation, 2)}`, cx, cy + 60, {
      size: 7.5, color: V.following ? PALETTE.green : PALETTE.amber,
      align: 'center', font: MONO, weight: '700',
    });
    text(ctx, `Ṡ ${num(V.bug, 2)}`, cx, cy - 14, {
      size: 8, color: PALETTE.red, align: 'center', font: MONO,
    });
  }
}

/* ========================================================================== *
 *  2. 永久 HDG UP 圆表
 * ========================================================================== */
export class CompassRose {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const I = frame.data.compass;
    const C = frame.data.capability;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.46;
    const bearing = I.cardTopDeg;

    /* 表盘 */
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, 4, cx, cy, R);
    g.addColorStop(0, '#1b2430');
    g.addColorStop(1, '#080b10');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = '#6c7786';
    ctx.lineWidth = 2;
    ctx.stroke();

    /* 可行艏向扇形（capability.polar 的 feasibleAtCur） */
    if (C && Array.isArray(C.polar) && C.polar.length) {
      ctx.save();
      ctx.strokeStyle = PALETTE.green;
      ctx.lineWidth = 6;
      ctx.globalAlpha = 0.75;
      ctx.lineCap = 'butt';
      let prev = null;
      for (const p of C.polar) {
        const rel = wrap180(p.hdg - bearing);
        if (prev && prev.feasible && p.feasibleAtCur !== false) {
          const step = wrap180(p.hdg - prev.hdg);
          ctx.beginPath();
          compassArc(ctx, cx, cy, R - 5, prev.rel, prev.rel + step);
          ctx.stroke();
        }
        prev = { hdg: p.hdg, rel, feasible: p.feasibleAtCur !== false };
      }
      ctx.restore();
    }

    /* CRAB 限幅扇区 */
    const amp = I.crabLimitDeg;
    if (amp != null && Number.isFinite(amp)) {
      ctx.save();
      ctx.beginPath();
      compassArc(ctx, cx, cy, R - 22, -amp, amp);
      ctx.arc(cx, cy, R - 12, (amp - 90) * RAD, (-amp - 90) * RAD, true);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 176, 32, 0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 176, 32, 0.55)';
      ctx.lineWidth = 1;
      for (const a of [-amp, amp]) {
        const [x0, y0] = compassPoint(cx, cy, R - 22, a);
        const [x1, y1] = compassPoint(cx, cy, R - 12, a);
        line(ctx, x0, y0, x1, y1, 'rgba(255,176,32,.8)', 1.2);
      }
      ctx.restore();
    }

    /* 罗盘卡：随艏向旋转（HDG UP） */
    for (let deg = 0; deg < 360; deg += 5) {
      const rel = wrap180(deg - bearing);
      const major = deg % 30 === 0;
      const [x0, y0] = compassPoint(cx, cy, R - 12, rel);
      const [x1, y1] = compassPoint(cx, cy, R - (major ? 24 : 17), rel);
      line(ctx, x0, y0, x1, y1,
        major ? PALETTE.white : 'rgba(220,230,245,.55)', major ? 1.6 : 0.8);
      if (major) {
        const [tx, ty] = compassPoint(cx, cy, R - 36, rel);
        const label = deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S'
          : deg === 270 ? 'W' : String(deg / 10);
        text(ctx, label, tx, ty + 4, {
          size: 10, color: PALETTE.white, align: 'center', baseline: 'middle', font: MONO,
          weight: '700',
        });
      }
    }

    /* lubber line（固定顶部） */
    ctx.beginPath();
    ctx.moveTo(cx, cy - R + 2);
    ctx.lineTo(cx - 6, cy - R + 14);
    ctx.lineTo(cx + 6, cy - R + 14);
    ctx.closePath();
    ctx.fillStyle = PALETTE.white;
    ctx.fill();

    /* 速度矢量箭头 */
    if (!I.noTrack) {
      const rel = I.arrow.relToLubberDeg;
      const len = (R - 34) * clamp(I.arrow.radiusFrac || 0.3, 0.18, 1);
      const [tx, ty] = compassPoint(cx, cy, len, rel);
      const [lx, ly] = compassPoint(cx, cy, 8, rel + 90);
      const [rx, ry] = compassPoint(cx, cy, 8, rel - 90);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(lx, ly);
      ctx.lineTo(rx, ry);
      ctx.closePath();
      ctx.fillStyle = PALETTE.cyan;
      ctx.fill();
      line(ctx, cx, cy, tx, ty, PALETTE.cyan, 2.4);
    }

    /* HDG / TRK bug */
    const bug = (relDeg, color, label) => {
      const [x0, y0] = compassPoint(cx, cy, R - 2, relDeg);
      const [x1, y1] = compassPoint(cx, cy, R - 14, relDeg);
      line(ctx, x0, y0, x1, y1, color, 2.4);
      text(ctx, label, x1, y1 - 2, {
        size: 7, color, align: 'center', font: MONO, weight: '700',
      });
    };
    bug(I.bugs.hdg.relToLubberDeg, PALETTE.cyan, 'H');
    bug(I.bugs.trk.relToLubberDeg, PALETTE.magenta, 'T');

    /* 中心与文字 */
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.white;
    ctx.fill();

    text(ctx, 'HDG↑', 8, 16, { size: 10, color: PALETTE.green, weight: '700', font: MONO });
    text(ctx, I.noTrack ? 'NO TRACK' : `SPD ${num(I.speed * MS_TO_KT, 1)} kt`,
      8, h - 24, { size: 10, color: I.noTrack ? PALETTE.amber : PALETTE.text, font: MONO });
    text(ctx, I.noTrack ? 'TRK = HOLD REF'
      : `CRAB ${num(I.crab, 0)}°${I.crabLimitDeg == null ? '' : ` / ±${num(I.crabLimitDeg, 0)}°`}`,
      8, h - 9, {
        size: 10,
        color: I.crabLimited ? PALETTE.amber : PALETTE.dim,
        font: MONO,
      });
    if (C) {
      text(ctx, `FEAS ${num(C.feasibleFraction * 100, 0)}%`, w - 8, h - 9, {
        size: 9, color: PALETTE.green, align: 'right', font: MONO,
      });
    }
  }
}

/* ========================================================================== *
 *  3. 场剖面 T / S / 预测航迹
 * ========================================================================== */
export class ProfileDisplay {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const P = frame.data.fieldProfile;
    const pts = P.points || [];
    text(ctx, 'FIELD PROFILE   T 地形 / S 场参考面 / S+gap 预测航迹', 8, 14, {
      size: 9, color: PALETTE.dim, weight: '700',
    });
    text(ctx, `${num(P.rangeM / 1000, 1)} km / ${num(P.lookaheadT, 0)} s`, w - 8, 14, {
      size: 9, color: PALETTE.dim, align: 'right', font: MONO,
    });
    if (pts.length < 2) {
      text(ctx, 'NO PROFILE', w / 2, h / 2, { size: 12, color: PALETTE.dim, align: 'center' });
      return;
    }

    const padL = 46;
    const padR = 10;
    const padT = 24;
    const padB = 34;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const dMax = Math.max(1, pts[pts.length - 1].d);
    const vals = [];
    for (const p of pts) vals.push(p.T, p.S, p.track);
    let yMin = Math.min(...vals);
    let yMax = Math.max(...vals);
    const span = Math.max(80, yMax - yMin);
    yMin -= span * 0.12;
    yMax += span * 0.12;
    const X = d => padL + (d / dMax) * plotW;
    const Y = v => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    /* 网格 */
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH * i / 4;
      const v = yMax - (yMax - yMin) * i / 4;
      line(ctx, padL, y, w - padR, y, PALETTE.grid, 1);
      text(ctx, `${num(v, 0)}`, padL - 4, y + 3, {
        size: 8, color: PALETTE.faint, align: 'right', font: MONO,
      });
    }
    for (let i = 0; i <= 4; i++) {
      const x = padL + plotW * i / 4;
      line(ctx, x, padT, x, padT + plotH, PALETTE.grid, 1);
      text(ctx, `${num(dMax * i / 4 / 1000, 1)}`, x, h - padB + 13, {
        size: 8, color: PALETTE.faint, align: 'center', font: MONO,
      });
    }
    text(ctx, 'km', w - padR, h - padB + 13, {
      size: 8, color: PALETTE.faint, align: 'right', font: MONO,
    });

    /* T 地形填充 */
    ctx.beginPath();
    ctx.moveTo(X(pts[0].d), padT + plotH);
    for (const p of pts) ctx.lineTo(X(p.d), Y(p.T));
    ctx.lineTo(X(pts[pts.length - 1].d), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(139, 90, 43, 0.38)';
    ctx.fill();

    /* T / S / track */
    const draw = (key, color, width, dash) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = X(p.d), y = Y(p[key]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    };
    draw('T', '#c98b52', 1.6);
    draw('S', PALETTE.cyan, 1.4);
    draw('track', PALETTE.amber, 2, [5, 3]);

    /* 最险处 */
    const minClr = P.clearance.min;
    const atD = P.clearance.atD;
    const mx = X(atD);
    line(ctx, mx, padT, mx, padT + plotH, 'rgba(255,77,79,.55)', 1, [3, 3]);
    const my = Y(pts.reduce((best, p) =>
      Math.abs(p.d - atD) < Math.abs(best.d - atD) ? p : best, pts[0]).track);
    ctx.beginPath();
    ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = minClr < 50 ? PALETTE.red : PALETTE.amber;
    ctx.fill();
    text(ctx, `MIN CLR ${num(minClr, 0)} m @ ${num(atD / 1000, 1)} km`,
      Math.min(mx + 6, w - 160), Math.max(padT + 12, my - 6), {
        size: 9, color: minClr < 50 ? PALETTE.red : PALETTE.amber, font: MONO, weight: '700',
      });

    /* 页脚 */
    const src = P.dirSrc || '';
    text(ctx, `DIR ${num(P.dirDeg, 0)}°  V ${num(P.V, 1)} m/s  ${src}`,
      8, h - 8, { size: 9, color: PALETTE.dim, font: MONO });
    text(ctx, `min(S−T) ${num(P.field.minExcess, 0)} m`, w - 8, h - 8, {
      size: 9, color: PALETTE.dim, align: 'right', font: MONO,
    });
  }
}

/* ========================================================================== *
 *  4. 能力极坐标
 * ========================================================================== */
export class PolarDisplay {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const C = frame.data.capability;
    const bearing = frame.data.attitude.bearing;
    const cx = w / 2;
    const cy = h / 2 + 4;
    const R = Math.min(w, h) * 0.37;

    text(ctx, 'CAPABILITY POLAR  v_max', 8, 15, {
      size: 9, color: PALETTE.dim, weight: '700',
    });

    const vMax = Math.max(10, ...C.polar.map(p => p.vMax));
    const top = Math.ceil(vMax / 5) * 5;
    const rr = v => R * clamp(v / top, 0, 1);

    /* 同心圆 + 辐条 */
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, rr(top * i / 3), 0, Math.PI * 2);
      ctx.strokeStyle = PALETTE.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      text(ctx, num(top * i / 3, 0), cx + 2, cy - rr(top * i / 3) - 2, {
        size: 7, color: PALETTE.faint, font: MONO,
      });
    }
    for (let deg = 0; deg < 360; deg += 30) {
      const [x, y] = compassPoint(cx, cy, R, deg);
      line(ctx, cx, cy, x, y, PALETTE.grid, 1);
      const [tx, ty] = compassPoint(cx, cy, R + 12, deg);
      text(ctx, deg, tx, ty + 3, {
        size: 7, color: PALETTE.faint, align: 'center', font: MONO,
      });
    }

    /* 多边形 */
    ctx.beginPath();
    C.polar.forEach((p, i) => {
      const [x, y] = compassPoint(cx, cy, rr(p.vMax), p.hdg);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(57, 200, 255, 0.16)';
    ctx.fill();
    ctx.strokeStyle = PALETTE.cyan;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    /* 当前速度可行的艏向 */
    for (const p of C.polar) {
      if (p.feasibleAtCur === false) continue;
      const [x, y] = compassPoint(cx, cy, rr(p.vMax), p.hdg);
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE.green;
      ctx.fill();
    }

    /* 当前航迹 / 风 */
    const [tx, ty] = compassPoint(cx, cy, R, C.trk);
    line(ctx, cx, cy, tx, ty, PALETTE.magenta, 1.6, [4, 3]);
    const wind = C.wind || [0, 0, 0];
    const ws = Math.hypot(wind[0], wind[1]);
    if (ws > 0.05) {
      const wdeg = Math.atan2(wind[0], wind[1]) / RAD;
      const len = R * clamp(ws / 10, 0.12, 0.8);
      const [wx, wy] = compassPoint(cx, cy, len, wdeg);
      line(ctx, cx, cy, wx, wy, PALETTE.amber, 1.4);
      text(ctx, `${num(ws, 1)}`, wx, wy - 4, {
        size: 7, color: PALETTE.amber, align: 'center', font: MONO,
      });
    }

    /* best / worst */
    const mark = (p, color, label) => {
      const [x, y] = compassPoint(cx, cy, rr(p.vMax), p.hdg);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      text(ctx, label, x + 5, y - 4, { size: 8, color, font: MONO, weight: '700' });
    };
    mark(C.best, PALETTE.green, `BEST ${num(C.best.hdg, 0)}°/${num(C.best.vMax, 1)}`);
    mark(C.worst, PALETTE.red, `WORST ${num(C.worst.hdg, 0)}°/${num(C.worst.vMax, 1)}`);

    text(ctx, `TRK ${num(C.trk, 0)}°   HDG ${num(bearing, 0)}°`, 8, h - 25, {
      size: 9, color: PALETTE.dim, font: MONO,
    });
    text(ctx, `FEASIBLE ${num(C.feasibleFraction * 100, 0)}%   ${num(ws, 1)} m/s wind`,
      8, h - 9, { size: 9, color: PALETTE.dim, font: MONO });
  }
}

/* ========================================================================== *
 *  5. 双高度带（AGL / 真实离地）
 * ========================================================================== */
export class ClearanceTape {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const A = frame.data.altimetry;
    text(ctx, 'DUAL ALTIMETRY', 8, 15, { size: 9, color: PALETTE.dim, weight: '700' });
    const max = Math.max(1200, Math.ceil((Math.max(A.gap, A.clearance) + 100) / 200) * 200);
    const top = 32;
    const bot = h - 58;

    const tape = (x, title, value, color, bug) => {
      text(ctx, title, x, 27, {
        size: 9, color, align: 'center', weight: '700', font: MONO,
      });
      roundRect(ctx, x - 15, top, 30, bot - top, 3);
      ctx.fillStyle = PALETTE.face2;
      ctx.fill();
      ctx.strokeStyle = PALETTE.line;
      ctx.lineWidth = 1;
      ctx.stroke();
      for (let v = 0; v <= max; v += 200) {
        const y = bot - (v / max) * (bot - top);
        const major = v % 400 === 0;
        line(ctx, x - 15, y, x + (major ? 6 : 0), y,
          major ? PALETTE.dim : PALETTE.faint, major ? 1.1 : 0.7);
        if (major) {
          text(ctx, v, x + 9, y + 3, {
            size: 7, color: PALETTE.faint, font: MONO,
          });
        }
      }
      /* 最小运行 AGL 红线 */
      const yMin = bot - (200 / max) * (bot - top);
      line(ctx, x - 15, yMin, x + 15, yMin, 'rgba(255,77,79,.8)', 1.4);
      /* 指令游标 */
      if (bug != null && Number.isFinite(bug)) {
        const yb = bot - (clamp(bug, 0, max) / max) * (bot - top);
        ctx.beginPath();
        ctx.moveTo(x + 16, yb);
        ctx.lineTo(x + 24, yb - 4);
        ctx.lineTo(x + 24, yb + 4);
        ctx.closePath();
        ctx.fillStyle = PALETTE.green;
        ctx.fill();
      }
      /* 当前值三角 */
      const yv = bot - (clamp(value, 0, max) / max) * (bot - top);
      ctx.beginPath();
      ctx.moveTo(x - 17, yv);
      ctx.lineTo(x - 25, yv - 5);
      ctx.lineTo(x - 25, yv + 5);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      /* 数字窗 */
      roundRect(ctx, x - 22, h - 52, 44, 22, 3);
      ctx.fillStyle = '#05080c';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();
      text(ctx, `${num(value, 0)}`, x, h - 37, {
        size: 12, color, align: 'center', font: MONO, weight: '700',
      });
      text(ctx, `${num(value * M_TO_FT, 0)} ft`, x, h - 24, {
        size: 7, color: PALETTE.dim, align: 'center', font: MONO,
      });
    };

    tape(w * 0.28, 'AGL / S', A.gap, PALETTE.white, frame.data.mcp ? frame.data.mcp.ALT.selected : null);
    tape(w * 0.72, 'CLEAR / T', A.clearance, PALETTE.amber, A.minAGL);

    text(ctx, `AMSL ${num(A.amsl, 0)} m`, 8, h - 8, {
      size: 8, color: PALETTE.dim, font: MONO,
    });
    text(ctx, `S−T ${num(A.smoothExcess, 0)} m`, w - 8, h - 8, {
      size: 8, color: PALETTE.dim, align: 'right', font: MONO,
    });
  }
}

/* ========================================================================== *
 *  6. 3×3 石头出力图
 * ========================================================================== */
export class StoneLoadDisplay {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const S = frame.data.stones;
    text(ctx, 'LIFT STONES  3×3   f / (W/9)', 8, 15, {
      size: 9, color: PALETTE.dim, weight: '700',
    });
    text(ctx, `MAX DEV ${num(S.maxDev * 100, 2)}%`, w - 8, 15, {
      size: 9, color: S.stoneDevAlarm ? PALETTE.red : PALETTE.dim,
      align: 'right', font: MONO,
    });

    const pad = 8;
    const top = 24;
    const cw = (w - pad * 2) / 3;
    const ch = (h - top - pad) / 3;

    for (const row of S.rows) {
      const col = row.idx % 3;
      const j = Math.floor(row.idx / 3);
      const dispRow = 2 - j; /* 前排在上 */
      const x = pad + col * cw;
      const y = top + dispRow * ch;
      const bx = x + 5;
      const by = y + 5;
      const bw = cw - 10;
      const bh = ch - 10;

      roundRect(ctx, bx, by, bw, bh, 4);
      ctx.fillStyle = row.failed ? '#1c0c0e' : PALETTE.face;
      ctx.fill();
      const border = row.cls === 'CORNER' ? PALETTE.amber
        : row.cls === 'EDGE' ? PALETTE.cyan : PALETTE.faint;
      ctx.strokeStyle = row.failed ? PALETTE.red : border;
      ctx.lineWidth = row.cls === 'CENTER' ? 1 : 1.8;
      ctx.stroke();

      text(ctx, `#${row.idx}`, bx + 5, by + 12, {
        size: 9, color: border, font: MONO, weight: '700',
      });
      text(ctx, row.cls, bx + bw - 5, by + 12, {
        size: 6.5, color: PALETTE.faint, align: 'right', font: MONO,
      });

      if (row.failed) {
        text(ctx, 'LOST', bx + bw / 2, by + bh / 2 + 2, {
          size: 14, color: PALETTE.red, align: 'center', weight: '700', font: MONO,
        });
        continue;
      }

      /* 出力条：0–150%，绿带 99–101%，100% 处基线 */
      const fx = bx + 6;
      const fy = by + 22;
      const fw = bw - 12;
      const fh = bh - 38;
      const v = clamp(row.frac * 100, 0, 150);
      const y100 = fy + fh * (1 - 100 / 150);
      const yv = fy + fh * (1 - v / 150);
      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(fx, fy, fw, fh);
      ctx.fillStyle = 'rgba(55,214,122,.18)';
      ctx.fillRect(fx, fy + fh * (1 - 101 / 150), fw, fh * (2 / 150));
      line(ctx, fx, y100, fx + fw, y100, PALETTE.faint, 1, [2, 2]);
      ctx.fillStyle = v > 101 ? PALETTE.amber : v < 99 ? PALETTE.cyan : PALETTE.green;
      ctx.fillRect(fx + 2, yv, fw - 4, fy + fh - yv);
      text(ctx, `${num(row.frac * 100, 1)}%`, bx + bw / 2, by + bh - 14, {
        size: 10, color: PALETTE.text, align: 'center', font: MONO, weight: '700',
      });
      if (row.saturated) {
        text(ctx, 'SAT', bx + bw / 2, by + bh - 3, {
          size: 7, color: PALETTE.red, align: 'center', font: MONO, weight: '700',
        });
      }
    }
  }
}

/* ========================================================================== *
 *  7. 推进器
 * ========================================================================== */
export class PropulsionDisplay {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const P = frame.data.propulsion;
    const D = frame.data.damping;
    text(ctx, 'PROPULSION   %W', 8, 15, { size: 9, color: PALETTE.dim, weight: '700' });

    const baseY = h - 58;
    const range = 50;
    const barH = 130;

    /* 4 垂推 */
    P.vertical.forEach((e, i) => {
      const x = 20 + i * 38;
      const pct = clamp(e.pct, -range, range);
      const yy = baseY - (pct / range) * (barH / 2);
      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(x, baseY - barH / 2, 20, barH);
      ctx.strokeStyle = PALETTE.line;
      ctx.strokeRect(x, baseY - barH / 2, 20, barH);
      ctx.fillStyle = e.failed ? PALETTE.red
        : Math.abs(pct) > 25 ? PALETTE.amber : PALETTE.green;
      if (yy < baseY) ctx.fillRect(x + 2, yy, 16, baseY - yy);
      else ctx.fillRect(x + 2, baseY, 16, yy - baseY);
      line(ctx, x, baseY, x + 20, baseY, PALETTE.faint, 1);
      text(ctx, e.name, x + 10, h - 42, {
        size: 9, color: PALETTE.dim, align: 'center', font: MONO,
      });
      text(ctx, num(pct, 1), x + 10, h - 29, {
        size: 8, color: PALETTE.text, align: 'center', font: MONO,
      });
    });

    /* 2 azimuth + APU */
    const ax = 210;
    const rowY = [50, 92, 134];
    P.azimuth.forEach((a, i) => {
      const y = rowY[i];
      text(ctx, a.name.toUpperCase(), ax, y, {
        size: 9, color: PALETTE.dim, font: MONO,
      });
      const barW = 150;
      const v = clamp(a.pct, -50, 100);
      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(ax + 48, y - 8, barW, 12);
      ctx.fillStyle = a.failed ? PALETTE.red : Math.abs(v) > 50 ? PALETTE.amber : PALETTE.green;
      const x0 = ax + 48 + barW / 2;
      if (v >= 0) ctx.fillRect(x0, y - 8, (v / 100) * (barW / 2), 12);
      else ctx.fillRect(x0 + (Math.abs(v) / 100) * (barW / 2) * -1, y - 8,
        (Math.abs(v) / 100) * (barW / 2), 12);
      line(ctx, x0, y - 10, x0, y + 6, PALETTE.faint, 1);
      text(ctx, `${num(a.pct, 1)}%  α ${num(a.alpha, 0)}°`, ax + 48 + barW + 6, y,
        { size: 8, color: PALETTE.text, font: MONO });
    });
    {
      const y = rowY[2];
      text(ctx, 'APU', ax, y + 34, { size: 9, color: PALETTE.dim, font: MONO });
      const barW = 150;
      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(ax + 48, y + 26, barW, 12);
      ctx.fillStyle = P.apu.failed ? PALETTE.red : PALETTE.cyan;
      ctx.fillRect(ax + 48, y + 26, barW * clamp(P.apu.pct / 100, 0, 1), 12);
      text(ctx, `${num(P.apu.pct, 1)}%  GEN ONLY`, ax + 48 + barW + 6, y + 36,
        { size: 8, color: PALETTE.dim, font: MONO });
    }

    /* 巡检提示 */
    const trim = D.trimPersistent ? PALETTE.amber : PALETTE.green;
    text(ctx, `PEAK ${num(D.peakThrustPct, 2)}%W`, 8, h - 9, {
      size: 9, color: trim, font: MONO, weight: '700',
    });
    text(ctx, D.trimPersistent ? 'TRIM REQUIRED' : 'ALL QUIET',
      w - 8, h - 9, { size: 9, color: trim, align: 'right', font: MONO, weight: '700' });
  }
}

/* ========================================================================== *
 *  8. 文本页
 * ========================================================================== */
function pageTitle(ctx, w, title, subtitle = '') {
  text(ctx, title, 8, 15, { size: 10, color: PALETTE.dim, weight: '700', font: MONO });
  if (subtitle) {
    text(ctx, subtitle, w - 8, 15, {
      size: 9, color: PALETTE.faint, align: 'right', font: MONO,
    });
  }
}

function pageLines(ctx, lines, x, y, gap = 15, size = 10) {
  lines.forEach((row, i) => {
    const { label, value, color } = row;
    if (value === undefined) {
      text(ctx, label, x, y + i * gap, { size, color: color || PALETTE.dim, font: MONO });
      return;
    }
    text(ctx, label, x, y + i * gap, { size, color: PALETTE.faint, font: MONO });
    text(ctx, value, x + 150, y + i * gap, {
      size, color: color || PALETTE.text, font: MONO, weight: '600',
    });
  });
}

export class PlanPage {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const P = frame.data.zRefPlan;
    const D = frame.data.damping;
    const A = frame.data.altimetry;
    pageTitle(ctx, w, 'Z-REF PLAN / DAMPING', `ETA & RATE`);
    if (!P) {
      text(ctx, 'NO CONTROL LAYER', w / 2, h / 2, {
        size: 12, color: PALETTE.amber, align: 'center', font: MONO,
      });
      return;
    }
    const lines = [
      { label: 'TARGET AGL', value: `${num(P.targetAGL, 1)} m  (${num(P.targetAGL * M_TO_FT, 0)} ft)` },
      { label: 'CURRENT AGL', value: `${num(A.gap, 1)} m` },
      { label: 'TARGET zRef', value: `${num(P.targetZRef, 1)} m` },
      { label: 'ERROR', value: `${num(P.error, 1)} m`, color: Math.abs(P.error) > 10 ? PALETTE.amber : PALETTE.text },
      { label: 'MODE', value: P.mode, color: P.mode.startsWith('EMERGENCY') ? PALETTE.amber : PALETTE.text },
      { label: 'RATE / LIMIT', value: `${num(P.rateNow, 2)} / ${num(P.rateLimit, 1)} m/s`, color: P.rateLimited ? PALETTE.amber : PALETTE.text },
      { label: 'ACC / LIMIT', value: `${num(P.accNow, 3)} / ${num(P.accLimit, 2)} m/s²` },
      { label: 'ETA 95%', value: `${num(P.eta95 / 60, 1)} min`, color: PALETTE.green },
      { label: 'ETA FULL', value: `${num(P.etaRemain / 60, 1)} min` },
      { label: 'RATE FLOOR', value: `${num(P.floorSec / 60, 1)} min` },
      { label: 'CEILING LTD', value: P.ceilingLimited ? 'YES' : 'no', color: P.ceilingLimited ? PALETTE.red : PALETTE.text },
      { label: 'HEAVE T', value: `${num(D.modes.heave.T, 2)} s` },
      { label: 'ROLL / PITCH T', value: `${num(D.modes.roll.T, 2)} / ${num(D.modes.pitch.T, 2)} s` },
      { label: 'THRUST PEAK', value: `${num(D.peakThrustPct, 2)} %W`, color: D.trimPersistent ? PALETTE.amber : PALETTE.green },
    ];
    pageLines(ctx, lines, 10, 36, 15, 10);
  }
}

export class AnnuncPage {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame) {
    const { ctx, w, h } = begin(this.canvas);
    const A = frame.data.annunciators;
    pageTitle(ctx, w, 'ANNUNCIATORS', `W${A.warning.length} C${A.caution.length} A${A.advisory.length}`);
    let y = 38;
    const levelColor = { W: PALETTE.red, C: PALETTE.amber, A: PALETTE.cyan };
    const levelName = { W: 'WARN', C: 'CAUT', A: 'ADV' };
    if (!A.list.length) {
      text(ctx, 'ALL CLEAR', w / 2, h / 2, {
        size: 14, color: PALETTE.green, align: 'center', font: MONO, weight: '700',
      });
      return;
    }
    for (const item of A.list) {
      if (y > h - 14) {
        text(ctx, `… +${A.list.length - A.list.indexOf(item)}`, 10, y, {
          size: 9, color: PALETTE.dim, font: MONO,
        });
        break;
      }
      const color = levelColor[item.level] || PALETTE.text;
      text(ctx, levelName[item.level] || item.level, 10, y, {
        size: 9, color, font: MONO, weight: '700',
      });
      text(ctx, item.code, 52, y, { size: 9, color: PALETTE.text, font: MONO, weight: '700' });
      text(ctx, item.text, 178, y, { size: 9, color: PALETTE.dim, font: MONO });
      y += 15;
    }
  }
}

export class StatusPage {
  constructor(canvas) {
    this.canvas = canvas;
  }

  render(frame, status = {}) {
    const { ctx, w, h } = begin(this.canvas);
    pageTitle(ctx, w, 'SYSTEM / DATA LINK', status.mode || '');
    const flags = frame.meta.flags;
    const env = frame.meta.environment;
    const wind = env.windWorld || [0, 0, 0];
    const windSpeed = Math.hypot(wind[0], wind[1]);
    const windDir = (Math.atan2(wind[0], wind[1]) / RAD + 360) % 360;
    const lines = [
      { label: 'LINK', value: status.link || 'unknown', color: status.link === 'online' ? PALETTE.green : PALETTE.red },
      { label: 'TRANSPORT', value: status.transport || '-' },
      { label: 'ENDPOINT', value: status.endpoint || '-' },
      { label: 'FRAME', value: `#${frame.seq}  t=${num(frame.simTime, 1)} s` },
      { label: 'FRAME AGE', value: `${num(status.ageMs, 0)} ms`, color: status.ageMs > 500 ? PALETTE.amber : PALETTE.text },
      { label: 'TERRAIN', value: frame.meta.terrainPreset },
      { label: 'WIND', value: `${num(windSpeed, 1)} m/s → ${num(windDir, 0)}°` },
      { label: 'SOURCE', value: frame.meta.controls.source, color: flags.managed ? PALETTE.green : PALETTE.amber },
      { label: 'MANAGED / AP', value: `${flags.managed ? 'ON' : 'OFF'} / ${flags.ap ? 'ON' : 'OFF'}`, color: flags.managed ? PALETTE.green : PALETTE.amber },
      { label: 'HDG AUTO', value: flags.hdgAuto ? 'ON' : 'OFF' },
      { label: 'EMERG DESC', value: flags.emergencyDescent ? 'ACTIVE' : 'off', color: flags.emergencyDescent ? PALETTE.red : PALETTE.text },
      { label: 'WARN / CAUT', value: `${frame.meta.ui.warningCount} / ${frame.meta.ui.cautionCount}`, color: frame.meta.ui.warningCount ? PALETTE.red : PALETTE.green },
      { label: 'CMD SENT', value: num(status.commandsSent, 0) },
      { label: 'LAST CMD', value: status.lastCommand || '-' },
      { label: 'ERROR', value: status.lastError || '-', color: status.lastError ? PALETTE.red : PALETTE.dim },
    ];
    pageLines(ctx, lines, 10, 38, 16, 10);
  }
}
