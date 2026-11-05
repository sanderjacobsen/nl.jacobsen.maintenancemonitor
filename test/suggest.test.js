'use strict';

// Plain node tests for the usage suggestions: `npm test`
const assert = require('assert');
const { suggestSource, suggestDeviceTasks } = require('../lib/suggest');

const miele = { class: 'washer', capabilities: [
  { id: 'onoff', title: 'On', type: 'boolean' },
  { id: 'display_status', title: 'Status', type: 'enum', values: [{ id: 'Off' }, { id: 'Waiting to start' }, { id: 'In use' }, { id: 'Finished' }] },
  { id: 'meter_energy_consumption', title: 'Energy', type: 'number', units: 'kWh' },
] };
let s = suggestSource(miele, 'cycles');
assert.deepStrictEqual([s.kind, s.srcCap, s.op, s.cmpValue], ['status', 'display_status', 'equals', 'In use']);

const plug = { class: 'socket', capabilities: [
  { id: 'onoff', title: 'On', type: 'boolean' }, { id: 'measure_power', title: 'Power', type: 'number', units: 'W' }, { id: 'meter_power', title: 'Energy', type: 'number', units: 'kWh' },
] };
s = suggestSource(plug, 'cycles', 10);
assert.deepStrictEqual([s.kind, s.srcCap, s.op, s.cmpValue], ['power', 'measure_power', 'gt', 10]);
s = suggestSource(plug, 'counter');
assert.deepStrictEqual([s.kind, s.srcCap], ['counter', 'meter_power']);

const vacuum = { class: 'vacuumcleaner', capabilities: [
  { id: 'vacuumcleaner_state', title: 'State', type: 'enum', values: [{ id: 'cleaning' }, { id: 'docked' }, { id: 'charging' }] },
] };
s = suggestSource(vacuum, 'hours');
assert.deepStrictEqual([s.kind, s.cmpValue], ['status', 'cleaning']);
// The battery level is not a counter.
s = suggestSource({ ...vacuum, capabilities: [...vacuum.capabilities, { id: 'measure_battery', title: 'Battery', type: 'number', units: '%' }] }, 'counter');
assert.strictEqual(s.kind, null);

const litter = { class: 'other', capabilities: [
  { id: 'onoff', title: 'On', type: 'boolean' }, { id: 'measure_odometer_clean_cycles', title: 'Clean cycles', type: 'number', units: 'cycli' },
] };
s = suggestSource(litter, 'cycles');
assert.deepStrictEqual([s.metric, s.kind, s.srcCap], ['counter', 'counter', 'measure_odometer_clean_cycles']);

const button = { class: 'button', capabilities: [{ id: 'alarm_battery', title: 'Battery', type: 'boolean' }] };
assert.strictEqual(suggestSource(button, 'hours').kind, null);

// Maintenance signals of real devices (05-11).
const dreame = { capabilities: [
  { id: 'dreame_water_tank', title: 'Water Tank', type: 'enum', values: [{ id: 'installed', title: 'Installed' }, { id: 'not_installed', title: 'Not installed' }, { id: 'low_water', title: 'Low water' }, { id: 'no_water', title: 'No water' }] },
  { id: 'dreame_dirty_water_tank', title: 'Dirty Water Tank', type: 'enum', values: [{ id: 'installed', title: 'Installed' }, { id: 'not_installed_or_full', title: 'Not installed or full' }] },
  { id: 'dreame_dust_bag', title: 'Dust Bag', type: 'enum', values: [{ id: 'installed', title: 'Installed' }, { id: 'not_installed', title: 'Not installed' }, { id: 'full', title: 'Full' }] },
  { id: 'dreame_water_volume', title: 'Water Volume', type: 'enum', setable: true, values: [{ id: 'low', title: 'Low' }, { id: 'high', title: 'High' }] },
  { id: 'dreame_dust_collection', title: 'Auto Empty', type: 'enum', values: [{ id: 'idle', title: 'Idle' }, { id: 'active', title: 'Emptying' }, { id: 'not_performed', title: 'Not performed' }] },
  { id: 'dreame_filter_left', title: 'Filter', type: 'number', units: '%' },
  { id: 'measure_battery', title: 'Battery', type: 'number', units: '%' },
] };
const tasks = suggestDeviceTasks(dreame);
assert.deepStrictEqual(tasks.map(t => t.key), ['signal:dreame_water_tank', 'signal:dreame_dirty_water_tank', 'signal:dreame_dust_bag', 'level:dreame_filter_left']);
assert.strictEqual(tasks[0].source.condition.value, 'not_installed,low_water,no_water');
assert.strictEqual(tasks[0].name, 'Water Tank: Not installed / Low water / No water');

const mieleAlarm = { capabilities: [{ id: 'alarm_information', title: 'Melding op apparaat', type: 'boolean' }, { id: 'alarm_failure', title: 'Apparaatfout', type: 'boolean' }] };
assert.deepStrictEqual(suggestDeviceTasks(mieleAlarm).map(t => [t.key, t.source.condition.op]), [['signal:alarm_information', 'true']]);

const aquacell = { capabilities: [
  { id: 'measure_salt_left', title: 'Zout linkerkant', type: 'number', units: '%' },
  { id: 'measure_salt_days_left', title: 'Dagen tot leeg', type: 'number', units: 'dagen' },
] };
assert.deepStrictEqual(suggestDeviceTasks(aquacell).map(t => [t.key, t.threshold]), [['level:measure_salt_left', 10], ['level:measure_salt_days_left', 7]]);

console.log('suggest tests ok');
