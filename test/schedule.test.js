'use strict';

// Plain node tests for the date/status logic: `npm test`
const assert = require('assert');
const { addInterval, daysBetween, evaluateTask } = require('../lib/schedule');

assert.strictEqual(addInterval('2026-01-31', 1, 'months'), '2026-02-28');
assert.strictEqual(addInterval('2024-02-29', 1, 'years'), '2025-02-28');
assert.strictEqual(addInterval('2026-10-20', 2, 'weeks'), '2026-11-03');
assert.strictEqual(addInterval('2026-10-20', 10, 'years'), '2036-10-20');
assert.strictEqual(daysBetween('2026-10-20', '2026-10-27'), 7);

const base = { type: 'date', every: 3, unit: 'months', leadDays: 7, lastDone: '2026-07-20' };
assert.strictEqual(evaluateTask(base, '2026-10-01').status, 'ok');
assert.strictEqual(evaluateTask(base, '2026-10-14').status, 'soon');
assert.strictEqual(evaluateTask(base, '2026-10-20').status, 'due');
assert.strictEqual(evaluateTask(base, '2026-10-26').status, 'due');
assert.strictEqual(evaluateTask(base, '2026-10-27').status, 'overdue');
assert.strictEqual(evaluateTask(base, '2026-10-27').days, -7);
assert.strictEqual(evaluateTask({ ...base, snoozeUntil: '2026-11-01' }, '2026-10-27').status, 'soon');

const counter = { type: 'counter', threshold: 100, counter: 0, leadPercent: 10 };
assert.strictEqual(evaluateTask({ ...counter, counter: 50 }, '2026-10-20').status, 'ok');
assert.strictEqual(evaluateTask({ ...counter, counter: 95 }, '2026-10-20').status, 'soon');
assert.strictEqual(evaluateTask({ ...counter, counter: 100 }, '2026-10-20').status, 'due');
assert.strictEqual(evaluateTask({ ...counter, counter: 120, dueSince: '2026-10-01' }, '2026-10-20').status, 'overdue');

const usage = { type: 'usage', threshold: 250, usage: 0, leadPercent: 10, every: 3, unit: 'months', leadDays: 7, lastDone: '2026-10-20' };
assert.strictEqual(evaluateTask({ ...usage, usage: 100 }, '2026-11-01').status, 'ok');
assert.strictEqual(evaluateTask({ ...usage, usage: 240 }, '2026-11-01').status, 'soon');
assert.strictEqual(evaluateTask({ ...usage, usage: 260 }, '2026-11-01').status, 'due');
assert.strictEqual(evaluateTask({ ...usage, usage: 10, combine: true }, '2027-01-20').status, 'due');
assert.strictEqual(evaluateTask({ ...usage, usage: 260, combine: true }, '2026-11-01').status, 'due');
assert.strictEqual(evaluateTask({ ...usage, usage: 10, combine: true }, '2026-11-01').days, 80);
assert.strictEqual(evaluateTask({ ...usage, usage: 10 }, '2027-05-01').status, 'ok');

console.log('schedule tests ok');
