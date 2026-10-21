'use strict';

const Homey = require('homey');

class OverviewDevice extends Homey.Device {

  async onInit() {
    await this.homey.app.checkAll();
  }

  async setSummary({
    alarm, open, days, next,
  }) {
    const values = {
      alarm_maintenance: alarm, maintenance_open: open, maintenance_days: days, maintenance_next: next,
    };
    for (const [capability, value] of Object.entries(values)) {
      if (this.hasCapability(capability) && this.getCapabilityValue(capability) !== value) {
        await this.setCapabilityValue(capability, value).catch(err => this.error(capability, err.message));
      }
    }
  }

}

module.exports = OverviewDevice;
