'use strict';

const crypto = require('crypto');
const {
  UNITS, todayString, isDateString, daysBetween, addDays, severity, evaluateTask,
} = require('./schedule');
const usage = require('./usage');
const { getCategory } = require('./templates');

const HISTORY_LENGTH = 10;
const METRICS = ['hours', 'cycles', 'counter', 'level'];
const CONDITIONS = ['true', 'gt', 'equals'];
const AUTO_DONE_OPS = ['true', 'equals', 'contains'];
const SAVE_INTERVAL_MS = 10 * 60 * 1000; // bookkeeping-only usage changes are saved at most this often
const STORE_KEY = 'items';

/**
 * All maintenance items and their tasks. Items are not Homey devices: they live in the app settings, so the
 * device list does not get a duplicate of every appliance. One "Maintenance Monitor" overview device shows the summary.
 */
class ItemManager {

  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this._items = (this.homey.settings.get(STORE_KEY) || []).map(item => ({ ...item, tasks: (item.tasks || []).map(tk => ({ ...tk })) }));
    this._busy = Promise.resolve();
    this._dirtySince = null;
  }

  // ---------- helpers ----------

  today() {
    return todayString(this.homey.clock.getTimezone());
  }

  options() {
    const overdue = Number(this.homey.settings.get('overdue_after_days'));
    return { overdueAfterDays: Number.isFinite(overdue) && overdue > 0 ? overdue : 7 };
  }

  // Serialise all changes, so flows, usage tracking and the settings page cannot overwrite each other.
  _exclusive(fn) {
    const run = this._busy.then(fn, fn);
    this._busy = run.catch(() => {});
    return run;
  }

  _save() {
    this._dirtySince = null;
    this.homey.settings.set(STORE_KEY, this._items);
  }

  flush() {
    if (this._dirtySince) this._save();
  }

  _item(itemId) {
    const item = this._items.find(i => i.id === itemId);
    if (!item) throw new Error(this.homey.__('errors.item_not_found'));
    return item;
  }

  _task(item, taskId) {
    const task = item.tasks.find(tk => tk.id === taskId);
    if (!task) throw new Error(this.homey.__('errors.task_not_found'));
    return task;
  }

  getItems() {
    return this._items.map(item => ({ ...item, tasks: item.tasks.map(tk => ({ ...tk })) }));
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
      ...(metric === 'level' ? { direction: src.direction === 'up' ? 'up' : 'down' } : {}),
    };
  }

  // Condition on the linked device that marks the task done by itself (e.g. alarm_smoke when testing).
  static normalizeAutoDone(input) {
    if (!input || !input.capability) return null;
    const op = AUTO_DONE_OPS.includes(input.op) ? input.op : 'true';
    return { capability: String(input.capability).slice(0, 100), op, value: op === 'true' ? null : String(input.value ?? '').slice(0, 100) };
  }

  static normalizeTask(input, today, previous) {
    const prev = previous || {};
    const type = ['counter', 'usage'].includes(input.type) ? input.type : 'date';
    const name = String(input.name || '').trim().slice(0, 80);
    if (!name) throw new Error('Task name is required');
    const source = type === 'usage' ? ItemManager.normalizeSource(input.source, prev.source) : null;
    const sameSource = source && prev.source && JSON.stringify(source) === JSON.stringify(prev.source);
    const autoDone = ItemManager.normalizeAutoDone('autoDone' in input ? input.autoDone : prev.autoDone);
    const sameAutoDone = autoDone && prev.autoDone && JSON.stringify(autoDone) === JSON.stringify(prev.autoDone);
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
      autoDone,
      autoLast: sameAutoDone && typeof prev.autoLast === 'boolean' ? prev.autoLast : null,
      lastDone: isDateString(input.lastDone) ? input.lastDone : (prev.lastDone || today),
      snoozeUntil: isDateString(input.snoozeUntil) ? input.snoozeUntil : (input.snoozeUntil === null ? null : prev.snoozeUntil || null),
      dueSince: prev.dueSince || null,
      notified: prev.notified || 'ok',
      history: Array.isArray(input.history) ? input.history.filter(isDateString).slice(0, HISTORY_LENGTH) : (prev.history || []),
      note: String(input.note ?? prev.note ?? '').slice(0, 500),
    };
  }

  _normalizeTasks(inputTasks, oldTasks) {
    if (!Array.isArray(inputTasks)) throw new Error('tasks must be an array');
    const today = this.today();
    return inputTasks.map(input => {
      const previous = (oldTasks || []).find(tk => tk.id && tk.id === input.id);
      const task = ItemManager.normalizeTask(input, today, previous);
      // A changed interval, date or amount resets the notification state, so the user is reminded again correctly.
      if (previous && ['lastDone', 'every', 'unit', 'type', 'threshold', 'counter', 'usage', 'combine']
        .some(key => previous[key] !== task[key])) {
        task.notified = 'ok';
        task.dueSince = null;
      }
      return task;
    });
  }

  _cleanInstallDate(date) {
    if (!isDateString(date)) return null;
    const today = this.today();
    return daysBetween(date, today) < 0 ? today : date;
  }

  _cleanLink(link) {
    return link && link.id ? { id: String(link.id), name: String(link.name || '').slice(0, 100) } : null;
  }

  // ---------- items ----------

  async addItem({
    name, category, installDate, link, tasks,
  }) {
    const result = await this._exclusive(async () => {
      const cleanName = String(name || '').trim().slice(0, 60);
      if (!cleanName) throw new Error(this.homey.__('errors.name_required'));
      const item = {
        id: crypto.randomUUID(),
        name: cleanName,
        category: getCategory(category).id,
        installDate: this._cleanInstallDate(installDate),
        link: this._cleanLink(link),
        tasks: this._normalizeTasks(tasks || [], []),
      };
      this._items.push(item);
      this._save();
      await this._evaluate();
      return item.id;
    });
    await this.app.syncTracking();
    return result;
  }

  async updateItem(itemId, changes) {
    await this._exclusive(async () => {
      const item = this._item(itemId);
      if ('name' in changes) {
        const name = String(changes.name || '').trim().slice(0, 60);
        if (name) item.name = name;
      }
      if ('category' in changes) item.category = getCategory(changes.category).id;
      if ('installDate' in changes) {
        item.installDate = this._cleanInstallDate(changes.installDate);
        // Tasks counted from installation (e.g. 'replace') follow it until they are done once.
        if (item.installDate) {
          for (const task of item.tasks.filter(tk => tk.basis === 'install' && !(tk.history || []).length)) {
            task.lastDone = item.installDate;
            task.notified = 'ok';
            task.dueSince = null;
          }
        }
      }
      if ('link' in changes) {
        item.link = this._cleanLink(changes.link);
        // A different device means different measurements: reset the usage bookkeeping.
        for (const task of item.tasks) {
          task.track = usage.defaultTrack();
          task.autoLast = null;
        }
      }
      this._save();
      await this._evaluate();
    });
    await this.app.syncTracking();
  }

  async deleteItem(itemId) {
    await this._exclusive(async () => {
      this._item(itemId);
      this._items = this._items.filter(i => i.id !== itemId);
      this._save();
      await this._evaluate();
    });
    await this.app.syncTracking();
  }

  // ---------- tasks ----------

  async setTasks(itemId, inputTasks) {
    await this._exclusive(async () => {
      const item = this._item(itemId);
      item.tasks = this._normalizeTasks(inputTasks, item.tasks);
      this._save();
      await this._evaluate();
    });
    await this.app.syncTracking();
  }

  async markDone(itemId, taskId, date) {
    return this._exclusive(async () => {
      const today = this.today();
      const doneDate = isDateString(date) && daysBetween(date, today) >= 0 ? date : today;
      this._markDone(this._task(this._item(itemId), taskId), doneDate);
      this._save();
      return this._evaluate();
    });
  }

  _markDone(task, doneDate) {
    task.lastDone = doneDate;
    task.counter = 0;
    if (task.type === 'usage') usage.resetUsage(task, Date.now());
    task.snoozeUntil = null;
    task.dueSince = null;
    task.notified = 'ok';
    // Marked done twice on the same day (e.g. a test and an automatic detection): keep one history entry.
    if ((task.history || [])[0] !== doneDate) task.history = [doneDate, ...(task.history || [])].slice(0, HISTORY_LENGTH);
  }

  async markAllOpenDone(itemId) {
    const states = await this.evaluate();
    const item = states.find(i => i.id === itemId);
    if (!item) throw new Error(this.homey.__('errors.item_not_found'));
    for (const task of item.tasks.filter(tk => severity(tk.status) >= severity('due'))) {
      await this.markDone(itemId, task.id);
    }
  }

  async snooze(itemId, taskId, days) {
    return this._exclusive(async () => {
      const task = this._task(this._item(itemId), taskId);
      task.snoozeUntil = addDays(this.today(), Math.max(1, Math.round(Number(days) || 1)));
      task.notified = 'ok';
      task.dueSince = null;
      this._save();
      return this._evaluate();
    });
  }

  async incrementCounter(itemId, taskId, amount) {
    return this._exclusive(async () => {
      const task = this._task(this._item(itemId), taskId);
      if (task.type !== 'counter') throw new Error(this.homey.__('errors.not_a_counter'));
      task.counter = Math.max(0, (Number(task.counter) || 0) + (Number(amount) || 0));
      this._save();
      return this._evaluate();
    });
  }

  // ---------- usage tracking ----------

  // { itemId, linkId, capability } for every capability that usage tasks and automatic "done" listen to.
  getTrackedCapabilities() {
    const list = [];
    for (const item of this._items.filter(i => i.link)) {
      const tasks = item.tasks.filter(tk => tk.type === 'usage' && tk.source);
      const autoTasks = item.tasks.filter(tk => tk.autoDone);
      const caps = new Set([...tasks.map(tk => tk.source.capability), ...autoTasks.map(tk => tk.autoDone.capability)]);
      for (const capability of caps) {
        // A new counter or level task has no starting value yet, and a new automatic "done" no previous state:
        // they need the current value of the device.
        const fresh = tasks.some(tk => tk.source.capability === capability && ['counter', 'level'].includes(tk.source.metric)
            && !(tk.track && typeof tk.track.last === 'number'))
          || autoTasks.some(tk => tk.autoDone.capability === capability && typeof tk.autoLast !== 'boolean');
        list.push({
          itemId: item.id, linkId: item.link.id, capability, fresh,
        });
      }
    }
    return list;
  }

  async applyUsage(itemId, capability, value) {
    return this._exclusive(async () => {
      const item = this._items.find(i => i.id === itemId);
      if (!item) return;
      const now = Date.now();
      const done = [];
      let result = null;
      for (const task of item.tasks.filter(tk => tk.type === 'usage' && tk.source && tk.source.capability === capability)) {
        const r = usage.applyValue(task, value, now);
        if (r === 'reset') done.push(task);
        else if (r === 'event') result = 'event';
        else if (r === 'change' && !result) result = 'change';
      }
      for (const task of item.tasks.filter(tk => tk.autoDone && tk.autoDone.capability === capability)) {
        const before = task.autoLast;
        if (usage.applyAutoDone(task, value)) done.push(task);
        else if (before !== task.autoLast && !result) result = 'change';
      }
      for (const task of new Set(done)) {
        this._markDone(task, this.today());
        this.app.log(`Auto done: "${task.name}" of "${item.name}"`);
        this.app.announceAutoDone({ item, task }).catch(err => this.app.error('Announce failed:', err.message));
      }
      await this._afterUsage(done.length ? 'event' : result);
    });
  }

  // Every minute: ends runs after their off-delay and adds running hours.
  async tickUsage() {
    return this._exclusive(async () => {
      const now = Date.now();
      let result = null;
      for (const item of this._items) {
        for (const task of item.tasks.filter(tk => tk.type === 'usage' && tk.source)) {
          const r = usage.tick(task, now);
          if (r === 'event') result = 'event';
          else if (r === 'change' && !result) result = 'change';
        }
      }
      await this._afterUsage(result);
    });
  }

  async _afterUsage(result) {
    if (!result) return;
    if (!this._dirtySince) this._dirtySince = Date.now();
    // Starts, stops and counter steps are saved and evaluated right away; running time at most every 10 minutes.
    if (result === 'event' || Date.now() - this._dirtySince >= SAVE_INTERVAL_MS) {
      this._save();
      await this._evaluate();
    }
  }

  // ---------- evaluation ----------

  async evaluate() {
    return this._exclusive(() => this._evaluate());
  }

  // Returns all items with the computed state of every task; announces each escalation exactly once.
  async _evaluate() {
    const today = this.today();
    const options = this.options();
    const events = [];
    let changed = false;

    const result = this._items.map(item => ({
      ...item,
      tasks: item.tasks.map(task => {
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
          events.push({ item, task, state });
          task.notified = state.status;
          changed = true;
        } else if (now < before) {
          task.notified = state.status;
          changed = true;
        }
        return { ...task, ...state };
      }),
    }));

    if (changed) this._save();
    await this.app.updateOverview(result).catch(err => this.app.error('Overview update failed:', err.message));
    for (const event of events) {
      await this.app.announce(event).catch(err => this.app.error('Announce failed:', err.message));
    }
    return result;
  }

  // ---------- backup ----------

  exportItems() {
    return this.getItems().map(item => ({
      ...item, tasks: item.tasks.map(({
        track, notified, dueSince, autoLast, ...rest
      }) => rest),
    }));
  }

  // Replaces items with the same id or name, adds the others.
  async importItems(items) {
    const restored = [];
    const added = [];
    await this._exclusive(async () => {
      for (const input of items) {
        const existing = this._items.find(i => i.id === input.id) || this._items.find(i => i.name === input.name);
        const item = {
          id: existing ? existing.id : crypto.randomUUID(),
          name: String(input.name || '').trim().slice(0, 60) || 'Onderdeel',
          category: getCategory(input.category).id,
          installDate: this._cleanInstallDate(input.installDate),
          link: this._cleanLink(input.link),
          tasks: this._normalizeTasks(input.tasks || [], existing ? existing.tasks : []),
        };
        if (existing) {
          this._items = this._items.map(i => (i.id === existing.id ? item : i));
          restored.push(item.name);
        } else {
          this._items.push(item);
          added.push(item.name);
        }
      }
      this._save();
      await this._evaluate();
    });
    await this.app.syncTracking();
    return { restored, added };
  }

}

module.exports = ItemManager;
