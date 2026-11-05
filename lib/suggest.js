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
// Numbers that are levels or settings, not cumulative counters.
const NOT_COUNTER = /^(measure_battery|dim|volume_set|target_temperature)/;

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
    // Levels (battery, dim, percentages) go up and down, so they never make a usable counter.
    const numbers = caps.filter(c => c.type === 'number' && c.units !== '%' && !NOT_COUNTER.test(c.id));
    const counter = numbers.find(c => RUN_COUNTER.test(c.id))
      || numbers.find(c => c.id.startsWith('meter_'))
      || numbers[0];
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

// ---------- maintenance signals the device reports itself ----------

// Capabilities about a consumable or container (tank, bag, salt, filter, ...).
const CONSUMABLE = /(tank|bag|bin|container|reservoir|cartridge|detergent|salt|zout|filter|dust|water|consum|supply|descal|ontkalk|ultraphase|twindos)/i;
// Enum values that ask for attention.
// Whole words only (ids are split on _ and -), so e.g. "Emptying" (busy emptying) does not count as "empty".
const ATTENTION = /\b(low|no water|empty|full|not installed|missing|insufficient|refill|replace|leeg|vol|bijvullen|vervangen|ontbreekt)\b/i;
// Boolean alarms that mean "do something" (not leaks, motion, contacts, ...).
const ALARM = /^alarm_(information|message|notification|filter|salt|detergent|tank|bin|bag|full|empty|refill|replace|descal|service|maintenance|battery|water_shortage)/i;
// Percentages / days left of a consumable (battery excluded: alarm_battery covers that).
const LEFT = /(salt|filter|detergent|brush|sensor|mop|cartridge|consum|_left|remaining|life)/i;

/**
 * Maintenance tasks a linked device can drive by itself, e.g. Dreame "Water Tank: low water", Miele "message on the
 * appliance", "Salt left side" in %. Settings (setable capabilities) are skipped. Returns task drafts for the settings page.
 */
function suggestDeviceTasks(device) {
  if (!device || !Array.isArray(device.capabilities)) return [];
  const out = [];
  for (const c of device.capabilities) {
    if (c.setable) continue;
    const label = `${c.title || c.id} ${c.id}`;
    if (c.type === 'enum' && Array.isArray(c.values) && CONSUMABLE.test(label)) {
      const bad = c.values.filter(v => ATTENTION.test(`${v.id} ${v.title || ''}`.replace(/[_-]/g, ' ')));
      if (bad.length && bad.length < c.values.length) {
        out.push({
          key: `signal:${c.id}`, name: `${c.title}: ${bad.map(v => v.title || v.id).join(' / ')}`, type: 'usage', threshold: 1, leadPercent: 0,
          source: { capability: c.id, metric: 'signal', condition: { op: 'in', value: bad.map(v => v.id).join(',') } },
        });
      }
    } else if (c.type === 'boolean' && ALARM.test(c.id)) {
      out.push({
        key: `signal:${c.id}`, name: c.title || c.id, type: 'usage', threshold: 1, leadPercent: 0,
        source: { capability: c.id, metric: 'signal', condition: { op: 'true', value: null } },
      });
    } else if (c.type === 'number' && c.id !== 'measure_battery' && LEFT.test(label)
      && (c.units === '%' || /^(days?|dagen|d)$/i.test(String(c.units || '')))) {
      const days = c.units !== '%';
      out.push({
        key: `level:${c.id}`, name: c.title || c.id, type: 'usage', threshold: days ? 7 : 10, leadPercent: 10,
        source: { capability: c.id, metric: 'level', direction: 'down', units: c.units },
      });
    }
  }
  return out.sort((a, b) => Number(b.source.metric === 'signal') - Number(a.source.metric === 'signal'));
}

module.exports = { suggestSource, suggestDeviceTasks, RUNNING };
