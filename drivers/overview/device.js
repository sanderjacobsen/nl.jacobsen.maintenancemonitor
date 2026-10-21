'use strict';

const Homey = require('homey');

class OverviewDevice extends Homey.Device {

  async onInit() {
    // Devices added with an older version get the new tiles.
    for (const capability of ['maintenance_item']) {
      if (!this.hasCapability(capability)) await this.addCapability(capability).catch(err => this.error(err.message));
    }
    await this.homey.app.checkAll();
  }

  async setSummary({
    alarm, open, days, item, next,
  }) {
    const values = {
      alarm_maintenance: alarm, maintenance_open: open, maintenance_days: days, maintenance_item: item, maintenance_next: next,
    };
    for (const [capability, value] of Object.entries(values)) {
      if (this.hasCapability(capability) && this.getCapabilityValue(capability) !== value) {
        await this.setCapabilityValue(capability, value).catch(err => this.error(capability, err.message));
      }
    }
  }

}

module.exports = OverviewDevice;
