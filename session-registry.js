"use strict";

/** Independent pi conversation: one process, one prompt queue, one revision. */
class SessionController {
  constructor({ id, label, cwd, client, turns, onEvent }) {
    this.id = id;
    this.label = label;
    this.cwd = cwd;
    this.client = client;
    this.turns = turns;
    this.onEvent = onEvent;
    this.streaming = false;
    this.compacting = false;
    this.sessionChanging = true;
    this.revision = 0;
    this.activityVersion = 0;
    this.stateRequest = 0;
    this.statsRequest = 0;
    this.clientReady = null;
    this.model = "";
    this.sessionName = "";
    this.thinkingLevel = null;
    this.stats = { tokens: 0, cost: 0, contextPercent: null };
    this.completed = false;
  }

  get busy() {
    return this.sessionChanging || this.streaming || this.compacting || this.turns.busy || this.turns.pendingCount > 0;
  }

  isCurrent(client, revision = this.revision) {
    return client === this.client && !!client && !client.exited && revision === this.revision;
  }

  emit(message) {
    this.onEvent({ ...message, sessionId: this.id });
  }
}

class SessionRegistry {
  constructor({ limit = 6 } = {}) {
    this.limit = limit;
    this.sessions = new Map();
    this.activeId = null;
    this.nextId = 1;
  }

  create(cwd) {
    if (this.sessions.size >= this.limit) return null;
    const id = `s${this.nextId++}`;
    const session = new SessionController({ id, label: `Task ${this.sessions.size + 1}`, cwd });
    this.sessions.set(id, session);
    this.activeId = id;
    return session;
  }

  get(id) { return this.sessions.get(id); }
  active() { return this.get(this.activeId); }
  list() { return [...this.sessions.values()]; }
  anyBusy() { return this.list().some((s) => s.busy); }

  remove(id) {
    const session = this.get(id);
    if (!session) return null;
    this.sessions.delete(id);
    if (this.activeId === id) this.activeId = this.list().at(-1)?.id || null;
    return session;
  }
}

module.exports = { SessionController, SessionRegistry };
