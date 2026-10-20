'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const { getTemplates, getCategory } = require('../../lib/templates');
const { severity } = require('../../lib/schedule');

class MaintenanceItemDriver extends Homey.Driver {

  async onInit() {
    const taskAutocomplete = async (query, args) => {
      const q = String(query || '').toLowerCase();
      return args.device.getTasks()
        .filter(tk => tk.name.toLowerCase().includes(q))
        .map(tk => ({ id: tk.id, name: tk.name }));
    };

    this.homey.flow.getConditionCard('has_open_tasks')
      .registerRunListener(async ({ device }) => {
        const states = await device.evaluate();
        return states.some(s => severity(s.status) >= severity('due'));
      });

    const dueWithin = this.homey.flow.getConditionCard('task_due_within');
    dueWithin.registerArgumentAutocompleteListener('task', taskAutocomplete);
    dueWithin.registerRunListener(async ({ device, task, days }) => {
      const state = (await device.evaluate()).find(s => s.id === task.id);
      if (!state) throw new Error(this.homey.__('errors.task_not_found'));
      if (state.days === null) return severity(state.status) >= severity('soon');
      return state.days <= days;
    });

    const markDone = this.homey.flow.getActionCard('mark_task_done');
    markDone.registerArgumentAutocompleteListener('task', taskAutocomplete);
    markDone.registerRunListener(({ device, task }) => device.markDone(task.id));

    this.homey.flow.getActionCard('mark_all_done')
      .registerRunListener(({ device }) => device.markAllOpenDone());

    const snooze = this.homey.flow.getActionCard('snooze_task');
    snooze.registerArgumentAutocompleteListener('task', taskAutocomplete);
    snooze.registerRunListener(({ device, task, days }) => device.snooze(task.id, days));

    const increment = this.homey.flow.getActionCard('increment_counter');
    increment.registerArgumentAutocompleteListener('task', async (query, args) => (await taskAutocomplete(query, args))
      .filter(item => args.device.getTasks().find(tk => tk.id === item.id && tk.type === 'counter')));
    increment.registerRunListener(({ device, task, amount }) => device.incrementCounter(task.id, amount));
  }

  async onPair(session) {
    session.setHandler('getTemplates', async () => getTemplates(this.homey.i18n.getLanguage()));

    session.setHandler('createItem', async ({
      name, category, tasks, installDate,
    }) => {
      const cleanName = String(name || '').trim().slice(0, 60);
      if (!cleanName) throw new Error(this.homey.__('errors.name_required'));
      const cat = getCategory(category);
      return {
        name: cleanName,
        data: { id: crypto.randomUUID() },
        icon: `/icons/${cat.icon}.svg`,
        store: {
          category: cat.id,
          installDate: /^\d{4}-\d{2}-\d{2}$/.test(installDate || '') ? installDate : null,
          tasks: Array.isArray(tasks) ? tasks : [],
        },
      };
    });
  }

}

module.exports = MaintenanceItemDriver;
