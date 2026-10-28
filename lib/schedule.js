'use strict';

// Pure date and status logic, no Homey dependencies (easy to test).
const { levelProgress } = require('./usage');
// Dates are plain 'YYYY-MM-DD' strings in the Homey timezone.

const STATUS_ORDER = ['ok', 'soon', 'due', 'overdue'];
const UNITS = ['days', 'weeks', 'months', 'years'];

function todayString(timezone) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function toUtc(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((toUtc(to) - toUtc(from)) / 86400000);
}

function addDays(dateString, days) {
  return fromUtc(toUtc(dateString) + days * 86400000);
}

function addInterval(dateString, every, unit) {
  const n = Number(every) || 0;
  if (unit === 'days') return addDays(dateString, n);
  if (unit === 'weeks') return addDays(dateString, n * 7);
  const [y, m, d] = dateString.split('-').map(Number);
  const months = unit === 'years' ? n * 12 : n;
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return fromUtc(target.getTime());
}

function severity(status) {
  return STATUS_ORDER.indexOf(status);
}

function worst(a, b) {
  return severity(a) >= severity(b) ? a : b;
}

// Status of the date part of a task (also used for usage tasks with "or every X months").
function evaluateDate(task, today, overdueAfter, snoozed) {
  const lastDone = isDateString(task.lastDone) ? task.lastDone : today;
  let dueDate = addInterval(lastDone, task.every, task.unit);
  if (snoozed && daysBetween(dueDate, task.snoozeUntil) > 0) dueDate = task.snoozeUntil;
  const days = daysBetween(today, dueDate);
  const lead = Number(task.leadDays) >= 0 ? Number(task.leadDays) : 7;
  let status = 'ok';
  if (days <= -overdueAfter) status = 'overdue';
  else if (days <= 0) status = 'due';
  else if (days <= lead) status = 'soon';
  return { status, dueDate, days };
}

// Status of an amount-based part (manual counter or measured usage).
function evaluateAmount(progress, task, today, overdueAfter, snoozed) {
  const leadPercent = Number.isFinite(Number(task.leadPercent)) ? Number(task.leadPercent) : 10;
  let status = 'ok';
  if (!snoozed) {
    if (progress >= 1) {
      status = 'due';
      if (isDateString(task.dueSince) && daysBetween(task.dueSince, today) >= overdueAfter) status = 'overdue';
    } else if (progress >= 1 - leadPercent / 100) {
      status = 'soon';
    }
  }
  return { status, progress };
}

/**
 * Compute the state of one task.
 * Types: 'date' (every X days/weeks/months/years), 'counter' (increased by a flow card) and
 * 'usage' (measured from a linked Homey device, optionally combined with a date: whichever comes first).
 * Returns { status, dueDate, days, progress, amountStatus } where days is null when there is no date part.
 */
function evaluateTask(task, today, options = {}) {
  const overdueAfter = Number.isFinite(options.overdueAfterDays) ? options.overdueAfterDays : 7;
  const snoozed = isDateString(task.snoozeUntil) && daysBetween(today, task.snoozeUntil) > 0;

  if (task.type === 'counter' || task.type === 'usage') {
    const isLevel = task.type === 'usage' && task.source && task.source.metric === 'level';
    const threshold = Number(task.threshold) > 0 ? Number(task.threshold) : 1;
    const progress = isLevel ? levelProgress(task) : (Number(task.type === 'counter' ? task.counter : task.usage) || 0) / threshold;
    const part = evaluateAmount(progress, task, today, overdueAfter, snoozed);
    if (task.type === 'usage' && task.combine) {
      const date = evaluateDate(task, today, overdueAfter, snoozed);
      return {
        status: worst(part.status, date.status), dueDate: date.dueDate, days: date.days, progress: part.progress, amountStatus: part.status,
      };
    }
    return {
      status: part.status, dueDate: null, days: null, progress: part.progress, amountStatus: part.status,
    };
  }

  const date = evaluateDate(task, today, overdueAfter, snoozed);
  return {
    status: date.status, dueDate: date.dueDate, days: date.days, progress: null, amountStatus: null,
  };
}

module.exports = {
  STATUS_ORDER, UNITS, todayString, isDateString, daysBetween, addDays, addInterval, severity, evaluateTask,
};
