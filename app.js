'use strict';

const Homey = require('homey');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

class HuisartsApp extends Homey.App {

  async onInit() {
    // Defaults for the notification settings (only set when missing).
    const defaults = {
      notify_soon: true, notify_due: true, notify_overdue: true, overdue_after_days: 7,
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (this.homey.settings.get(key) === null) this.homey.settings.set(key, value);
    }

    this._interval = this.homey.setInterval(() => this.checkAll(), CHECK_INTERVAL_MS);
    this.homey.setTimeout(() => this.checkAll(), 30 * 1000);
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

}

module.exports = HuisartsApp;
