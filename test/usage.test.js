'use strict';

// Plain node tests for usage tracking: `npm test`
const assert = require('assert');
const { applyValue, tick, resetUsage } = require('../lib/usage');

const M = 60000;
const H = 60 * M;

// Hours from a power threshold, with 3 minutes off-delay
const hours = { source: { capability: 'measure_power', metric: 'hours', condition: { op: 'gt', value: 10 }, offDelayMin: 3 }, usage: 0 };
applyValue(hours, 2, 0);
assert.strictEqual(hours.track.running, false);
assert.strictEqual(applyValue(hours, 150, 0), 'event');
tick(hours, 1 * H);
assert.ok(Math.abs(hours.usage - 1) < 1e-9, 'one hour while running');
applyValue(hours, 3, 1.5 * H); // below threshold: pending stop
applyValue(hours, 140, 1.5 * H + 1 * M); // back on within off-delay: same run
applyValue(hours, 0, 2 * H);
assert.strictEqual(tick(hours, 2 * H + 2 * M), null); // not yet 3 minutes
assert.strictEqual(tick(hours, 2 * H + 3 * M), 'event');
assert.ok(Math.abs(hours.usage - 2) < 1e-9, `two hours, got ${hours.usage}`);
assert.strictEqual(hours.track.running, false);

// Cycles from onoff, minimum run 1 minute
const cycles = { source: { capability: 'onoff', metric: 'cycles', condition: { op: 'true' }, offDelayMin: 0, minRunMin: 1 }, usage: 0 };
applyValue(cycles, true, 0); applyValue(cycles, false, 30 * 1000); // too short
applyValue(cycles, true, 1 * H); applyValue(cycles, false, 2 * H);
applyValue(cycles, true, 3 * H); applyValue(cycles, false, 4 * H);
assert.strictEqual(cycles.usage, 2);

// Cycles from an enum status
const washer = { source: { capability: 'display_status', metric: 'cycles', condition: { op: 'equals', value: 'In use' }, offDelayMin: 2, minRunMin: 5 }, usage: 0 };
applyValue(washer, 'Waiting to start', 0); applyValue(washer, 'In use', 1 * M); applyValue(washer, 'Rinse hold', 30 * M);
tick(washer, 33 * M);
assert.strictEqual(washer.usage, 1);

// Counter from a cumulative capability, including a reset of the device counter
const counter = { source: { capability: 'meter_power', metric: 'counter' }, usage: 0 };
applyValue(counter, 100, 0); applyValue(counter, 102.5, 1); applyValue(counter, 0.5, 2); applyValue(counter, 1.5, 3);
assert.ok(Math.abs(counter.usage - 4) < 1e-9, `counter 4, got ${counter.usage}`);

// Done while running: start counting again from now
applyValue(hours, 200, 10 * H);
resetUsage(hours, 10.5 * H);
tick(hours, 11 * H);
assert.ok(Math.abs(hours.usage - 0.5) < 1e-9);

console.log('usage tests ok');
