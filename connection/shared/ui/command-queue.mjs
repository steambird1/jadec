/* ============================================================================
 *  command-queue.mjs —— 输入命令的合并与节流
 *
 *  旋钮拖动会以每秒上百次触发 change；如果每次都发一条命令：
 *    - SSE/HTTP 部署会把服务器打满；
 *    - Worker 部署会堆积消息；
 *    - 物理侧只关心“最终位置”，中间值没有意义。
 *
 *  因此连续量按 coalesceKey 合并（同一键只保留最后一条），
 *  按钮类命令保持顺序、不合并。
 * ========================================================================== */
'use strict';

export class CommandQueue {
  /**
   * @param {(commands: object[]) => void} send
   * @param {{delayMs?: number}} [options]
   */
  constructor(send, options = {}) {
    this.send = send;
    this.delayMs = options.delayMs ?? 30;
    this.queue = [];
    this.keys = new Map();
    this.timer = null;
    this.sent = 0;
  }

  push(command, coalesceKey = null) {
    if (coalesceKey) {
      const index = this.keys.get(coalesceKey);
      if (index !== undefined && index < this.queue.length) {
        this.queue[index] = command;
      } else {
        this.keys.set(coalesceKey, this.queue.length);
        this.queue.push(command);
      }
    } else {
      this.queue.push(command);
    }
    this._schedule();
  }

  _schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
  }

  flush() {
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    this.keys.clear();
    this.sent += batch.length;
    try {
      this.send(batch);
    } catch (error) {
      console.error('[command-queue] send failed:', error);
    }
  }

  clear() {
    this.queue = [];
    this.keys.clear();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
