/* ============================================================================
 *  main.mjs —— browser-server：前端（仅 UI，不含任何物理）
 *
 *  数据流：
 *      GET /api/stream  (SSE, 20 Hz)  → CockpitUI.applyFrame(frame)
 *      POST /api/command (HTTP)       ← CommandQueue（合并连续量）
 *
 *  EventSource 自带断线重连；服务器重启后无需刷新页面。
 * ========================================================================== */
'use strict';

import { CockpitUI } from '../shared/ui/cockpit-ui.mjs';
import { CommandQueue } from '../shared/ui/command-queue.mjs';

const linkBadge = document.getElementById('link-badge');
const modeBadge = document.getElementById('mode-badge');
const frameBadge = document.getElementById('frame-badge');

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
  let inflight = Promise.resolve();

  const ui = new CockpitUI({
    container: document.getElementById('panels-container'),
    project,
    mode: 'browser-server',
    onCommand: (command, key) => queue.push(command, key),
  });

  setBadge(modeBadge, 'MODE · NODE SERVER', 'online');
  ui.setLinkState({
    link: 'connecting',
    transport: 'SSE + HTTP',
    endpoint: '/api/stream',
  });
  setBadge(linkBadge, 'SSE CONNECTING', 'connecting');

  queue = new CommandQueue(commands => {
    /* 串行发送，保证按钮顺序（旋钮已在队列内合并） */
    inflight = inflight.then(async () => {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands }),
      });
      const payload = await response.json().catch(() => ({}));
      const results = Array.isArray(payload.results) ? payload.results : [];
      const failed = results.filter(item => !item.ok);
      if (failed.length) {
        ui.setError(failed.map(item => `${item.action}: ${item.error}`).join('; '));
      } else if (!response.ok) {
        ui.setError(payload.error || `HTTP ${response.status}`);
      } else {
        ui.setError('');
      }
    }).catch(error => {
      ui.setError(`命令发送失败: ${error.message || error}`);
      setBadge(linkBadge, 'COMMAND FAILED', 'error');
    });
  }, { delayMs: 30 });

  const source = new EventSource('/api/stream');

  source.addEventListener('hello', event => {
    try {
      const hello = JSON.parse(event.data);
      ui.setLinkState({
        transport: `SSE ${hello.tickHz || 20} Hz`,
        endpoint: hello.endpoint || '/api/stream',
      });
    } catch (error) { /* ignore */ }
  });

  source.addEventListener('frame', event => {
    try {
      const frame = JSON.parse(event.data);
      ui.applyFrame(frame);
      if (ui.status.link !== 'online') {
        ui.setLinkState({ link: 'online', lastError: '' });
      }
      setBadge(linkBadge, `SSE · #${frame.seq}`, 'online');
      setBadge(frameBadge, `t ${frame.simTime.toFixed(1)} s`, 'online');
    } catch (error) {
      console.error('[browser-server] bad frame', error);
      ui.setError('帧解析失败: ' + error.message);
    }
  });

  source.addEventListener('open', () => {
    setBadge(linkBadge, 'SSE CONNECTED', 'connecting');
  });

  source.addEventListener('error', () => {
    /* EventSource 会自动重连；这里只做状态提示，不关闭连接 */
    if (ui.status.link !== 'error') {
      ui.setLinkState({ link: 'connecting', lastError: 'SSE 断线，正在重连…' });
    }
    setBadge(linkBadge, 'SSE RECONNECTING', 'connecting');
  });

  /* 断流检测（EventSource 可能处于“已连接但服务器不再发帧”） */
  setInterval(() => {
    if (!ui.lastFrame) return;
    const age = Math.max(0, Date.now() - Number(ui.lastFrame.wallTime || 0));
    ui.setLinkState({ ageMs: age });
    if (age > 3000) {
      ui.setLinkState({ link: 'error', lastError: '超过 3 s 未收到服务器帧' });
      setBadge(linkBadge, 'NO DATA', 'error');
    }
  }, 1000);

  window.addEventListener('beforeunload', () => {
    try { source.close(); } catch (error) { /* ignore */ }
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
