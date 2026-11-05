'use strict';

// Pure usage logic for tasks of type 'usage' (no Homey dependencies, easy to test).
//
// task.source = {
//   capability: 'measure_power',
//   metric: 'hours' | 'cycles' | 'counter' | 'level' | 'signal',
//   direction: 'down' | 'up',                              // level only: due when the value drops to / rises to the threshold
//   condition: { op: 'true' | 'gt' | 'lt' | 'equals' | 'in', value },   // when is the device "running" (hours/cycles),
//                                                         // or when does it ask for attention (signal; 'in' = comma list)
//   offDelayMin: 3,                                        // must be "not running" this long before a run ends
//   minRunMin: 1,                                          // shorter runs are not counted as a cycle
// }
// task.usage = amount since the task was last done (hours, cycles or units of the capability);
//              for 'level' the current value the device reports (e.g. 45 % filter left, 13 days of salt)
// task.track = { last, running, runStart, since, below, ref, ack }   // internal bookkeeping; ref = level at the start
//              signal: running = the device reports the condition now, ack = marked done while it still does
//
// 'signal': due as long as the device reports something (water tank empty, dust bag full, a message on the display);
//           when the signal goes away (tank refilled) the task is marked done by itself. source.holdMin: the signal
//           must last this long first (default 10), so emptying a tank yourself or a short glitch stays quiet.
//           track.confirmed = the signal lasted long enough.
//
// task.autoDone = { capability, op: 'true' | 'equals' | 'contains', value }   // optional, any task type:
//                 the task is marked done when this condition becomes true (e.g. alarm_smoke during a test)

const HOUR = 3600000;
const MINUTE = 60000;

function defaultTrack() {
  return {
    last: null, running: false, runStart: null, since: null, below: null, ref: null,
  };
}

// A level that moves back this far towards "full" means the consumable was replaced or refilled.
const RESET_SHARE = 0.3;

function isRunning(value, condition = {}) {
  switch (condition.op) {
    case 'gt': return typeof value === 'number' && value > Number(condition.value);
    case 'lt': return typeof value === 'number' && value < Number(condition.value);
    case 'in': return value !== null && value !== undefined
      && String(condition.value ?? '').split(',').map(v => v.trim()).filter(Boolean).includes(String(value));
    case 'equals': return value !== null && value !== undefined && String(value) === String(condition.value);
    case 'contains': return value !== null && value !== undefined && String(condition.value ?? '') !== ''
      && String(value).toLowerCase().includes(String(condition.value).toLowerCase());
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

  if (source.metric === 'level') return applyLevel(task, value);
  if (source.metric === 'signal') return applySignal(task, value, now);

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
 * Level reported by the device. Returns 'reset' when it jumps back towards full (replaced / refilled:
 * the caller marks the task done), 'event' when it changed, or null.
 */
function applyLevel(task, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const { track, source } = task;
  const up = source.direction === 'up';
  const last = track.last;
  track.last = value;
  task.usage = value;
  if (typeof track.ref !== 'number') {
    track.ref = value;
    return 'event';
  }
  // Remember the "fullest" value since the task was last done: progress is measured from there.
  const back = up ? last - value : value - last;
  if (typeof last === 'number' && back > 0 && back >= RESET_SHARE * Math.max(Math.abs(last), Math.abs(value))) {
    track.ref = value;
    return 'reset';
  }
  track.ref = up ? Math.min(track.ref, value) : Math.max(track.ref, value);
  return value !== last ? 'event' : null;
}

/**
 * Signal reported by the device. Returns 'reset' when it went away while the task was open (the caller marks
 * the task done), 'event' when it changed, or null.
 */
function holdMs(source) {
  return Math.max(0, Number(source.holdMin ?? 10) || 0) * MINUTE;
}

function applySignal(task, value, now) {
  if (value === null || value === undefined) return null;
  const { track, source } = task;
  const active = isRunning(value, source.condition);
  const changed = track.last !== value;
  track.last = value;
  if (active && !track.running) {
    const confirmed = holdMs(source) === 0;
    Object.assign(track, {
      running: true, since: now, ack: false, confirmed,
    });
    return confirmed ? 'event' : 'change';
  }
  if (!active && track.running) {
    // Gone before the wait time was over: nothing happened. Gone after: done by itself (unless marked done already).
    const confirmed = track.confirmed !== false;
    const open = confirmed && !track.ack;
    Object.assign(track, {
      running: false, since: null, ack: false, confirmed: null,
    });
    if (open) return 'reset';
    return confirmed ? 'event' : 'change';
  }
  return changed ? 'change' : null;
}

// Called every minute: a signal that lasted the wait time becomes "due".
function confirmSignal(task, now) {
  const { track, source } = task;
  if (track.running && track.confirmed === false && now - track.since >= holdMs(source)) {
    track.confirmed = true;
    return 'event';
  }
  return null;
}

// A signal task asks for attention while the device reports it (long enough), unless it was marked done in the meantime.
function signalActive(task) {
  const track = task.track || {};
  return Boolean(track.running && track.confirmed !== false && !track.ack);
}

// Progress (0 = just done, 1 = due) of a level task.
function levelProgress(task) {
  const src = task.source || {};
  const track = task.track || {};
  if (typeof track.last !== 'number') return 0;
  const value = track.last;
  const threshold = Number(task.threshold) || 0;
  let ref = typeof track.ref === 'number' ? track.ref : value;
  // A percentage that counts down starts at 100 %, also when tracking began halfway (e.g. a worn brush).
  if (src.direction !== 'up' && src.units === '%') ref = Math.max(ref, 100);
  if (src.direction === 'up') {
    if (value >= threshold) return 1;
    return ref < threshold ? Math.max(0, (value - ref) / (threshold - ref)) : 0;
  }
  if (value <= threshold) return 1;
  return ref > threshold ? Math.max(0, (ref - value) / (ref - threshold)) : 0;
}

// Edge detection for autoDone: true when the condition just became true.
function applyAutoDone(task, value) {
  const matched = isRunning(value, task.autoDone);
  const before = task.autoLast;
  task.autoLast = matched;
  return matched && before === false;
}

/**
 * Periodic housekeeping: ends runs whose off-delay has passed and adds running time to 'hours' so
 * the progress grows while the device is on. Returns 'event', 'change' or null like applyValue.
 */
function tick(task, now) {
  const { source, track } = task;
  if (!source || !track || !track.running) return null;
  if (source.metric === 'signal') return confirmSignal(task, now);
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
  if (task.source && task.source.metric === 'signal') {
    // Done by the user while the device still reports it: quiet until the signal goes away and comes back.
    if (task.track && task.track.running) task.track.ack = true;
    return;
  }
  if (task.source && task.source.metric === 'level') {
    // The level stays what the device reports; progress counts from the current value again.
    if (task.track && typeof task.track.last === 'number') task.track.ref = task.track.last;
    return;
  }
  task.usage = 0;
  if (task.track && task.track.running) {
    task.track.since = now;
    task.track.runStart = now;
  }
}

module.exports = {
  defaultTrack, isRunning, applyValue, tick, resetUsage, levelProgress, signalActive, applyAutoDone,
};
