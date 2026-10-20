'use strict';

// Pure usage logic for tasks of type 'usage' (no Homey dependencies, easy to test).
//
// task.source = {
//   capability: 'measure_power',
//   metric: 'hours' | 'cycles' | 'counter',
//   condition: { op: 'true' | 'gt' | 'equals', value },   // when is the device "running" (hours/cycles)
//   offDelayMin: 3,                                        // must be "not running" this long before a run ends
//   minRunMin: 1,                                          // shorter runs are not counted as a cycle
// }
// task.usage = amount since the task was last done (hours, cycles or units of the capability)
// task.track = { last, running, runStart, since, below }   // internal bookkeeping

const HOUR = 3600000;
const MINUTE = 60000;

function defaultTrack() {
  return {
    last: null, running: false, runStart: null, since: null, below: null,
  };
}

function isRunning(value, condition = {}) {
  switch (condition.op) {
    case 'gt': return typeof value === 'number' && value > Number(condition.value);
    case 'equals': return value !== null && value !== undefined && String(value) === String(condition.value);
    case 'true':
    default: return value === true;
  }
}

function offDelay(source) {
  return Math.max(0, Number(source.offDelayMin) || 0) * MINUTE;
}

function stopRun(task, at) {
  const { track, source } = task;
  if (source.metric === 'hours') {
    task.usage = (Number(task.usage) || 0) + Math.max(0, at - track.since) / HOUR;
  } else if (source.metric === 'cycles' && at - track.runStart >= Math.max(0, Number(source.minRunMin) || 0) * MINUTE) {
    task.usage = (Number(task.usage) || 0) + 1;
  }
  track.running = false;
  track.runStart = null;
  track.since = null;
  track.below = null;
}

/**
 * Apply a new capability value. Returns 'event' when a run started/stopped or a counter moved
 * (worth saving right away), 'change' for internal bookkeeping only, or null.
 */
function applyValue(task, value, now) {
  const { source } = task;
  if (!source || !source.capability) return null;
  task.track = { ...defaultTrack(), ...(task.track || {}) };
  const { track } = task;

  if (source.metric === 'counter') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const last = track.last;
    track.last = value;
    if (typeof last !== 'number') return 'change';
    const delta = value - last;
    if (delta > 0) {
      task.usage = (Number(task.usage) || 0) + delta;
      return 'event';
    }
    // A lower value means the device counter was reset: count from zero again.
    if (delta < 0 && value > 0) {
      task.usage = (Number(task.usage) || 0) + value;
      return 'event';
    }
    return 'change';
  }

  if (isRunning(value, source.condition)) {
    if (!track.running) {
      track.running = true;
      track.runStart = now;
      track.since = now;
      track.below = null;
      return 'event';
    }
    if (track.below) {
      // Running again within the off-delay (e.g. a washing machine pausing): same run.
      track.below = null;
      return 'change';
    }
    return null;
  }

  if (track.running) {
    if (offDelay(source) > 0) {
      if (!track.below) {
        track.below = now;
        return 'change';
      }
      return null;
    }
    stopRun(task, now);
    return 'event';
  }
  return null;
}

/**
 * Periodic housekeeping: ends runs whose off-delay has passed and adds running time to 'hours' so
 * the progress grows while the device is on. Returns 'event', 'change' or null like applyValue.
 */
function tick(task, now) {
  const { source, track } = task;
  if (!source || !track || !track.running) return null;
  if (track.below && now - track.below >= offDelay(source)) {
    stopRun(task, track.below);
    return 'event';
  }
  if (source.metric === 'hours' && !track.below && now > track.since) {
    task.usage = (Number(task.usage) || 0) + (now - track.since) / HOUR;
    track.since = now;
    return 'change';
  }
  return null;
}

// Task done: count from zero again, but keep tracking a run that is still going on.
function resetUsage(task, now) {
  task.usage = 0;
  if (task.track && task.track.running) {
    task.track.since = now;
    task.track.runStart = now;
  }
}

module.exports = {
  defaultTrack, isRunning, applyValue, tick, resetUsage,
};
