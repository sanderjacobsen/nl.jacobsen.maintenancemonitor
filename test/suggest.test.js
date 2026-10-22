'use strict';

// Plain node tests for the usage suggestions: `npm test`
const assert = require('assert');
const { suggestSource } = require('../lib/suggest');

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

const litter = { class: 'other', capabilities: [
  { id: 'onoff', title: 'On', type: 'boolean' }, { id: 'measure_odometer_clean_cycles', title: 'Clean cycles', type: 'number', units: 'cycli' },
] };
s = suggestSource(litter, 'cycles');
assert.deepStrictEqual([s.metric, s.kind, s.srcCap], ['counter', 'counter', 'measure_odometer_clean_cycles']);

const button = { class: 'button', capabilities: [{ id: 'alarm_battery', title: 'Battery', type: 'boolean' }] };
assert.strictEqual(suggestSource(button, 'hours').kind, null);

console.log('suggest tests ok');
