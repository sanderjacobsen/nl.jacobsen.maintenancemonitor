'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const USAGE_TICK_MS = 60 * 1000;
const CAPABILITY_TYPES = ['boolean', 'number', 'enum', 'string'];

class HuisartsApp extends Homey.App {

  async onInit() {
    // Defaults for the notification settings (only set when missing).
    const defaults = {
      notify_soon: true, notify_due: true, notify_overdue: true, overdue_after_days: 7,
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (this.homey.settings.get(key) === null) this.homey.settings.set(key, value);
    }

    this._instances = new Map(); // `${itemId}|${capability}` -> capability instance of the linked device
    this._syncing = Promise.resolve();

    this.homey.setInterval(() => this.checkAll(), CHECK_INTERVAL_MS);
    this.homey.setInterval(() => this.tickUsage(), USAGE_TICK_MS);
    this.homey.setTimeout(() => {
      this.checkAll();
      this.syncTracking().catch(err => this.error('Sync tracking failed:', err.message));
    }, 15 * 1000);
    this.log('Huisarts started');
  }

  getDevices() {
    return this.homey.drivers.getDriver('maintenance_item').getDevices();
  }

  getDeviceById(id) {
    const device = this.getDevices().find(d => d.getData().id === id);
    if (!device) throw new Error(this.homey.__('errors.item_not_found'));
    return device;
  }

  async checkAll() {
    for (const device of this.getDevices()) {
      await device.evaluate().catch(err => this.error(`Check failed for ${device.getName()}:`, err.message));
    }
  }

  async tickUsage() {
    for (const device of this.getDevices()) {
      await device.tickUsage().catch(err => this.error(`Usage tick failed for ${device.getName()}:`, err.message));
    }
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
    const [devices, zones] = await Promise.all([api.devices.getDevices(), api.zones.getZones()]);
    const language = this.homey.i18n.getLanguage();
    const title = t => (t && typeof t === 'object' ? t[language] || t.en || '' : t || '');
    return Object.values(devices)
      .filter(d => !String(d.driverId || '').includes('nl.jacobsen.huisarts'))
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
      }))
      .sort((a, b) => (a.zone + a.name).localeCompare(b.zone + b.name));
  }

  // (Re)create the capability listeners for all usage tasks. Safe to call often.
  async syncTracking() {
    const run = this._syncing.then(() => this._syncTracking());
    this._syncing = run.catch(() => {});
    return run;
  }

  async _syncTracking() {
    const wanted = new Map();
    for (const item of this.getDevices()) {
      const link = item.getLink();
      if (!link) continue;
      for (const capability of item.getTrackedCapabilities()) {
        wanted.set(`${item.getData().id}|${capability}`, { item, linkId: link.id, capability });
      }
    }

    for (const [key, instance] of this._instances) {
      if (!wanted.has(key) || wanted.get(key).linkId !== instance.linkId) {
        try { instance.instance.destroy(); } catch (err) { /* already gone */ }
        this._instances.delete(key);
      }
    }
    if (![...wanted.keys()].some(key => !this._instances.has(key))) return;

    const api = await this.getApi();
    for (const [key, { item, linkId, capability }] of wanted) {
      if (this._instances.has(key)) continue;
      try {
        const device = await api.devices.getDevice({ id: linkId });
        const instance = device.makeCapabilityInstance(capability, value => {
          item.applyUsage(capability, value).catch(err => this.error('Apply usage failed:', err.message));
        });
        this._instances.set(key, { instance, linkId });
        // Start from the current value (e.g. a device that is already running).
        const current = device.capabilitiesObj && device.capabilitiesObj[capability];
        if (current) await item.applyUsage(capability, current.value);
        this.log(`Tracking ${capability} of "${device.name}" for "${item.getName()}"`);
      } catch (err) {
        this.error(`Could not track ${capability} for "${item.getName()}":`, err.message);
      }
    }
  }

}

module.exports = HuisartsApp;
