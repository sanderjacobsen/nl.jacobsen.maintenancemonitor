'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const {
  UNITS, todayString, isDateString, daysBetween, addDays, severity, evaluateTask,
} = require('../../lib/schedule');
const usage = require('../../lib/usage');

const HISTORY_LENGTH = 10;
const METRICS = ['hours', 'cycles', 'counter'];
const CONDITIONS = ['true', 'gt', 'equals'];
const SAVE_INTERVAL_MS = 10 * 60 * 1000; // bookkeeping-only usage changes are saved at most this often

class MaintenanceItemDevice extends Homey.Device {

  async onInit() {
    this._busy = Promise.resolve();
    this._tasks = (this.getStoreValue('tasks') || []).map(tk => ({ ...tk }));
    this._dirtySince = null;
    // Tasks chosen during pairing are stored raw; give them ids and defaults once.
    if (this._tasks.some(tk => !tk.id)) {
      await this.setTasks(this._tasks.map(({ id, ...rest }) => ({ ...rest, id: id || undefined })))
        .catch(err => this.error('Normalising tasks failed:', err.message));
    }
    await this.evaluate().catch(err => this.error('Evaluate failed:', err.message));
  }

  async onDeleted() {
    this.homey.app.syncTracking().catch(err => this.error('Sync tracking failed:', err.message));
  }

  async onUninit() {
    await this._flush().catch(() => {});
  }

  // ---------- helpers ----------

  today() {
    return todayString(this.homey.clock.getTimezone());
  }

  options() {
    const overdue = Number(this.homey.settings.get('overdue_after_days'));
    return { overdueAfterDays: Number.isFinite(overdue) && overdue > 0 ? overdue : 7 };
  }

  getTasks() {
    return this._tasks.map(tk => ({ ...tk }));
  }

  getTask(taskId) {
    const task = this.getTasks().find(tk => tk.id === taskId);
    if (!task) throw new Error(this.homey.__('errors.task_not_found'));
    return task;
  }

  getLink() {
    const link = this.getStoreValue('link');
    return link && link.id ? link : null;
  }

  // Serialise all changes to the task list, so flows, usage tracking and the settings page cannot overwrite each other.
  _exclusive(fn) {
    const run = this._busy.then(fn, fn);
    this._busy = run.catch(() => {});
    return run;
  }

  async _store(tasks) {
    this._tasks = tasks;
    this._dirtySince = null;
    await this.setStoreValue('tasks', tasks);
  }

  async _flush() {
    if (this._dirtySince) await this._store(this._tasks);
  }

  static normalizeSource(input, prev) {
    const src = input || prev;
    if (!src || !src.capability) return null;
    const metric = METRICS.includes(src.metric) ? src.metric : 'hours';
    const op = src.condition && CONDITIONS.includes(src.condition.op) ? src.condition.op : 'true';
    return {
      capability: String(src.capability).slice(0, 100),
      metric,
      condition: { op, value: op === 'gt' ? Number(src.condition.value) || 0 : (op === 'equals' ? String(src.condition.value ?? '') : null) },
      offDelayMin: Math.max(0, Math.min(120, Number(src.offDelayMin ?? 3))),
      minRunMin: Math.max(0, Math.min(600, Number(src.minRunMin ?? 1))),
      units: src.units ? String(src.units).slice(0, 20) : null,
    };
  }

  static normalizeTask(input, today, previous) {
    const prev = previous || {};
    const type = ['counter', 'usage'].includes(input.type) ? input.type : 'date';
    const name = String(input.name || '').trim().slice(0, 80);
    if (!name) throw new Error('Task name is required');
    const source = type === 'usage' ? MaintenanceItemDevice.normalizeSource(input.source, prev.source) : null;
    const sameSource = source && prev.source && JSON.stringify(source) === JSON.stringify(prev.source);
    return {
      id: input.id || prev.id || crypto.randomUUID(),
      key: input.key || prev.key || null,
      basis: (input.basis || prev.basis) === 'install' ? 'install' : 'last',
      name,
      type,
      every: Math.max(1, Math.round(Number(input.every) || prev.every || 1)),
      unit: UNITS.includes(input.unit) ? input.unit : (prev.unit || 'months'),
      leadDays: Math.max(0, Math.round(Number(input.leadDays ?? prev.leadDays ?? 7))),
      threshold: Math.max(0.01, Number(input.threshold) || prev.threshold || 100),
      leadPercent: Math.min(100, Math.max(0, Number(input.leadPercent ?? prev.leadPercent ?? 10))),
      counter: Math.max(0, Number(input.counter ?? prev.counter ?? 0)),
      source,
      combine: type === 'usage' ? Boolean(input.combine ?? prev.combine) : false,
      usage: Math.max(0, Number(input.usage ?? prev.usage ?? 0)),
      track: sameSource ? (prev.track || usage.defaultTrack()) : usage.defaultTrack(),
      lastDone: isDateString(input.lastDone) ? input.lastDone : (prev.lastDone || today),
      snoozeUntil: isDateString(input.snoozeUntil) ? input.snoozeUntil : (input.snoozeUntil === null ? null : prev.snoozeUntil || null),
      dueSince: prev.dueSince || null,
      notified: prev.notified || 'ok',
      history: Array.isArray(input.history) ? input.history.filter(isDateString).slice(0, HISTORY_LENGTH) : (prev.history || []),
      note: String(input.note ?? prev.note ?? '').slice(0, 500),
    };
  }

  // ---------- public API (used by app API, flow cards and usage tracking) ----------

  async setTasks(inputTasks) {
    const result = await this._exclusive(async () => {
      if (!Array.isArray(inputTasks)) throw new Error('tasks must be an array');
      const today = this.today();
      const old = this.getTasks();
      const tasks = inputTasks.map(input => {
        const previous = old.find(tk => tk.id && tk.id === input.id);
        const task = MaintenanceItemDevice.normalizeTask(input, today, previous);
        // A changed interval, date or amount resets the notification state, so the user is reminded again correctly.
        if (previous && ['lastDone', 'every', 'unit', 'type', 'threshold', 'counter', 'usage', 'combine']
          .some(key => previous[key] !== task[key])) {
          task.notified = 'ok';
          task.dueSince = null;
        }
        return task;
      });
      await this._store(tasks);
      return this._evaluate();
    });
    await this.homey.app.syncTracking().catch(err => this.error('Sync tracking failed:', err.message));
    return result;
  }

  async setLink(link) {
    await this._exclusive(async () => {
      await this.setStoreValue('link', link && link.id ? { id: String(link.id), name: String(link.name || '') } : null);
      // A different device means different measurements: reset usage bookkeeping.
      const tasks = this.getTasks();
      for (const task of tasks) task.track = usage.defaultTrack();
      await this._store(tasks);
    });
    await this.homey.app.syncTracking().catch(err => this.error('Sync tracking failed:', err.message));
  }

  async markDone(taskId, date) {
    return this._exclusive(async () => {
      const today = this.today();
      const doneDate = isDateString(date) && daysBetween(date, today) >= 0 ? date : today;
      const tasks = this.getTasks();
      const task = tasks.find(tk => tk.id === taskId);
      if (!task) throw new Error(this.homey.__('errors.task_not_found'));
      task.lastDone = doneDate;
      task.counter = 0;
      if (task.type === 'usage') usage.resetUsage(task, Date.now());
      task.snoozeUntil = null;
      task.dueSince = null;
      task.notified = 'ok';
      task.history = [doneDate, ...(task.history || [])].slice(0, HISTORY_LENGTH);
      await this._store(tasks);
      return this._evaluate();
    });
  }

  async markAllOpenDone() {
    const states = await this.evaluate();
    for (const state of states.filter(s => severity(s.status) >= severity('due'))) {
      await this.markDone(state.id);
    }
  }

  getInstallDate() {
    const value = this.getStoreValue('installDate');
    return isDateString(value) ? value : null;
  }

  // Installation date of the item. Tasks counted from installation (e.g. 'replace') follow it until they are done once.
  async setInstallDate(date) {
    return this._exclusive(async () => {
      const today = this.today();
      let installDate = isDateString(date) ? date : null;
      if (installDate && daysBetween(installDate, today) < 0) installDate = today;
      await this.setStoreValue('installDate', installDate);
      if (installDate) {
        const tasks = this.getTasks();
        for (const task of tasks.filter(tk => tk.basis === 'install' && !(tk.history || []).length)) {
          task.lastDone = installDate;
          task.notified = 'ok';
          task.dueSince = null;
        }
        await this._store(tasks);
      }
      return this._evaluate();
    });
  }

  async snooze(taskId, days) {
    return this._exclusive(async () => {
      const tasks = this.getTasks();
      const task = tasks.find(tk => tk.id === taskId);
      if (!task) throw new Error(this.homey.__('errors.task_not_found'));
      task.snoozeUntil = addDays(this.today(), Math.max(1, Math.round(Number(days) || 1)));
      task.notified = 'ok';
      task.dueSince = null;
      await this._store(tasks);
      return this._evaluate();
    });
  }

  async incrementCounter(taskId, amount) {
    return this._exclusive(async () => {
      const tasks = this.getTasks();
      const task = tasks.find(tk => tk.id === taskId);
      if (!task) throw new Error(this.homey.__('errors.task_not_found'));
      if (task.type !== 'counter') throw new Error(this.homey.__('errors.not_a_counter'));
      task.counter = Math.max(0, (Number(task.counter) || 0) + (Number(amount) || 0));
      await this._store(tasks);
      return this._evaluate();
    });
  }

  // Capabilities of the linked device that usage tasks listen to.
  getTrackedCapabilities() {
    return [...new Set(this._tasks.filter(tk => tk.type === 'usage' && tk.source).map(tk => tk.source.capability))];
  }

  // New value of a capability of the linked device.
  async applyUsage(capability, value) {
    return this._exclusive(async () => {
      const now = Date.now();
      let result = null;
      for (const task of this._tasks.filter(tk => tk.type === 'usage' && tk.source && tk.source.capability === capability)) {
        const r = usage.applyValue(task, value, now);
        if (r === 'event') result = 'event';
        else if (r === 'change' && !result) result = 'change';
      }
      await this._afterUsage(result);
    });
  }

  // Called every minute by the app: ends runs after their off-delay and adds running hours.
  async tickUsage() {
    return this._exclusive(async () => {
      const now = Date.now();
      let result = null;
      for (const task of this._tasks.filter(tk => tk.type === 'usage' && tk.source)) {
        const r = usage.tick(task, now);
        if (r === 'event') result = 'event';
        else if (r === 'change' && !result) result = 'change';
      }
      await this._afterUsage(result);
    });
  }

  async _afterUsage(result) {
    if (!result) return;
    if (!this._dirtySince) this._dirtySince = Date.now();
    // Starts, stops and counter steps are saved and evaluated right away; running time at most every 10 minutes.
    if (result === 'event' || Date.now() - this._dirtySince >= SAVE_INTERVAL_MS) {
      await this._flush();
      await this._evaluate();
    }
  }

  async evaluate() {
    return this._exclusive(() => this._evaluate());
  }

  // ---------- evaluation ----------

  async _evaluate() {
    const today = this.today();
    const options = this.options();
    const tasks = this._tasks;
    const events = [];
    let changed = false;

    const states = tasks.map(task => {
      const state = evaluateTask(task, today, options);

      // Amount-based tasks: remember when they became due, to detect "overdue".
      if (state.amountStatus) {
        if (severity(state.amountStatus) >= severity('due') && !task.dueSince) {
          task.dueSince = today;
          changed = true;
        } else if (severity(state.amountStatus) < severity('due') && task.dueSince) {
          task.dueSince = null;
          changed = true;
        }
      }

      // Notify each escalation exactly once; going back (done/postponed) resets silently.
      const before = severity(task.notified || 'ok');
      const now = severity(state.status);
      if (now > before) {
        events.push({ task, state });
        task.notified = state.status;
        changed = true;
      } else if (now < before) {
        task.notified = state.status;
        changed = true;
      }
      return { ...task, ...state };
    });

    if (changed) await this._store(tasks);
    await this._updateCapabilities(states);
    for (const { task, state } of events) {
      await this._announce(task, state).catch(err => this.error('Announce failed:', err.message));
    }
    return states;
  }

  async _updateCapabilities(states) {
    const open = states.filter(s => severity(s.status) >= severity('due'));
    const dated = states.filter(s => s.days !== null).sort((a, b) => a.days - b.days);
    const next = open[0] || dated[0] || states[0];

    let nextText = this.homey.__('device.no_tasks');
    if (next) {
      nextText = next.days !== null && !(next.amountStatus && severity(next.amountStatus) >= severity(next.status))
        ? `${next.name} (${this.homey.__(`status.${next.status}`)}, ${this._daysText(next.days)})`
        : `${next.name} (${Math.round((next.progress || 0) * 100)}%)`;
    }

    await this._setCap('alarm_maintenance', open.length > 0);
    await this._setCap('maintenance_open', open.length);
    await this._setCap('maintenance_days', dated.length ? dated[0].days : null);
    await this._setCap('maintenance_next', nextText);
  }

  async _setCap(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) !== value) await this.setCapabilityValue(capability, value);
  }

  _daysText(days) {
    if (days > 0) return this.homey.__('device.in_days', { days });
    if (days === 0) return this.homey.__('device.today');
    return this.homey.__('device.days_late', { days: -days });
  }

  async _announce(task, state) {
    // Was it the date or the amount (counter/usage) that triggered this status?
    const byAmount = state.amountStatus && severity(state.amountStatus) >= severity(state.status);
    const days = byAmount || state.days === null ? 0 : Math.abs(state.days);
    const tokens = { item: this.getName(), task: task.name, days };

    // Own notification in the Homey timeline (can also be pushed via Homey settings > Notifications).
    if (this.homey.settings.get(`notify_${state.status}`) !== false) {
      const key = byAmount ? `notify.${state.status}_counter` : `notify.${state.status}`;
      await this.homey.notifications.createNotification({
        excerpt: this.homey.__(key, { item: this.getName(), task: task.name, days }),
      });
    }

    await this.homey.flow.getTriggerCard(`task_${state.status}`).trigger(tokens)
      .catch(err => this.error('App trigger failed:', err.message));
    await this.homey.flow.getDeviceTriggerCard(`item_task_${state.status}`).trigger(this, { task: task.name, days })
      .catch(err => this.error('Device trigger failed:', err.message));
  }

}

module.exports = MaintenanceItemDevice;
