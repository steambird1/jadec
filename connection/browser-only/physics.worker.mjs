/* ============================================================================
 *  physics.worker.mjs —— browser-only 部署的物理后台
 *
 *  主线程（仪表 UI）与 Worker 之间只传 JSON 可克隆对象：
 *    主 → Worker : { type:'commands', commands:[...] }
 *                  { type:'setRate', hz }
 *                  { type:'pause' } / { type:'resume' }
 *    Worker → 主 : { type:'ready', info }
 *                  { type:'frame', ... }       = SimCore 帧
 *                  { type:'ack', results }     = 命令执行结果
 *                  { type:'error', message }
 *
 *  物理时间由 Worker 自己的 setInterval 推进，与 UI 的渲染帧率解耦。
 * ========================================================================== */
'use strict';

import { SimCore } from '../shared/sim-core.mjs';
import { physics } from './physics-bundle.mjs';

const TICK_MS = 50;          /* 20 Hz，与控制节拍 0.05 s 一致 */

let sim = null;
let timer = null;
let lastTick = 0;
let paused = false;
let tickMs = TICK_MS;

function boot() {
  try {
    sim = new SimCore(physics, { terrainPreset: 'flat' });
    self.postMessage({
      type: 'ready',
      info: {
        mode: 'browser-only',
        physics: 'web-worker',
        tickHz: Math.round(1000 / tickMs),
        protocol: 1,
        terrainPreset: sim.frame.meta.terrainPreset,
      },
    });
    self.postMessage(sim.frame);
    start();
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error && error.stack || error) });
  }
}

function start() {
  stop();
  lastTick = performance.now();
  timer = setInterval(tick, tickMs);
}

function stop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function tick() {
  if (!sim || paused) {
    lastTick = performance.now();
    return;
  }
  const now = performance.now();
  const dt = Math.min(0.25, Math.max(0, (now - lastTick) / 1000));
  lastTick = now;
  try {
    const frame = sim.step(dt || tickMs / 1000);
    self.postMessage(frame);
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error && error.stack || error) });
  }
}

self.addEventListener('message', event => {
  const message = event.data || {};
  if (!sim) return;

  switch (message.type) {
    case 'commands': {
      try {
        const results = sim.applyCommands(message.commands || []);
        const failed = results.filter(r => !r.ok);
        self.postMessage({ type: 'ack', results });
        if (failed.length) {
          self.postMessage({
            type: 'error',
            message: failed.map(f => `${f.action}: ${f.error}`).join('; '),
          });
        }
      } catch (error) {
        self.postMessage({ type: 'error', message: String(error && error.stack || error) });
      }
      break;
    }
    case 'setRate': {
      const hz = Math.max(5, Math.min(60, Number(message.hz) || 20));
      tickMs = Math.round(1000 / hz);
      start();
      break;
    }
    case 'pause':
      paused = true;
      break;
    case 'resume':
      paused = false;
      lastTick = performance.now();
      break;
    case 'ping':
      self.postMessage({ type: 'pong', at: Date.now() });
      break;
    default:
      break;
  }
});

boot();
