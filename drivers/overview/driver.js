'use strict';

const Homey = require('homey');

// One overview device for all maintenance: items themselves are not devices (no duplicates in the device list).
class OverviewDriver extends Homey.Driver {

  async onPairListDevices() {
    if (this.getDevices().length) return []; // only one overview device is needed
    return [{ name: this.homey.__('overview.name'), data: { id: 'huisarts-overview' } }];
  }

}

module.exports = OverviewDriver;
