'use strict';

const {
  getTemplates, getCategory, getIconUri, localize,
} = require('./lib/templates');

async function describe(homey, device) {
  const states = await device.evaluate();
  const category = getCategory(device.getStoreValue('category'));
  return {
    id: device.getData().id,
    name: device.getName(),
    category: category.id,
    categoryName: localize(category.name, homey.i18n.getLanguage()),
    icon: category.icon,
    iconUri: getIconUri(category.icon),
    installDate: device.getInstallDate(),
    tasks: states,
  };
}

module.exports = {

  async getDevices({ homey }) {
    const devices = homey.app.getDevices();
    const result = [];
    for (const device of devices) result.push(await describe(homey, device));
    return result.sort((a, b) => a.name.localeCompare(b.name));
  },

  async getTemplates({ homey }) {
    return getTemplates(homey.i18n.getLanguage());
  },

  async setTasks({ homey, params, body }) {
    const device = homey.app.getDeviceById(params.id);
    await device.setTasks(body && body.tasks);
    return describe(homey, device);
  },

  async updateItem({ homey, params, body }) {
    const device = homey.app.getDeviceById(params.id);
    if (body && 'installDate' in body) await device.setInstallDate(body.installDate);
    return describe(homey, device);
  },

  async markDone({ homey, params, body }) {
    const device = homey.app.getDeviceById(params.id);
    await device.markDone(params.taskId, body && body.date);
    return describe(homey, device);
  },

  async snooze({ homey, params, body }) {
    const device = homey.app.getDeviceById(params.id);
    await device.snooze(params.taskId, body && body.days);
    return describe(homey, device);
  },

  async exportData({ homey }) {
    return {
      app: 'nl.jacobsen.huisarts',
      exported: new Date().toISOString(),
      settings: ['notify_soon', 'notify_due', 'notify_overdue', 'overdue_after_days']
        .reduce((acc, key) => ({ ...acc, [key]: homey.settings.get(key) }), {}),
      items: homey.app.getDevices().map(device => ({
        id: device.getData().id,
        name: device.getName(),
        category: device.getStoreValue('category'),
        installDate: device.getInstallDate(),
        tasks: device.getTasks(),
      })),
    };
  },

  // Restores tasks onto existing items (matched by id, then by name). Items themselves are added via pairing.
  async importData({ homey, body }) {
    const data = body && body.data;
    if (!data || !Array.isArray(data.items)) throw new Error('Invalid backup file');
    const devices = homey.app.getDevices();
    const restored = [];
    const missing = [];
    for (const item of data.items) {
      const device = devices.find(d => d.getData().id === item.id) || devices.find(d => d.getName() === item.name);
      if (!device) {
        missing.push(item.name);
        continue;
      }
      await device.setTasks(item.tasks || []);
      if (item.installDate) await device.setInstallDate(item.installDate);
      restored.push(device.getName());
    }
    if (data.settings) {
      for (const [key, value] of Object.entries(data.settings)) {
        if (['notify_soon', 'notify_due', 'notify_overdue', 'overdue_after_days'].includes(key) && value !== null) homey.settings.set(key, value);
      }
    }
    return { restored, missing };
  },

};
