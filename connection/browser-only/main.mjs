/* ============================================================================
 *  main.mjs —— browser-only：UI 主线程
 *
 *  数据流：
 *      physics.worker.mjs（JadeChamber + FlightControl + InstrumentSuite）
 *          │  postMessage(frame) 20 Hz
 *          ▼
 *      CockpitUI（panel/ 组件 + Canvas 仪表）
 *          │  用户操作 → CommandQueue（合并连续量）
 *          ▼
 *      postMessage({type:'commands'})
 * ========================================================================== */
'use strict';

import { CockpitUI } from '../shared/ui/cockpit-ui.mjs';
import { CommandQueue } from '../shared/ui/command-queue.mjs';

const linkBadge = document.getElementById('link-badge');
const modeBadge = document.getElementById('mode-badge');
const frameBadge = document.getElementById('frame-badge');
const pauseButton = document.getElementById('btn-pause');

function setBadge(element, text, state) {
  if (!element) return;
  element.textContent = text;
  if (state) element.dataset.state = state;
}

async function boot() {
  const projectUrl = new URL('../shared/panels/jade-cockpit.json', import.meta.url);
  const response = await fetch(projectUrl);
  if (!response.ok) throw new Error(`面板定义加载失败: HTTP ${response.status}`);
  const project = await response.json();

  let queue = null;
  let worker = null;
  let paused = false;

  const ui = new CockpitUI({
    container: document.getElementById('panels-container'),
    project,
    mode: 'browser-only',
    onCommand: (command, key) => queue.push(command, key),
  });

  setBadge(modeBadge, 'MODE · BROWSER WORKER', 'online');
  ui.setLinkState({
    link: 'connecting',
    transport: 'Web Worker',
    endpoint: 'physics.worker.mjs',
  });
  setBadge(linkBadge, 'WORKER STARTING', 'connecting');

  worker = new Worker(new URL('./physics.worker.mjs', import.meta.url), { type: 'module' });

  queue = new CommandQueue(commands => {
    worker.postMessage({ type: 'commands', commands });
  }, { delayMs: 30 });

  worker.addEventListener('message', event => {
    const message = event.data || {};
    switch (message.type) {
      case 'ready':
        ui.setLinkState({ link: 'online', lastError: '' });
        setBadge(linkBadge, 'WORKER ONLINE', 'online');
        break;
      case 'frame':
        ui.applyFrame(message);
        if (ui.status.link !== 'online') {
          ui.setLinkState({ link: 'online', lastError: '' });
        }
        setBadge(linkBadge, `WORKER · #${message.seq}`, 'online');
        setBadge(frameBadge, `t ${message.simTime.toFixed(1)} s`, 'online');
        break;
      case 'ack': {
        const failed = (message.results || []).filter(r => !r.ok);
        if (failed.length) ui.setError(failed.map(f => `${f.action}: ${f.error}`).join('; '));
        else ui.setError('');
        break;
      }
      case 'error':
        ui.setLinkState({ link: 'error', lastError: message.message || 'worker error' });
        setBadge(linkBadge, 'WORKER ERROR', 'error');
        break;
      default:
        break;
    }
  });

  worker.addEventListener('error', event => {
    const message = event.message || 'Worker 加载失败';
    ui.setLinkState({ link: 'error', lastError: message });
    setBadge(linkBadge, 'WORKER OFFLINE', 'error');
    console.error('[browser-only] worker error', event);
  });

  if (pauseButton) {
    pauseButton.addEventListener('click', () => {
      paused = !paused;
      worker.postMessage({ type: paused ? 'pause' : 'resume' });
      pauseButton.textContent = paused ? 'RESUME' : 'PAUSE';
      setBadge(linkBadge, paused ? 'WORKER PAUSED' : 'WORKER ONLINE',
        paused ? 'connecting' : 'online');
    });
  }

  /* 断流检测：Worker 崩掉时 setInterval 也会停，UI 必须自己发现 */
  setInterval(() => {
    if (!ui.lastFrame) return;
    const age = Math.max(0, Date.now() - Number(ui.lastFrame.wallTime || 0));
    ui.setLinkState({ ageMs: age });
    if (age > 3000 && !paused) {
      ui.setLinkState({ link: 'error', lastError: '超过 3 s 未收到物理帧' });
      setBadge(linkBadge, 'NO DATA', 'error');
    }
  }, 1000);

  window.addEventListener('beforeunload', () => {
    try { worker.terminate(); } catch (error) { /* ignore */ }
  });
}

boot().catch(error => {
  console.error(error);
  setBadge(linkBadge, 'BOOT FAILED', 'error');
  const container = document.getElementById('panels-container');
  if (container) {
    container.innerHTML =
      `<pre style="color:#ff9a9a;padding:20px;white-space:pre-wrap">启动失败：\n${String(error && error.stack || error)}</pre>`;
  }
});
