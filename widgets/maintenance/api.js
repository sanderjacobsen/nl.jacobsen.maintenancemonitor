'use strict';

const { getCategory, getIconUri } = require('../../lib/templates');

const ORDER = ['ok', 'soon', 'due', 'overdue'];

module.exports = {

  // All tasks of all items, most urgent first.
  async getTasks({ homey }) {
    const tasks = [];
    for (const device of homey.app.getDevices()) {
      const category = getCategory(device.getStoreValue('category'));
      for (const task of await device.evaluate()) {
        tasks.push({
          itemId: device.getData().id,
          item: device.getName(),
          iconUri: getIconUri(category.icon),
          taskId: task.id,
          task: task.name,
          status: task.status,
          days: task.days,
          dueDate: task.dueDate,
          progress: task.progress,
          type: task.type,
        });
      }
    }
    return tasks.sort((a, b) => ORDER.indexOf(b.status) - ORDER.indexOf(a.status)
      || (a.days ?? 99999) - (b.days ?? 99999)
      || (b.progress ?? 0) - (a.progress ?? 0));
  },

  async markDone({ homey, body }) {
    const device = homey.app.getDeviceById(body.itemId);
    await device.markDone(body.taskId);
    return true;
  },

};
