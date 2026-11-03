'use strict';

const {
  getTemplates, getCategory, localize,
} = require('./lib/templates');

// Items with the computed state of their tasks, plus icon and category name for the settings page.
// deviceIconUri: the linked device's own Homey icon, offered as a choice in the icon picker.
async function describeAll(homey) {
  const language = homey.i18n.getLanguage();
  const items = await Promise.all((await homey.app.items.evaluate()).map(async item => ({
    ...item,
    categoryName: localize(getCategory(item.category).name, language),
    iconUri: await homey.app.iconFor(item),
    deviceIconUri: item.link ? await homey.app.getDeviceIcon(item.link.id).catch(() => null) : null,
  })));
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {

  async getItems({ homey }) {
    return describeAll(homey);
  },

  async addItem({ homey, body }) {
    const id = await homey.app.items.addItem(body || {});
    return { id, items: await describeAll(homey) };
  },

  async updateItem({ homey, params, body }) {
    await homey.app.items.updateItem(params.id, body || {});
    return describeAll(homey);
  },

  async deleteItem({ homey, params }) {
    await homey.app.items.deleteItem(params.id);
    return describeAll(homey);
  },

  async setTasks({ homey, params, body }) {
    await homey.app.items.setTasks(params.id, body && body.tasks);
    return describeAll(homey);
  },

  async markDone({ homey, params, body }) {
    await homey.app.items.markDone(params.id, params.taskId, body && body.date);
    return describeAll(homey);
  },

  async snooze({ homey, params, body }) {
    await homey.app.items.snooze(params.id, params.taskId, body && body.days);
    return describeAll(homey);
  },

  async getTemplates({ homey }) {
    return getTemplates(homey.i18n.getLanguage());
  },

  async getHomeyDevices({ homey }) {
    return homey.app.getHomeyDevices();
  },

  async exportData({ homey }) {
    return {
      app: 'nl.jacobsen.maintenancemonitor',
      version: 2,
      exported: new Date().toISOString(),
      settings: ['notify_soon', 'notify_due', 'notify_overdue', 'overdue_after_days', 'notify_time', 'daily_reminder']
        .reduce((acc, key) => ({ ...acc, [key]: homey.settings.get(key) }), {}),
      items: homey.app.items.exportItems(),
    };
  },

  // Restores items with the same id or name and adds the others.
  async importData({ homey, body }) {
    const data = body && body.data;
    if (!data || !Array.isArray(data.items)) throw new Error('Invalid backup file');
    if (data.settings) {
      for (const [key, value] of Object.entries(data.settings)) {
        if (['notify_soon', 'notify_due', 'notify_overdue', 'overdue_after_days', 'notify_time', 'daily_reminder'].includes(key) && value !== null) homey.settings.set(key, value);
      }
    }
    return homey.app.items.importItems(data.items);
  },

};
