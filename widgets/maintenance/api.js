'use strict';

const { getCategory, getIconUri } = require('../../lib/templates');

const ORDER = ['ok', 'soon', 'due', 'overdue'];

module.exports = {

  // All tasks of all items, most urgent first.
  async getTasks({ homey }) {
    const tasks = [];
    for (const item of await homey.app.items.evaluate()) {
      const iconUri = getIconUri(getCategory(item.category).icon);
      for (const task of item.tasks) {
        tasks.push({
          itemId: item.id,
          item: item.name,
          iconUri,
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
    await homey.app.items.markDone(body.itemId, body.taskId);
    return true;
  },

};
