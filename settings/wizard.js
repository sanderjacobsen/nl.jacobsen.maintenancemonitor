'use strict';

/* Wizard "Onderdeel toevoegen" for the Maintenance Monitor settings page.
 * MaintenanceWizard(root, { t, api, alert, onDone(items), onCancel() }) renders the four steps into `root`. */

// Shared by the wizard and the settings page.
// eslint-disable-next-line no-unused-vars
const MM = {
  // Number capability that reports what is left of a part, e.g. "main_brush_left" (%) or "salt_days_left" (days).
  findLevelCap(dev, match) {
    if (!dev || !match) return null;
    const caps = dev.capabilities.filter(c => c.type === 'number' && c.id.toLowerCase().includes(String(match).toLowerCase()) && !/time/i.test(c.id));
    return caps.find(c => c.units === '%') || caps.find(c => /(left|remaining|life|days)/i.test(c.id)) || null;
  },
  // The automatic "done" of a (template) task, only when the linked device has that capability.
  autoDoneFor(dev, tk) {
    return dev && tk.autoDone && dev.capabilities.some(c => c.id === tk.autoDone.capability) ? tk.autoDone : null;
  },
  // Source fields for "follow the value of the device".
  levelSource(dev, level) {
    const cap = MM.findLevelCap(dev, level && level.match)
      || (dev ? dev.capabilities.find(c => c.type === 'number' && c.units === '%' && c.id !== 'measure_battery') : null);
    return {
      metric: 'level', srcCap: cap ? cap.id : '', direction: (level && level.direction) || 'down', op: 'true', cmpValue: '',
      threshold: level ? level.threshold : 10, auto: Boolean(cap && level),
    };
  },
  // "When is the task done by itself", in words.
  describeAutoDone(dev, ad, tr) {
    const c = dev && ad ? dev.capabilities.find(x => x.id === ad.capability) : null;
    if (!c) return '';
    const cond = ad.op === 'contains' ? tr('auto.desc_contains', { value: ad.value }) : ad.op === 'equals' ? tr('auto.desc_equals', { value: ad.value }) : tr('auto.desc_on');
    return tr('auto.desc', { cap: c.title, cond });
  },
};
// eslint-disable-next-line no-unused-vars
function MaintenanceWizard(root, deps) {
  root.innerHTML = `<div class="ha">
  <div class="wz-progress" id="progress"><span></span><span></span><span></span><span></span></div>
  <div class="wz-step" id="steps"></div>
  <h1 class="homey-title" id="title"></h1>

  <div id="step1"><div class="wz-grid" id="cats"></div></div>

  <div id="step2" class="hidden">
    <div class="homey-form">
      <div class="homey-form-group">
        <label class="homey-form-label" for="name" data-i18n="pair.name"></label>
        <input class="homey-form-input" id="name" type="text" maxlength="60" />
      </div>
      <div class="homey-form-group">
        <label class="homey-form-label" for="year" data-i18n="pair.install"></label>
        <div class="wz-pair">
          <select class="homey-form-select" id="year"></select>
          <select class="homey-form-select" id="month"></select>
        </div>
        <p class="wz-hint" data-i18n="pair.install_hint"></p>
      </div>
      <div class="homey-form-group">
        <label class="homey-form-label" for="link" data-i18n="usage.link"></label>
        <select class="homey-form-select" id="link"></select>
        <p class="wz-hint" data-i18n="usage.link_hint"></p>
      </div>
    </div>
  </div>

  <div id="step3" class="hidden">
    <p class="wz-hint" data-i18n="pair.tasks_hint"></p>
    <div id="tasks"></div>
    <button class="homey-button-secondary-shadow-full" id="addCustom" data-i18n="pair.add_custom"></button>
  </div>

  <div id="step4" class="hidden"><div id="summary"></div></div>
</div>

<div class="wz-nav" id="nav">
  <button class="homey-button-transparent" id="back" data-i18n="pair.back"></button>
  <button class="homey-button-primary-shadow" id="next" data-i18n="pair.next"></button>
</div>`;

  const UNITS = ['days', 'weeks', 'months', 'years'];
  const $ = id => root.querySelector(`#${id}`);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tr = (k, v) => deps.t(k, v);
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  let templates = [];
  let cat = null;
  let step = 1;
  let tasks = [];
  let homeyDevices = null; // other Homey devices that can be linked (loaded in the background)

  const linked = () => (homeyDevices || []).find(d => d.id === $('link').value) || null;
  const capOf = (dev, id) => (dev ? dev.capabilities.find(c => c.id === id) : null);

  // Best guess of how to detect "running" for a linked device: power above X W, otherwise on/off.
  // Suggestion from the app (lib/suggest.js): status like "In use", else power above X W, else on/off.
  function autoSource(dev, tk) {
    const metric = (tk.usage && tk.usage.metric) || tk.metric || 'hours';
    const sug = dev && dev.suggest && dev.suggest[metric];
    if (!sug || !sug.kind) return { metric, srcCap: '', op: 'true', cmpValue: '' };
    const cmpValue = sug.kind === 'power' ? ((tk.usage && tk.usage.watts) || sug.cmpValue) : sug.cmpValue;
    return {
      metric: sug.metric, srcCap: sug.srcCap, op: sug.op, cmpValue, auto: true, offDelayMin: sug.offDelayMin ?? 3, minRunMin: sug.minRunMin ?? 1,
    };
  }

  // Plain-language description of the current choice, e.g. "Counts as running when Status is 'In use'".
  function describeSource(tk) {
    const c = capOf(linked(), tk.srcCap);
    if (!c) return '';
    if ((tk.metric || 'hours') === 'counter') return tr('usage.desc_counter', { cap: c.title });
    if (tk.metric === 'level') return tr('usage.desc_level', { cap: c.title, value: `${c.value ?? '–'} ${c.units || ''}`.trim() });
    let cond = tr('usage.is_on');
    if (tk.op === 'gt') cond = `${tr('usage.greater_than')} ${tk.cmpValue} ${c.units || ''}`.trim();
    if (tk.op === 'equals') {
      const v = (c.values || []).find(x => String(x.id) === String(tk.cmpValue));
      cond = `${tr('usage.equals')} '${v ? v.title : tk.cmpValue}'`;
    }
    return tr('usage.desc_running', { cap: c.title, cond });
  }

  // Linking changes the suggested interval types: tasks with a usage suggestion switch to "by usage" (and back).
  function applyLink() {
    const dev = linked();
    for (const tk of tasks) {
      if (dev && tk.level && tk.type !== 'counter' && MM.findLevelCap(dev, tk.level.match)) {
        Object.assign(tk, { type: 'usage', combine: true }, MM.levelSource(dev, tk.level));
      } else if (dev && tk.usage && tk.type !== 'counter') {
        Object.assign(tk, { type: 'usage', combine: true, threshold: tk.usage.threshold, offDelayMin: 3, minRunMin: 1 }, autoSource(dev, tk));
      } else if (!dev && tk.type === 'usage') {
        tk.type = 'date';
      }
    }
  }

  function unitLabel(tk) {
    if (tk.metric === 'hours') return tr('usage.unit_hours');
    if (tk.metric === 'cycles') return tr('usage.unit_cycles');
    const c = capOf(linked(), tk.srcCap);
    return (c && c.units) || '';
  }

  // ---- date helpers (same rules as lib/schedule.js) ----
  function addInterval(date, every, unit) {
    const [y, m, d] = date.split('-').map(Number);
    if (unit === 'days' || unit === 'weeks') {
      return new Date(Date.UTC(y, m - 1, d) + (unit === 'weeks' ? 7 : 1) * every * 86400000).toISOString().slice(0, 10);
    }
    const target = new Date(Date.UTC(y, m - 1 + (unit === 'years' ? every * 12 : every), 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, last));
    return target.toISOString().slice(0, 10);
  }
  function installDate() {
    const y = $('year').value;
    if (!y) return null;
    const date = `${y}-${$('month').value || '01'}-01`;
    return date > today ? today : date;
  }
  function lastDoneOf(tk) {
    if (tk.last === 'install' && installDate()) return installDate();
    if (tk.last === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(tk.lastDate || '') && tk.lastDate <= today) return tk.lastDate;
    return today;
  }
  const fmt = (date, opts) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, opts || { day: 'numeric', month: 'long', year: 'numeric' });
  const unitText = (n, unit) => `${n} ${tr('pair.units.' + unit)}`;
  // "Elke maand" / "Elke 3 maanden" (lowercase when used inside a sentence)
  const everyText = (n, unit, lower) => {
    const txt = Number(n) === 1 ? tr('pair.every_one.' + unit) : `${tr('pair.every')} ${unitText(n, unit)}`;
    return lower ? txt.charAt(0).toLowerCase() + txt.slice(1) : txt;
  };

  // Break long Dutch compound words at a sensible place in the small tiles.
  const BREAKS = {
    Rookmelder: 'Rook­melder', Wasmachine: 'Was­machine', Koffiezetapparaat: 'Koffiezet­apparaat', Robotstofzuiger: 'Robot­stofzuiger',
    Waterontharder: 'Water­ontharder', Vloerverwarming: 'Vloer­verwarming', Zonnepanelen: 'Zonne­panelen', Drinkfontein: 'Drink­fontein',
    Vaatwasser: 'Vaat­wasser', Afzuigkap: 'Afzuig­kap', warmtepomp: 'warmte­pomp', Ventilator: 'Venti­lator',
    ventilatie: 'venti­latie', Mechanische: 'Mecha­nische',
  };
  const softHyphen = name => name.split(' ').map(w => BREAKS[w] || w).join(' ');

  // ---- rendering ----
  function show() {
    for (let i = 1; i <= 4; i++) $(`step${i}`).classList.toggle('hidden', i !== step);
    [...$('progress').children].forEach((el, i) => el.classList.toggle('on', i < step));
    $('steps').textContent = tr('pair.step', { n: step });
    $('title').textContent = tr(`pair.s${step}_title`);
    $('next').classList.toggle('hidden', step === 1);
    $('back').textContent = tr(step === 1 ? 'settings.cancel' : 'pair.back');
    $('next').textContent = tr(step === 4 ? 'pair.add' : 'pair.next');
    // The last button adds the item: green, like Homey's own "Connect" button.
    $('next').style.setProperty('--homey-button-background', step === 4 ? 'var(--homey-color-green)' : '');
    if (step === 3) renderTasks();
    if (step === 4) renderSummary();
    window.scrollTo(0, 0);
  }

  function renderCats() {
    $('cats').innerHTML = templates.map(c => `<div class="wz-tile ${cat && cat.id === c.id ? 'sel' : ''}" data-id="${c.id}">
      <span class="wz-icon" style="--icon:url('${c.iconUri}');"></span><div class="name">${esc(softHyphen(c.name))}</div></div>`).join('');
  }

  function lastText(tk) {
    if (tk.last === 'install' && installDate()) return `${tr('pair.last_install').toLowerCase()} (${fmt(installDate(), { month: 'short', year: 'numeric' })})`;
    if (tk.last === 'date') return fmt(lastDoneOf(tk));
    return tr('pair.last_today').toLowerCase();
  }

  function summaryOf(tk) {
    const auto = MM.autoDoneFor(linked(), tk) ? ` · ${tr('auto.short')}` : '';
    if (tk.type === 'usage') {
      const what = tr('usage.metric_' + (tk.metric || 'hours'));
      const amount = tk.metric === 'level' ? `${tr('usage.level_at')} ${tk.threshold} ${unitLabel(tk)}` : `${tr('usage.threshold').toLowerCase()} ${tk.threshold} ${unitLabel(tk)}`;
      return `${what} · ${amount}${tk.combine ? ` · ${tr('usage.or_date')}: ${everyText(tk.every, tk.unit, true)}` : ''}${auto}`;
    }
    if (tk.type === 'counter') return `${tr('pair.kind_counter')} · ${tr('pair.threshold').toLowerCase()} ${tk.threshold}${auto}`;
    return `${everyText(tk.every, tk.unit)} · ${tr('pair.lead').toLowerCase()} ${tk.leadDays} ${tr('pair.lead_days')} · ${tr('pair.last').toLowerCase()}: ${lastText(tk)}${auto}`;
  }

  function taskCard(tk, i) {
    const counter = tk.type === 'counter';
    const id = `t${i}`;
    const unitOpts = UNITS.map(u => `<option value="${u}" ${u === tk.unit ? 'selected' : ''}>${esc(tr('pair.units.' + u))}</option>`).join('');
    const lastOpts = [
      installDate() ? ['install', tr('pair.last_install')] : null,
      ['today', tr('pair.last_today')],
      ['date', tr('pair.last_date')],
    ].filter(Boolean).map(([v, l]) => `<option value="${v}" ${(tk.last === v || (v === 'today' && tk.last === 'install' && !installDate())) ? 'selected' : ''}>${esc(l)}</option>`).join('');

    const editor = !tk.open || !tk.use ? '' : `<div class="wz-editor">
      ${tk.custom ? `<label class="homey-form-label" for="${id}n">${esc(tr('pair.custom_name'))}</label>
        <input class="homey-form-input" type="text" id="${id}n" data-f="name" value="${esc(tk.name)}" maxlength="80" />` : ''}
      <label class="homey-form-label" for="${id}k">${esc(tr('pair.kind'))}</label>
      <select class="homey-form-select" id="${id}k" data-f="type">
        <option value="date" ${!counter ? 'selected' : ''}>${esc(tr('pair.kind_date'))}</option>
        <option value="counter" ${counter ? 'selected' : ''}>${esc(tr('pair.kind_counter'))}</option>
        ${linked() ? `<option value="usage" ${tk.type === 'usage' ? 'selected' : ''}>${esc(tr('usage.kind_usage'))}</option>` : ''}</select>
      ${tk.type === 'usage' ? usageEditor(tk, id) : counter ? `
        <label class="homey-form-label" for="${id}g">${esc(tr('pair.threshold'))}</label>
        <input class="homey-form-input" type="number" inputmode="numeric" min="1" id="${id}g" data-f="threshold" value="${tk.threshold}" />
        <label class="homey-form-label" for="${id}p">${esc(tr('pair.lead_percent'))}</label>
        <div class="wz-inline days"><input class="homey-form-input" type="number" inputmode="numeric" min="0" max="100" id="${id}p" data-f="leadPercent" value="${tk.leadPercent}" /><span>%</span></div>`
      : `
        <label class="homey-form-label" for="${id}e">${esc(tr('pair.every'))}</label>
        <div class="wz-inline"><input class="homey-form-input" type="number" inputmode="numeric" min="1" id="${id}e" data-f="every" value="${tk.every}" />
          <select class="homey-form-select" data-f="unit">${unitOpts}</select></div>
        <label class="homey-form-label" for="${id}l">${esc(tr('pair.lead'))}</label>
        <div class="wz-inline days"><input class="homey-form-input" type="number" inputmode="numeric" min="0" id="${id}l" data-f="leadDays" value="${tk.leadDays}" /><span>${esc(tr('pair.lead_days'))}</span></div>
        <label class="homey-form-label" for="${id}d">${esc(tr('pair.last'))}</label>
        <select class="homey-form-select" id="${id}d" data-f="last">${lastOpts}</select>
        ${tk.last === 'date' ? `<input class="homey-form-input" style="margin-top:8px" type="date" data-f="lastDate" max="${today}" value="${esc(tk.lastDate)}" />` : ''}`}
      ${tk.custom ? `<button class="homey-button-danger-small-shadow wz-remove" data-remove="${i}">${esc(tr('pair.remove'))}</button>` : ''}
    </div>`;

    return `<div class="wz-task ${tk.use ? '' : 'off'}" data-i="${i}">
      <label class="homey-form-checkbox">
        <input class="homey-form-checkbox-input" type="checkbox" data-f="use" ${tk.use ? 'checked' : ''} />
        <span class="homey-form-checkbox-checkmark"></span>
        <span class="homey-form-checkbox-text">${esc(tk.name || tr('pair.custom_name'))}</span>
      </label>
      <p class="wz-sum">${esc(summaryOf(tk))}</p>
      ${tk.use && !tk.open ? `<button class="homey-button-secondary-small-shadow wz-edit-btn" data-open="${i}">${esc(tr('settings.edit'))}</button>` : ''}
      ${editor}
    </div>`;
  }

  function dateFields(tk, id) {
    const unitOpts = UNITS.map(u => `<option value="${u}" ${u === tk.unit ? 'selected' : ''}>${esc(tr('pair.units.' + u))}</option>`).join('');
    const lastOpts = [
      installDate() ? ['install', tr('pair.last_install')] : null,
      ['today', tr('pair.last_today')],
      ['date', tr('pair.last_date')],
    ].filter(Boolean).map(([v, l]) => `<option value="${v}" ${(tk.last === v || (v === 'today' && tk.last === 'install' && !installDate())) ? 'selected' : ''}>${esc(l)}</option>`).join('');
    return `<label class="homey-form-label" for="${id}e">${esc(tr('pair.every'))}</label>
      <div class="wz-inline"><input class="homey-form-input" type="number" inputmode="numeric" min="1" id="${id}e" data-f="every" value="${tk.every}" />
        <select class="homey-form-select" data-f="unit">${unitOpts}</select></div>
      <label class="homey-form-label" for="${id}l">${esc(tr('pair.lead'))}</label>
      <div class="wz-inline days"><input class="homey-form-input" type="number" inputmode="numeric" min="0" id="${id}l" data-f="leadDays" value="${tk.leadDays}" /><span>${esc(tr('pair.lead_days'))}</span></div>
      <label class="homey-form-label" for="${id}d">${esc(tr('pair.last'))}</label>
      <select class="homey-form-select" id="${id}d" data-f="last">${lastOpts}</select>
      ${tk.last === 'date' ? `<input class="homey-form-input" style="margin-top:8px" type="date" data-f="lastDate" max="${today}" value="${esc(tk.lastDate)}" />` : ''}`;
  }

  function usageEditor(tk, id) {
    const dev = linked();
    const metric = tk.metric || 'hours';
    const metricOpts = ['hours', 'cycles', 'counter', 'level'].map(m => `<option value="${m}" ${m === metric ? 'selected' : ''}>${esc(tr('usage.metric_' + m))}</option>`).join('');
    let source;
    if (metric === 'level') {
      const caps = dev.capabilities.filter(c => c.type === 'number');
      source = `<label class="homey-form-label" for="${id}c">${esc(tr('usage.level_cap'))}</label>
        <select class="homey-form-select" id="${id}c" data-f="srcCap">${caps.map(c => `<option value="${esc(c.id)}" ${c.id === tk.srcCap ? 'selected' : ''}>${esc(c.title)}${c.units ? ` (${esc(c.units)})` : ''} · ${esc(c.value ?? '–')}</option>`).join('')}</select>
        <label class="homey-form-label" for="${id}r">${esc(tr('usage.level_direction'))}</label>
        <select class="homey-form-select" id="${id}r" data-f="direction">${['down', 'up'].map(v => `<option value="${v}" ${v === (tk.direction || 'down') ? 'selected' : ''}>${esc(tr('usage.dir_' + v))}</option>`).join('')}</select>`;
    } else if (metric === 'counter') {
      const caps = dev.capabilities.filter(c => c.type === 'number');
      source = `<label class="homey-form-label" for="${id}c">${esc(tr('usage.counter_cap'))}</label>
        <select class="homey-form-select" id="${id}c" data-f="srcCap">${caps.map(c => `<option value="${esc(c.id)}" ${c.id === tk.srcCap ? 'selected' : ''}>${esc(c.title)}${c.units ? ` (${esc(c.units)})` : ''} · ${esc(c.value ?? '–')}</option>`).join('')}</select>`;
    } else {
      const caps = dev.capabilities.filter(c => ['boolean', 'number', 'enum', 'string'].includes(c.type));
      const cap = capOf(dev, tk.srcCap) || caps[0];
      let cond = '';
      if (cap && cap.type === 'number') {
        cond = `<div class="wz-inline days" style="margin-top:8px"><span>${esc(tr('usage.greater_than'))}</span><input class="homey-form-input" type="number" inputmode="decimal" data-f="cmpValue" value="${esc(tk.cmpValue ?? 10)}" style="width:90px" /><span>${esc(cap.units || '')}</span></div>`;
      } else if (cap && (cap.type === 'enum' || cap.type === 'string')) {
        const values = cap.values || (cap.value !== null && cap.value !== undefined ? [{ id: String(cap.value), title: String(cap.value) }] : []);
        cond = values.length && cap.type === 'enum'
          ? `<select class="homey-form-select" style="margin-top:8px" data-f="cmpValue"><option value="">${esc(tr('usage.equals'))}…</option>${values.map(v => `<option value="${esc(v.id)}" ${String(v.id) === String(tk.cmpValue) ? 'selected' : ''}>${esc(tr('usage.equals'))} ${esc(v.title)}</option>`).join('')}</select>`
          : `<input class="homey-form-input" style="margin-top:8px" type="text" data-f="cmpValue" placeholder="${esc(tr('usage.equals'))}…" value="${esc(tk.cmpValue ?? '')}" />`;
      }
      source = `<label class="homey-form-label" for="${id}c">${esc(tr('usage.running_when'))}</label>
        <select class="homey-form-select" id="${id}c" data-f="srcCap">${caps.map(c => `<option value="${esc(c.id)}" ${cap && c.id === cap.id ? 'selected' : ''}>${esc(c.title)}${c.type === 'boolean' ? ` ${esc(tr('usage.is_on'))}` : ''}</option>`).join('')}</select>
        ${cond}
        <label class="homey-form-label" for="${id}o">${esc(tr('usage.off_delay'))}</label>
        <div class="wz-inline days"><input class="homey-form-input" type="number" inputmode="numeric" min="0" id="${id}o" data-f="offDelayMin" value="${tk.offDelayMin ?? 3}" /><span>${esc(tr('usage.minutes'))}</span></div>
        ${metric === 'cycles' ? `<label class="homey-form-label" for="${id}m">${esc(tr('usage.min_run'))}</label>
        <div class="wz-inline days"><input class="homey-form-input" type="number" inputmode="numeric" min="0" id="${id}m" data-f="minRunMin" value="${tk.minRunMin ?? 1}" /><span>${esc(tr('usage.minutes'))}</span></div>` : ''}`;
    }
    return `<label class="homey-form-label" for="${id}w">${esc(tr('usage.metric'))}</label>
      <select class="homey-form-select" id="${id}w" data-f="metric">${metricOpts}</select>
      ${source}
      ${describeSource(tk) ? `<p class="wz-hint" style="margin-top:8px">${esc(describeSource(tk))}${tk.auto ? ` · ${esc(tr('usage.auto'))}` : ''}</p>` : ''}
      <label class="homey-form-label" for="${id}t">${esc(tr(metric === 'level' ? 'usage.level_threshold' : 'usage.threshold'))}</label>
      <div class="wz-inline days"><input class="homey-form-input" type="number" inputmode="decimal" min="0" id="${id}t" data-f="threshold" value="${tk.threshold}" style="width:110px" /><span>${esc(unitLabel(tk))}</span></div>
      <label class="homey-form-label" for="${id}p">${esc(tr('usage.lead_percent'))}</label>
      <div class="wz-inline days"><input class="homey-form-input" type="number" inputmode="numeric" min="0" max="100" id="${id}p" data-f="leadPercent" value="${tk.leadPercent}" /><span>%</span></div>
      <label class="homey-form-checkbox" style="margin-top:14px"><input class="homey-form-checkbox-input" type="checkbox" data-f="combine" ${tk.combine ? 'checked' : ''} />
        <span class="homey-form-checkbox-checkmark"></span><span class="homey-form-checkbox-text">${esc(tr('usage.also_date'))}</span></label>
      ${tk.combine ? dateFields(tk, id) : ''}`;
  }

  function renderTasks() { $('tasks').innerHTML = tasks.map(taskCard).join(''); }

  function renderSummary() {
    const chosen = tasks.filter(tk => tk.use && String(tk.name).trim());
    const inst = installDate();
    let html = `<div class="wz-card"><div class="wz-head"><span class="wz-icon" style="--icon:url('${cat.iconUri}');"></span><div><div class="name">${esc($('name').value)}</div>
      <div class="wz-step">${esc(tr('pair.install'))}: ${inst ? esc(fmt(inst, { month: 'long', year: 'numeric' })) : esc(tr('pair.unknown').toLowerCase())}</div></div></div>`;
    if (!chosen.length) html += `<div class="wz-line"><span class="s">${esc(tr('pair.no_tasks_selected'))}</span></div>`;
    html += chosen.map(tk => {
      let due;
      if (tk.type === 'counter' || tk.type === 'usage') {
        due = `<b>${esc(tk.metric === 'level' && tk.type === 'usage' ? tr('usage.level_at') : tr('usage.threshold'))} ${tk.threshold} ${esc(tk.type === 'usage' ? unitLabel(tk) : '')}</b>`;
        if (tk.type === 'usage' && tk.combine) due += `<b>${esc(tr('usage.or_date').split(' ')[0])} ${esc(fmt(addInterval(lastDoneOf(tk), Number(tk.every) || 1, tk.unit)))}</b>`;
      }
      else {
        const d = addInterval(lastDoneOf(tk), Number(tk.every) || 1, tk.unit);
        due = d <= today ? `<b class="now">${esc(tr('pair.now'))}</b>` : `<b>${esc(fmt(d))}</b>`;
      }
      const sub = tk.type === 'counter' ? tr('pair.kind_counter') : tk.type === 'usage' ? summaryOf(tk) : everyText(tk.every, tk.unit);
      return `<div class="wz-line"><div><div class="t">${esc(tk.name)}</div><div class="s">${esc(sub)}</div></div>
        <div class="r">${esc(tr('pair.first_due'))}${due}</div></div>`;
    }).join('');
    $('summary').innerHTML = `${html}</div>`;
  }

  // ---- actions ----
  function pickCategory(id) {
    if (!cat || cat.id !== id) {
      cat = templates.find(c => c.id === id);
      $('name').value = cat.name;
      tasks = cat.tasks.map(tk => ({
        ...tk, use: true, open: false, threshold: 100, leadPercent: 10, last: tk.basis === 'install' ? 'install' : 'today', lastDate: today,
      }));
    }
    renderCats();
    step = 2;
    show();
  }

  async function finish() {
    const chosen = tasks.filter(tk => tk.use && String(tk.name).trim()).map(tk => ({
      key: tk.custom ? null : tk.key,
      name: String(tk.name).trim(),
      type: tk.type,
      basis: tk.basis === 'install' ? 'install' : 'last',
      every: Math.max(1, Number(tk.every) || 1),
      unit: tk.unit,
      leadDays: Math.max(0, Number(tk.leadDays) || 0),
      threshold: Math.max(0.01, Number(tk.threshold) || 100),
      leadPercent: Number(tk.leadPercent) || 10,
      lastDone: lastDoneOf(tk),
      combine: tk.type === 'usage' ? Boolean(tk.combine) : false,
      source: tk.type === 'usage' ? {
        capability: tk.srcCap,
        metric: tk.metric || 'hours',
        condition: { op: tk.op || 'true', value: tk.cmpValue },
        offDelayMin: Number(tk.offDelayMin ?? 3),
        minRunMin: Number(tk.minRunMin ?? 1),
        units: unitLabel(tk),
        direction: tk.direction || 'down',
      } : null,
      autoDone: MM.autoDoneFor(linked(), tk),
    })).filter(tk => tk.type !== 'usage' || tk.source.capability);
    $('next').classList.add('is-loading');
    try {
      const res = await deps.api('POST', '/items', {
        name: $('name').value, category: cat.id, installDate: installDate(), tasks: chosen,
        link: linked() ? { id: linked().id, name: linked().name } : null,
      });
      deps.onDone(res.items);
    } catch (err) {
      deps.alert(err.message || String(err));
      $('next').classList.remove('is-loading');
    }
  }

  // ---- events ----
  $('cats').addEventListener('click', ev => {
    const tile = ev.target.closest('.wz-tile');
    if (tile) pickCategory(tile.dataset.id);
  });
  $('tasks').addEventListener('input', ev => {
    const card = ev.target.closest('.wz-task');
    const f = ev.target.dataset.f;
    if (!card || !f || ev.target.type === 'checkbox' || ev.target.tagName === 'SELECT') return;
    const tk = tasks[Number(card.dataset.i)];
    tk[f] = ev.target.value; // typing: keep focus, update the summary line only
    card.querySelector('.wz-sum').textContent = summaryOf(tk);
    if (f === 'name') card.querySelector('.homey-form-checkbox-text').textContent = tk.name || tr('pair.custom_name');
  });
  $('tasks').addEventListener('change', ev => {
    const card = ev.target.closest('.wz-task');
    const f = ev.target.dataset.f;
    if (!card || !f) return;
    const tk = tasks[Number(card.dataset.i)];
    tk[f] = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
    if (f === 'type' && tk.type === 'usage') Object.assign(tk, { combine: tk.combine ?? true, threshold: (tk.usage && tk.usage.threshold) || tk.threshold }, tk.srcCap ? {} : autoSource(linked(), tk));
    if (f === 'metric') {
      Object.assign(tk, tk.metric === 'level' ? MM.levelSource(linked(), tk.level)
        : autoSource(linked(), { metric: tk.metric, usage: tk.usage && { ...tk.usage, metric: tk.metric } }));
    }
    if (['srcCap', 'cmpValue'].includes(f)) tk.auto = false;
    if (f === 'srcCap' && tk.metric !== 'level') { const c = capOf(linked(), tk.srcCap); tk.op = !c || c.type === 'boolean' ? 'true' : c.type === 'number' ? 'gt' : 'equals'; tk.cmpValue = tk.op === 'gt' ? 10 : ''; }
    if (['use', 'type', 'last', 'unit', 'lastDate', 'metric', 'srcCap', 'combine'].includes(f)) renderTasks();
  });
  $('tasks').addEventListener('click', ev => {
    const open = ev.target.closest('[data-open]');
    const remove = ev.target.closest('[data-remove]');
    if (open) { tasks[Number(open.dataset.open)].open = true; renderTasks(); }
    if (remove) { tasks.splice(Number(remove.dataset.remove), 1); renderTasks(); }
  });
  $('addCustom').addEventListener('click', () => {
    tasks.push({
      custom: true, use: true, open: true, key: null, name: '', type: 'date', every: 3, unit: 'months', leadDays: 7,
      threshold: 100, leadPercent: 10, basis: 'last', last: 'today', lastDate: today,
    });
    renderTasks();
  });
  $('link').addEventListener('change', () => applyLink());
  $('back').addEventListener('click', () => {
    if (step === 1) { deps.onCancel(); return; }
    step -= 1;
    show();
  });
  $('next').addEventListener('click', () => {
    if (step === 2 && !$('name').value.trim()) { deps.alert(tr('errors.name_required')); return; }
    if (step === 4) { finish(); return; }
    step += 1;
    show();
  });

  (async () => {
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });
    $('name').placeholder = tr('pair.name_placeholder');
    const thisYear = now.getFullYear();
    $('year').innerHTML = `<option value="">${esc(tr('pair.year'))}</option>`
      + Array.from({ length: 50 }, (_, k) => thisYear - k).map(y => `<option value="${y}">${y}</option>`).join('');
    $('month').innerHTML = `<option value="">${esc(tr('pair.month'))}</option>`
      + Array.from({ length: 12 }, (_, k) => `<option value="${pad(k + 1)}">${esc(new Date(2026, k, 1).toLocaleDateString(undefined, { month: 'long' }))}</option>`).join('');
    $('link').innerHTML = `<option value="">${esc(tr('usage.link_loading'))}</option>`;
    deps.api('GET', '/homey-devices').then(list => {
      homeyDevices = list;
      $('link').innerHTML = `<option value="">${esc(tr('usage.link_none'))}</option>`
        + list.map(d => `<option value="${esc(d.id)}">${esc(d.name)}${d.zone ? ` · ${esc(d.zone)}` : ''}</option>`).join('');
    }).catch(() => { $('link').innerHTML = `<option value="">${esc(tr('usage.link_none'))}</option>`; });
    templates = await deps.api('GET', '/templates');
    renderCats();
    show();
  })();

}
