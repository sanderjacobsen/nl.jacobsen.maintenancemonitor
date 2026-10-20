'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const {
  UNITS, todayString, isDateString, daysBetween, addDays, severity, evaluateTask,
} = require('../../lib/schedule');

const HISTORY_LENGTH = 10;

class MaintenanceItemDevice extends Homey.Device {

  async onInit() {
    this._busy = Promise.resolve();
    // Tasks chosen during pairing are stored raw; give them ids and defaults once.
    const raw = this.getStoreValue('tasks') || [];
    if (raw.some(tk => !tk.id)) {
      await this.setTasks(raw.map(({ id, ...rest }) => ({ ...rest, id: id || undefined })))
        .catch(err => this.error('Normalising tasks failed:', err.message));
    }
    await this.evaluate().catch(err => this.error('Evaluate failed:', err.message));
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
    return (this.getStoreValue('tasks') || []).map(tk => ({ ...tk }));
  }

  getTask(taskId) {
    const task = this.getTasks().find(tk => tk.id === taskId);
    if (!task) throw new Error(this.homey.__('errors.task_not_found'));
    return task;
  }

  // Serialise all changes to the task list, so a flow and the settings page cannot overwrite each other.
  _exclusive(fn) {
    const run = this._busy.then(fn, fn);
    this._busy = run.catch(() => {});
    return run;
  }

  static normalizeTask(input, today, previous) {
    const prev = previous || {};
    const type = input.type === 'counter' ? 'counter' : 'date';
    const name = String(input.name || '').trim().slice(0, 80);
    if (!name) throw new Error('Task name is required');
    const task = {
      id: input.id || prev.id || crypto.randomUUID(),
      key: input.key || prev.key || null,
      basis: (input.basis || prev.basis) === 'install' ? 'install' : 'last',
      name,
      type,
      every: Math.max(1, Math.round(Number(input.every) || prev.every || 1)),
      unit: UNITS.includes(input.unit) ? input.unit : (prev.unit || 'months'),
      leadDays: Math.max(0, Math.round(Number(input.leadDays ?? prev.leadDays ?? 7))),
      threshold: Math.max(1, Number(input.threshold) || prev.threshold || 100),
      leadPercent: Math.min(100, Math.max(0, Number(input.leadPercent ?? prev.leadPercent ?? 10))),
      counter: Math.max(0, Number(input.counter ?? prev.counter ?? 0)),
      lastDone: isDateString(input.lastDone) ? input.lastDone : (prev.lastDone || today),
      snoozeUntil: isDateString(input.snoozeUntil) ? input.snoozeUntil : (input.snoozeUntil === null ? null : prev.snoozeUntil || null),
      dueSince: prev.dueSince || null,
      notified: prev.notified || 'ok',
      history: Array.isArray(input.history) ? input.history.filter(isDateString).slice(0, HISTORY_LENGTH) : (prev.history || []),
      note: String(input.note ?? prev.note ?? '').slice(0, 500),
    };
    return task;
  }

  // ---------- public API (used by app API and flow cards) ----------

  async setTasks(inputTasks) {
    return this._exclusive(async () => {
      if (!Array.isArray(inputTasks)) throw new Error('tasks must be an array');
      const today = this.today();
      const old = this.getTasks();
      const tasks = inputTasks.map(input => {
        const previous = old.find(tk => tk.id && tk.id === input.id);
        const task = MaintenanceItemDevice.normalizeTask(input, today, previous);
        // A changed interval or date resets the notification state, so the user is reminded again correctly.
        if (previous && (previous.lastDone !== task.lastDone || previous.every !== task.every || previous.unit !== task.unit
          || previous.type !== task.type || previous.threshold !== task.threshold || previous.counter !== task.counter)) {
          task.notified = 'ok';
          task.dueSince = null;
        }
        return task;
      });
      await this.setStoreValue('tasks', tasks);
      return this._evaluate();
    });
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
      task.snoozeUntil = null;
      task.dueSince = null;
      task.notified = 'ok';
      task.history = [doneDate, ...(task.history || [])].slice(0, HISTORY_LENGTH);
      await this.setStoreValue('tasks', tasks);
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
        await this.setStoreValue('tasks', tasks);
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
      await this.setStoreValue('tasks', tasks);
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
      await this.setStoreValue('tasks', tasks);
      return this._evaluate();
    });
  }

  async evaluate() {
    return this._exclusive(() => this._evaluate());
  }

  // ---------- evaluation ----------

  async _evaluate() {
    const today = this.today();
    const options = this.options();
    const tasks = this.getTasks();
    const events = [];
    let changed = false;

    const states = tasks.map(task => {
      const state = evaluateTask(task, today, options);

      // Counter tasks: remember when they became due, to detect "overdue".
      if (task.type === 'counter') {
        if (severity(state.status) >= severity('due') && !task.dueSince) {
          task.dueSince = today;
          changed = true;
        } else if (severity(state.status) < severity('due') && task.dueSince) {
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

    if (changed) await this.setStoreValue('tasks', tasks);
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
      nextText = next.days !== null
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
    const days = state.days === null ? 0 : Math.abs(state.days);
    const tokens = { item: this.getName(), task: task.name, days };

    // Own notification in the Homey timeline (can also be pushed via Homey settings > Notifications).
    if (this.homey.settings.get(`notify_${state.status}`) !== false) {
      const key = state.days === null ? `notify.${state.status}_counter` : `notify.${state.status}`;
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
