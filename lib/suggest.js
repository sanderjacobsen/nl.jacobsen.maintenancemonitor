'use strict';

// Suggest how to measure usage of a linked Homey device (pure function, no Homey dependencies).
//
// device = { class, capabilities: [{ id, title, type, units, values: [{ id, title }] | null }] }
// Returns { metric, srcCap, op, cmpValue, kind, title, valueTitle } where kind is
// 'status' | 'power' | 'boolean' | 'counter' | null (nothing usable).

// Status values that mean "the appliance is running".
const RUNNING = /^(in[ _-]?use|running|run|washing|drying|rinsing|spinning|cleaning|printing|busy|active|working|in[ _-]?progress|program(me)?[ _-]?running|cycle[ _-]?running|heating|brewing)$/i;
// Capabilities that look like a status / state.
const STATUS_CAP = /(status|state|phase|operation|mode)/i;
// Cumulative counters of runs (e.g. Litter-Robot clean cycles, robot vacuum cleaning count).
const RUN_COUNTER = /(clean_cycles|cleaning_count|cycle_count|cycles|wash(es)?_count|runs?_count|odometer)/i;

function statusSuggestion(device) {
  const caps = device.capabilities.filter(c => (c.type === 'enum' || c.type === 'string') && Array.isArray(c.values) && c.values.length);
  // Prefer capabilities that are named like a status.
  caps.sort((a, b) => Number(STATUS_CAP.test(b.id)) - Number(STATUS_CAP.test(a.id)));
  for (const cap of caps) {
    const value = cap.values.find(v => RUNNING.test(String(v.id)) || RUNNING.test(String(v.title || '')));
    if (value) {
      return {
        srcCap: cap.id, op: 'equals', cmpValue: value.id, kind: 'status', title: cap.title, valueTitle: value.title || value.id,
      };
    }
  }
  return null;
}

function suggestSource(device, metric = 'hours', watts = 10) {
  if (!device || !Array.isArray(device.capabilities)) return { metric, kind: null };
  const caps = device.capabilities;
  const find = id => caps.find(c => c.id === id);

  if (metric === 'counter') {
    const counter = caps.find(c => c.type === 'number' && RUN_COUNTER.test(c.id))
      || caps.find(c => c.type === 'number' && c.id.startsWith('meter_'))
      || caps.find(c => c.type === 'number');
    return counter ? {
      metric, srcCap: counter.id, op: 'true', cmpValue: '', kind: 'counter', title: counter.title, units: counter.units,
    } : { metric, kind: null };
  }

  // Number of runs: a device that counts its own runs is the most accurate source.
  if (metric === 'cycles') {
    const counter = caps.find(c => c.type === 'number' && RUN_COUNTER.test(c.id));
    if (counter) {
      return {
        metric: 'counter', srcCap: counter.id, op: 'true', cmpValue: '', kind: 'counter', title: counter.title, units: counter.units,
      };
    }
  }

  // Running hours / runs: 1) a status like "In use", 2) power above a threshold (smart plug), 3) on/off.
  const status = statusSuggestion(device);
  if (status) return { metric, ...status, ...(metric === 'cycles' ? { offDelayMin: 15, minRunMin: 10 } : { offDelayMin: 5, minRunMin: 1 }) };

  const power = find('measure_power');
  if (power) {
    return {
      metric, srcCap: 'measure_power', op: 'gt', cmpValue: watts, kind: 'power', title: power.title, units: power.units || 'W',
      ...(metric === 'cycles' ? { offDelayMin: 5, minRunMin: 10 } : { offDelayMin: 3, minRunMin: 1 }),
    };
  }

  const bool = find('onoff') || caps.find(c => c.type === 'boolean' && !c.id.startsWith('alarm_'));
  if (bool) {
    return {
      metric, srcCap: bool.id, op: 'true', cmpValue: '', kind: 'boolean', title: bool.title,
    };
  }
  return { metric, kind: null };
}

module.exports = { suggestSource, RUNNING };
