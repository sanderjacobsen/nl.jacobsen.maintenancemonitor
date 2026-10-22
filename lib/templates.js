'use strict';

const fs = require('fs');
const path = require('path');

// Categories with suggested tasks. Intervals follow manufacturer / official advice where there is one
// (sources in the comments); the user can change everything.
// t(en, nl) keeps the list readable.
const t = (en, nl) => ({ en, nl });
const task = (key, name, every, unit, leadDays = 7, basis = 'last') => ({
  key, name, type: 'date', every, unit, leadDays, basis,
});
// Suggestion for when the item is linked to a Homey device: count usage, combined with the date ("whichever comes first").
// watts = power level above which the device counts as running (when it reports measure_power).
const withUsage = (tk, metric, threshold, watts = 10) => ({ ...tk, usage: { metric, threshold, watts } });

const CATEGORIES = [
  {
    id: 'smoke_detector', icon: 'smoke_detector', name: t('Smoke detector', 'Rookmelder'),
    // Fire services (brandweer.nl): test monthly, replace after 10 years.
    tasks: [task('test', t('Test', 'Testen'), 1, 'months', 3), task('replace', t('Replace', 'Vervangen'), 10, 'years', 60, 'install')],
  },
  {
    id: 'co_detector', icon: 'co_detector', name: t('CO detector', 'CO-melder'),
    // Test monthly like a smoke detector; lifetime 5–10 years depending on the sensor (see label).
    tasks: [task('test', t('Test', 'Testen'), 1, 'months', 3), task('replace', t('Replace', 'Vervangen'), 7, 'years', 60, 'install')],
  },
  {
    id: 'washing_machine', icon: 'washing_machine', name: t('Washing machine', 'Wasmachine'),
    tasks: [
      // Miele: run Cottons 90 °C with machine cleaner when there has been no wash above 60 °C for a while; usual advice monthly.
      withUsage(task('drum', t('Clean drum (hot cleaning program)', 'Trommelreiniging (heet programma)'), 1, 'months', 3), 'cycles', 30),
      task('pump_filter', t('Clean pump filter', 'Pompfilter schoonmaken'), 3, 'months'),
      task('detergent_drawer', t('Clean detergent drawer and door seal', 'Zeepbakje en deurrubber schoonmaken'), 1, 'months', 3),
    ],
  },
  {
    id: 'dryer', icon: 'dryer', name: t('Tumble dryer', 'Droger'),
    tasks: [withUsage(task('condenser', t('Clean condenser and lint filter', 'Condensor en pluizenfilter schoonmaken'), 1, 'months', 3), 'cycles', 20)],
  },
  {
    id: 'dishwasher', icon: 'dishwasher', name: t('Dishwasher', 'Vaatwasser'),
    tasks: [withUsage(task('filter', t('Clean filter', 'Filter schoonmaken'), 1, 'months', 3), 'cycles', 30), task('descale', t('Cleaning program', 'Reinigingsprogramma'), 3, 'months')],
  },
  {
    id: 'extractor', icon: 'extractor', name: t('Extractor', 'Afzuiging'),
    tasks: [withUsage(task('clean', t('Clean vent / filter', 'Ventiel / filter schoonmaken'), 6, 'months', 14), 'hours', 500, 5)],
  },
  {
    id: 'cooker_hood', icon: 'cooker_hood', name: t('Cooker hood', 'Afzuigkap'),
    // Siemens: grease filter every 2 months; Bosch: carbon filter lasts 6–12 months (recirculation only).
    tasks: [task('grease', t('Clean grease filter', 'Vetfilter schoonmaken'), 2, 'months'), task('carbon', t('Replace carbon filter', 'Koolstoffilter vervangen'), 6, 'months', 14)],
  },
  {
    id: 'ventilation', icon: 'ventilation', name: t('Mechanical ventilation', 'Mechanische ventilatie'),
    // Usual advice: replace filters every 6 months, clean vents yearly, have the ducts cleaned every 4 years.
    tasks: [
      task('unit', t('Replace filter / clean unit', 'Filter vervangen / unit schoonmaken'), 6, 'months', 14),
      task('vents', t('Clean vents', 'Ventielen schoonmaken'), 1, 'years', 14),
      task('ducts', t('Have ducts cleaned', 'Kanalen laten reinigen'), 4, 'years', 30),
    ],
  },
  {
    id: 'air_conditioner', icon: 'air_conditioner', name: t('Air conditioner', 'Airco'),
    // Daikin: clean the indoor unit filters every two weeks of use.
    tasks: [withUsage(task('filters', t('Clean filters', 'Filters schoonmaken'), 1, 'months', 3), 'hours', 150, 50), task('service', t('Professional service', 'Onderhoud door installateur'), 2, 'years', 30)],
  },
  {
    id: 'fan', icon: 'fan', name: t('Fan', 'Ventilator'),
    tasks: [task('clean', t('Clean', 'Schoonmaken'), 6, 'months', 14)],
  },
  {
    id: 'heating', icon: 'heating', name: t('Boiler / heat pump', 'CV-ketel / warmtepomp'),
    tasks: [
      task('service', t('Annual service', 'Onderhoudsbeurt'), 1, 'years', 28),
      task('system_filter', t('Clean system filter', 'Systeemfilter schoonmaken'), 1, 'years', 14),
      task('pressure', t('Check water pressure', 'Waterdruk controleren'), 3, 'months', 3),
    ],
  },
  {
    id: 'floor_heating', icon: 'floor_heating', name: t('Floor heating', 'Vloerverwarming'),
    tasks: [task('bleed', t('Bleed and check pressure', 'Ontluchten en druk controleren'), 1, 'years', 14)],
  },
  {
    id: 'printer_3d', icon: 'printer_3d', name: t('3D printer', '3D-printer'),
    tasks: [
      withUsage(task('lubricate', t('Lubricate rods / rails', 'Geleiders smeren'), 3, 'months'), 'hours', 200, 40),
      task('nozzle', t('Check nozzle and print sheet', 'Spuitmond en printplaat controleren'), 3, 'months'),
    ],
  },
  {
    id: 'robot_vacuum', icon: 'robot_vacuum', name: t('Robot vacuum', 'Robotstofzuiger'),
    tasks: [
      // Roborock / Dreame manuals and apps: main brush 300 h (6–12 months), side brush 200 h (3–6 months),
      // filter 150 h, sensors 30 h; clean brushes and wheels every 2 weeks, mop pad 3–6 months.
      withUsage(task('main_brush', t('Replace main brush', 'Hoofdborstel vervangen'), 12, 'months', 14), 'hours', 300),
      withUsage(task('side_brush', t('Replace side brush', 'Zijborstel vervangen'), 6, 'months', 14), 'hours', 200),
      withUsage(task('filter', t('Replace filter', 'Filter vervangen'), 6, 'months', 14), 'hours', 150),
      withUsage(task('sensors', t('Clean sensors', 'Sensoren schoonmaken'), 1, 'months', 3), 'hours', 30),
      task('brushes', t('Clean brushes and wheels', 'Borstels en wielen schoonmaken'), 2, 'weeks', 2),
      task('mop', t('Replace mop pad', 'Moppad vervangen'), 3, 'months', 14),
    ],
  },
  {
    id: 'coffee_machine', icon: 'coffee_machine', name: t('Coffee machine', 'Koffiezetapparaat'),
    tasks: [withUsage(task('descale', t('Descale', 'Ontkalken'), 2, 'months'), 'cycles', 300, 100)],
  },
  {
    id: 'litter_box', icon: 'litter_box', name: t('Litter box', 'Kattenbak'),
    // Whisker (Litter-Robot): carbon filter monthly, clean the globe every 6 weeks, deep clean every 3 months.
    tasks: [
      task('carbon', t('Replace carbon filter', 'Koolstoffilter vervangen'), 1, 'months', 3),
      withUsage(task('globe', t('Clean globe', 'Bol schoonmaken'), 6, 'weeks', 3), 'cycles', 150),
      withUsage(task('deep_clean', t('Deep clean', 'Grote schoonmaak'), 3, 'months'), 'cycles', 250),
    ],
  },
  {
    id: 'pet_fountain', icon: 'pet_fountain', name: t('Pet fountain', 'Drinkfontein'),
    // Usual advice for fountains with a pump: replace the filter every 2–4 weeks, clean fountain and pump every 2 weeks.
    tasks: [task('filter', t('Replace filter', 'Filter vervangen'), 1, 'months', 3), task('clean', t('Clean fountain and pump', 'Fontein en pompje schoonmaken'), 2, 'weeks', 2)],
  },
  {
    id: 'pet_feeder', icon: 'pet_feeder', name: t('Pet feeder', 'Voerbak'),
    tasks: [task('clean', t('Clean', 'Schoonmaken'), 2, 'weeks', 2)],
  },
  {
    id: 'chicken_coop', icon: 'chicken_coop', name: t('Chicken coop', 'Kippenhok'),
    tasks: [task('clean', t('Deep clean', 'Grote schoonmaak'), 3, 'months'), task('door', t('Check door and rails', 'Deur en rails controleren'), 6, 'months', 14)],
  },
  {
    id: 'camera', icon: 'camera', name: t('Camera / doorbell', 'Camera / deurbel'),
    tasks: [task('lens', t('Clean lens', 'Lens schoonmaken'), 6, 'months', 14)],
  },
  {
    id: 'solar', icon: 'solar', name: t('Solar panels', 'Zonnepanelen'),
    tasks: [task('inspect', t('Inspect / clean', 'Inspecteren / schoonmaken'), 1, 'years', 14)],
  },
  {
    id: 'car', icon: 'car', name: t('Car', 'Auto'),
    tasks: [task('service', t('Service / inspection', 'Onderhoud / APK'), 1, 'years', 28), task('tyres', t('Change tyres', 'Banden wisselen'), 6, 'months', 14)],
  },
  {
    id: 'water_softener', icon: 'water_softener', name: t('Water softener', 'Waterontharder'),
    tasks: [task('service', t('Annual maintenance', 'Jaarlijks onderhoud'), 1, 'years', 14)],
  },
  {
    id: 'house', icon: 'house', name: t('House', 'Huis'),
    tasks: [
      task('gutters', t('Clean gutters', 'Dakgoot schoonmaken'), 1, 'years', 14),
      task('extinguisher', t('Inspect fire extinguisher', 'Brandblusser keuren'), 1, 'years', 14),
      task('chimney', t('Sweep chimney', 'Schoorsteen vegen'), 1, 'years', 14),
    ],
  },
  { id: 'other', icon: 'other', name: t('Other', 'Overig'), tasks: [] },
];

function localize(value, language) {
  if (value && typeof value === 'object') return value[language] || value.en || '';
  return value || '';
}

function getCategory(id) {
  return CATEGORIES.find(c => c.id === id) || CATEGORIES.find(c => c.id === 'other');
}

const ICON_DIR = path.join(__dirname, '..', 'assets', 'icons');
const iconCache = {};

// Inline SVG of a category icon (for the pairing and settings pages).
function getIconSvg(icon) {
  if (!(icon in iconCache)) {
    try {
      iconCache[icon] = fs.readFileSync(path.join(ICON_DIR, `${icon}.svg`), 'utf8')
        .replace(/<\?xml[^>]*\?>/g, '')
        .replace(/<title>[^<]*<\/title>/g, '')
        .replace(/<svg([^>]*?)\s(width|height)="[^"]*"/g, '<svg$1')
        .replace(/<svg([^>]*?)\s(width|height)="[^"]*"/g, '<svg$1')
        .trim();
    } catch (err) {
      iconCache[icon] = '';
    }
  }
  return iconCache[icon];
}

// Icon as data URI; the pages render it as a CSS mask in one colour, the way Homey shows device icons.
function getIconUri(icon) {
  return `data:image/svg+xml;base64,${Buffer.from(getIconSvg(icon)).toString('base64')}`;
}

// Templates in one language, for the pairing and settings pages.
function getTemplates(language) {
  return CATEGORIES.map(c => ({
    id: c.id,
    icon: c.icon,
    iconUri: getIconUri(c.icon),
    name: localize(c.name, language),
    tasks: c.tasks.map(tk => ({ ...tk, name: localize(tk.name, language) })),
  }));
}

module.exports = {
  CATEGORIES, getCategory, getTemplates, getIconSvg, getIconUri, localize,
};
