"use strict";

/**
 * One prompt at a time, with preparation between settled agent runs. Keeping
 * follow-ups here (rather than in pi's queue) lets every prompt take its own
 * checkpoint immediately before dispatch. No VS Code or RPC dependencies.
 */
class TurnQueue {
  constructor({ prepare, send, onChange = () => {} }) {
    this.prepare = prepare;
    this.send = send;
    this.onChange = onChange;
    this.items = [];
    this.active = null;
    this.running = false;
    this.paused = true;
    this.generation = 0;
  }

  get busy() {
    return this.running || this.active !== null;
  }

  get pendingCount() {
    return this.items.length;
  }

  enqueue(value) {
    const result = new Promise((resolve, reject) => {
      this.items.push({ value, resolve, reject, dispatched: false });
    });
    this.onChange();
    this._drain();
    return result;
  }

  setBusy(value) {
    this.running = !!value;
    this.onChange();
    this._drain();
  }

  setPaused(value) {
    this.paused = !!value;
    this.onChange();
    this._drain();
  }

  /** Invalidate in-flight preparation and return the prompts not yet sent. */
  cancel() {
    this.generation++;
    const pending = this.items.splice(0);
    if (this.active) {
      if (!this.active.dispatched) pending.unshift(this.active);
      else this.active.resolve(false);
    }
    this.active = null;
    this.running = false;
    for (const item of pending) item.resolve(false);
    this.onChange();
    return pending.map((item) => item.value);
  }

  async _drain() {
    if (this.paused || this.busy || !this.items.length) return;
    const item = this.items.shift();
    const generation = this.generation;
    this.active = item;
    const isCurrent = () => generation === this.generation && this.active === item;
    this.onChange();
    try {
      const prepared = await this.prepare(item.value, isCurrent);
      if (!isCurrent()) return;
      // A background extension or compaction may have started while preparing.
      // Retry preparation after it settles; do not enqueue a stale snapshot in pi.
      if (this.running || this.paused) {
        this.items.unshift(item);
        return;
      }
      item.dispatched = true;
      this.running = true; // reserve the turn until events/get_state release it
      this.onChange();
      await this.send(prepared, isCurrent);
      if (isCurrent()) item.resolve(true);
    } catch (err) {
      if (isCurrent()) {
        this.running = false;
        item.reject(err);
      }
    } finally {
      if (isCurrent()) {
        this.active = null;
        this.onChange();
        this._drain();
      }
    }
  }
}

module.exports = { TurnQueue };
