'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const ItemManager = require('./lib/items');
const { severity } = require('./lib/schedule');
const { suggestSource } = require('./lib/suggest');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const USAGE_TICK_MS = 60 * 1000;
const CAPABILITY_TYPES = ['boolean', 'number', 'enum', 'string'];
const ANY = '*';

class MaintenanceMonitorApp extends Homey.App {

  async onInit() {
    // Defaults for the notification settings (only set when missing).
    const defaults = {
      notify_soon: true, notify_due: true, notify_overdue: true, overdue_after_days: 7,
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (this.homey.settings.get(key) === null) this.homey.settings.set(key, value);
    }

    this.items = new ItemManager(this);
    this._instances = new Map(); // `${itemId}|${capability}` -> capability instance of the linked device
    this._syncing = Promise.resolve();
    this._registerFlowCards();

    this.homey.setInterval(() => this.checkAll(), CHECK_INTERVAL_MS);
    this.homey.setInterval(() => this.usageTick(), USAGE_TICK_MS);
    this.homey.setTimeout(() => {
      this.checkAll();
      this.syncTracking().catch(err => this.error('Sync tracking failed:', err.message));
    }, 15 * 1000);
    this.log('Maintenance Monitor started');
  }

  async onUninit() {
    this.items.flush();
  }

  async checkAll() {
    await this.items.evaluate().catch(err => this.error('Check failed:', err.message));
  }

  // ---------- overview device and notifications ----------

  async updateOverview(items) {
    const devices = this.homey.drivers.getDriver('overview').getDevices();
    if (!devices.length) return;
    const tasks = items.flatMap(item => item.tasks.map(task => ({ ...task, item: item.name })));
    const open = tasks.filter(tk => severity(tk.status) >= severity('due'));
    const dated = tasks.filter(tk => tk.days !== null).sort((a, b) => a.days - b.days);
    const next = [...open].sort((a, b) => severity(b.status) - severity(a.status))[0] || dated[0];
    for (const device of devices) {
      await device.setSummary({
        alarm: open.length > 0,
        open: open.length,
        days: dated.length ? dated[0].days : null,
        item: next ? next.item : '-',
        next: next ? next.name : this.homey.__('device.no_tasks'),
      });
    }
  }

  _daysText(days) {
    if (days > 0) return this.homey.__('device.in_days', { days });
    if (days === 0) return this.homey.__('device.today');
    return this.homey.__('device.days_late', { days: -days });
  }

  async announce({ item, task, state }) {
    // Was it the date or the amount (counter/usage) that triggered this status?
    const byAmount = state.amountStatus && severity(state.amountStatus) >= severity(state.status);
    const days = byAmount || state.days === null ? 0 : Math.abs(state.days);

    // Own notification in the Homey timeline (can also be pushed via Homey settings > Notifications).
    if (this.homey.settings.get(`notify_${state.status}`) !== false) {
      const key = byAmount ? `notify.${state.status}_counter` : `notify.${state.status}`;
      await this.homey.notifications.createNotification({
        excerpt: this.homey.__(key, { item: item.name, task: task.name, days }),
      });
    }
    await this.homey.flow.getTriggerCard(`task_${state.status}`)
      .trigger({ item: item.name, task: task.name, days }, { itemId: item.id, taskId: task.id });
  }

  // A task marked done by the device itself (test button, consumable replaced, refilled): confirm it in the timeline.
  async announceAutoDone({ item, task }) {
    await this.homey.notifications.createNotification({
      excerpt: this.homey.__('notify.auto_done', { item: item.name, task: task.name }),
    });
  }

  // Done by the user: also run the chosen action on the linked device, e.g. reset its consumable counter.
  async runResetAction({ item, task }) {
    if (!item.link || !task.resetAction) return;
    const api = await this.getApi();
    try {
      await api.flow.runFlowCardAction({ uri: `homey:device:${item.link.id}`, id: task.resetAction.id, args: {} });
      this.log(`Ran "${task.resetAction.title}" for "${task.name}" of "${item.name}"`);
    } catch (err) {
      this.error(`Reset action failed for "${task.name}":`, err.message);
      await this.homey.notifications.createNotification({
        excerpt: this.homey.__('notify.reset_failed', { item: item.name, task: task.name, action: task.resetAction.title }),
      }).catch(() => {});
    }
  }

  // Every "done" (app, widget, flow or device): flows can follow up, e.g. reset the counter in the device itself.
  async triggerDone({ item, task, automatic }) {
    await this.homey.flow.getTriggerCard('task_done').trigger(
      {
        item: item.name, task: task.name, key: task.key || '', automatic: Boolean(automatic),
      },
      { itemId: item.id, taskId: task.id },
    );
  }

  // ---------- flow cards (choose an item or "item › task") ----------

  _itemChoices(query, withAny) {
    const q = String(query || '').toLowerCase();
    const list = this.items.getItems().map(i => ({ id: i.id, name: i.name })).sort((a, b) => a.name.localeCompare(b.name));
    if (withAny) list.unshift({ id: ANY, name: this.homey.__('flow.any_item') });
    return list.filter(i => i.name.toLowerCase().includes(q));
  }

  _taskChoices(query, onlyCounters) {
    const q = String(query || '').toLowerCase();
    return this.items.getItems()
      .flatMap(i => i.tasks
        .filter(tk => !onlyCounters || tk.type === 'counter')
        .map(tk => ({ id: `${i.id}|${tk.id}`, name: tk.name, description: i.name })))
      .filter(c => `${c.description} ${c.name}`.toLowerCase().includes(q))
      .sort((a, b) => `${a.description}${a.name}`.localeCompare(`${b.description}${b.name}`));
  }

  _splitTask(arg) {
    const [itemId, taskId] = String((arg && arg.id) || '').split('|');
    return { itemId, taskId };
  }

  _registerFlowCards() {
    const items = (query, args) => this._itemChoices(query, true);
    const tasks = query => this._taskChoices(query, false);

    for (const status of ['soon', 'due', 'overdue', 'done']) {
      const card = this.homey.flow.getTriggerCard(`task_${status}`);
      card.registerArgumentAutocompleteListener('item', items);
      card.registerRunListener(async (args, state) => !args.item || args.item.id === ANY || args.item.id === state.itemId);
    }

    const hasOpen = this.homey.flow.getConditionCard('has_open_tasks');
    hasOpen.registerArgumentAutocompleteListener('item', items);
    hasOpen.registerRunListener(async ({ item }) => {
      const list = await this.items.evaluate();
      return list.filter(i => item.id === ANY || i.id === item.id)
        .some(i => i.tasks.some(tk => severity(tk.status) >= severity('due')));
    });

    const dueWithin = this.homey.flow.getConditionCard('task_due_within');
    dueWithin.registerArgumentAutocompleteListener('task', tasks);
    dueWithin.registerRunListener(async ({ task, days }) => {
      const { itemId, taskId } = this._splitTask(task);
      const item = (await this.items.evaluate()).find(i => i.id === itemId);
      const state = item && item.tasks.find(tk => tk.id === taskId);
      if (!state) throw new Error(this.homey.__('errors.task_not_found'));
      if (state.days === null) return severity(state.status) >= severity('soon');
      return state.days <= days;
    });

    const markDone = this.homey.flow.getActionCard('mark_task_done');
    markDone.registerArgumentAutocompleteListener('task', tasks);
    markDone.registerRunListener(async ({ task }) => {
      const { itemId, taskId } = this._splitTask(task);
      await this.items.markDone(itemId, taskId);
    });

    const markAll = this.homey.flow.getActionCard('mark_all_done');
    markAll.registerArgumentAutocompleteListener('item', query => this._itemChoices(query, false));
    markAll.registerRunListener(async ({ item }) => this.items.markAllOpenDone(item.id));

    const snooze = this.homey.flow.getActionCard('snooze_task');
    snooze.registerArgumentAutocompleteListener('task', tasks);
    snooze.registerRunListener(async ({ task, days }) => {
      const { itemId, taskId } = this._splitTask(task);
      await this.items.snooze(itemId, taskId, days);
    });

    const increment = this.homey.flow.getActionCard('increment_counter');
    increment.registerArgumentAutocompleteListener('task', query => this._taskChoices(query, true));
    increment.registerRunListener(async ({ task, amount }) => {
      const { itemId, taskId } = this._splitTask(task);
      await this.items.incrementCounter(itemId, taskId, amount);
    });
  }

  // ---------- access to the other devices in Homey (homey:manager:api) ----------

  async getApi() {
    if (!this._api) {
      this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
      this.log('Connected to the Homey API');
    }
    return this._api;
  }

  // All devices of other apps, with the capabilities that can be used for tracking.
  async getHomeyDevices() {
    const api = await this.getApi();
    const [devices, zones, actions] = await Promise.all([api.devices.getDevices(), api.zones.getZones(), api.flow.getFlowCardActions().catch(() => ({}))]);
    const language = this.homey.i18n.getLanguage();
    const title = t => (t && typeof t === 'object' ? t[language] || t.en || '' : t || '');
    // Device actions without arguments (e.g. "Reset main brush life counter"), to run when a task is done.
    const actionsOf = id => Object.values(actions)
      .filter(c => c.ownerUri === `homey:device:${id}` && !(c.args || []).some(a => a.name !== 'device' && a.required !== false))
      .map(c => ({ id: c.id, title: title(c.title) }));
    return Object.values(devices)
      .filter(d => !String(d.driverId || '').includes('nl.jacobsen.maintenancemonitor'))
      .map(d => ({
        id: d.id,
        name: d.name,
        zone: zones[d.zone] ? zones[d.zone].name : '',
        class: d.class,
        capabilities: Object.entries(d.capabilitiesObj || {})
          .filter(([, c]) => CAPABILITY_TYPES.includes(c.type) && c.getable !== false)
          .map(([id, c]) => ({
            id,
            title: title(c.title) || id,
            type: c.type,
            units: title(c.units) || null,
            values: Array.isArray(c.values) ? c.values.map(v => ({ id: v.id, title: title(v.title) || v.id })) : null,
            value: c.value,
          })),
        actions: actionsOf(d.id),
      }))
      .map(d => ({
        ...d,
        // How to measure usage of this device (status "In use" > power above X W > on/off; own counters for runs).
        suggest: Object.fromEntries(['hours', 'cycles', 'counter'].map(m => [m, suggestSource(d, m)])),
      }))
      .sort((a, b) => (a.zone + a.name).localeCompare(b.zone + b.name));
  }

  // Every minute: read the linked devices once more (realtime updates are sometimes missed), then add running time.
  async usageTick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      await this.pollTracking();
      await this.items.tickUsage();
    } catch (err) {
      this.error('Usage tick failed:', err.message);
    } finally {
      this._ticking = false;
    }
  }

  async pollTracking() {
    const byDevice = new Map();
    for (const w of this.items.getTrackedCapabilities()) {
      if (!byDevice.has(w.linkId)) byDevice.set(w.linkId, []);
      byDevice.get(w.linkId).push(w);
    }
    if (!byDevice.size) return;
    const api = await this.getApi();
    for (const [linkId, list] of byDevice) {
      try {
        const device = await api.devices.getDevice({ id: linkId, $cache: false, $updateCache: false });
        for (const { itemId, capability } of list) {
          const current = device.capabilitiesObj && device.capabilitiesObj[capability];
          if (current) await this.items.applyUsage(itemId, capability, current.value);
        }
      } catch (err) {
        this.error(`Could not read device ${linkId}:`, err.message);
      }
    }
  }

  // (Re)create the capability listeners for all usage tasks. Safe to call often.
  async syncTracking() {
    const run = this._syncing.then(() => this._syncTracking());
    this._syncing = run.catch(() => {});
    return run.catch(err => this.error('Sync tracking failed:', err.message));
  }

  async _syncTracking() {
    const wanted = new Map(this.items.getTrackedCapabilities().map(w => [`${w.itemId}|${w.capability}`, w]));

    for (const [key, entry] of this._instances) {
      if (!wanted.has(key) || wanted.get(key).linkId !== entry.linkId) {
        try { entry.instance.destroy(); } catch (err) { /* already gone */ }
        this._instances.delete(key);
      }
    }
    if (![...wanted].some(([key, w]) => w.fresh || !this._instances.has(key))) return;

    const api = await this.getApi();
    for (const [key, {
      itemId, linkId, capability, fresh,
    }] of wanted) {
      if (this._instances.has(key)) {
        // Already followed, but a new counter task needs a starting value.
        if (fresh) {
          try {
            const device = await api.devices.getDevice({ id: linkId });
            const current = device.capabilitiesObj && device.capabilitiesObj[capability];
            if (current) await this.items.applyUsage(itemId, capability, current.value);
          } catch (err) {
            this.error(`Could not read ${capability} of device ${linkId}:`, err.message);
          }
        }
        continue;
      }
      try {
        const device = await api.devices.getDevice({ id: linkId });
        const instance = device.makeCapabilityInstance(capability, value => {
          this.items.applyUsage(itemId, capability, value).catch(err => this.error('Apply usage failed:', err.message));
        });
        this._instances.set(key, { instance, linkId });
        // Start from the current value (e.g. a device that is already running).
        const current = device.capabilitiesObj && device.capabilitiesObj[capability];
        if (current) await this.items.applyUsage(itemId, capability, current.value);
        this.log(`Tracking ${capability} of "${device.name}"`);
      } catch (err) {
        this.error(`Could not track ${capability} of device ${linkId}:`, err.message);
      }
    }
  }

}

module.exports = MaintenanceMonitorApp;
