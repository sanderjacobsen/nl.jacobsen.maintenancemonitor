'use strict';

const fs = require('fs');
const path = require('path');

// Categories with suggested tasks. Intervals are sensible defaults; the user can change everything.
// t(en, nl) keeps the list readable.
const t = (en, nl) => ({ en, nl });
const task = (key, name, every, unit, leadDays = 7, basis = 'last') => ({
  key, name, type: 'date', every, unit, leadDays, basis,
});

const CATEGORIES = [
  {
    id: 'smoke_detector', icon: 'smoke_detector', name: t('Smoke detector', 'Rookmelder'),
    tasks: [task('test', t('Test', 'Testen'), 1, 'years', 14), task('replace', t('Replace', 'Vervangen'), 10, 'years', 60, 'install')],
  },
  {
    id: 'co_detector', icon: 'co_detector', name: t('CO detector', 'CO-melder'),
    tasks: [task('test', t('Test', 'Testen'), 1, 'years', 14), task('replace', t('Replace', 'Vervangen'), 7, 'years', 60, 'install')],
  },
  {
    id: 'washing_machine', icon: 'washing_machine', name: t('Washing machine', 'Wasmachine'),
    tasks: [
      task('drum', t('Clean drum (hot cleaning program)', 'Trommelreiniging (heet programma)'), 2, 'months'),
      task('pump_filter', t('Clean pump filter', 'Pompfilter schoonmaken'), 3, 'months'),
      task('detergent_drawer', t('Clean detergent drawer', 'Zeepbakje schoonmaken'), 1, 'months', 3),
    ],
  },
  {
    id: 'dryer', icon: 'dryer', name: t('Tumble dryer', 'Droger'),
    tasks: [task('condenser', t('Clean condenser and lint filter', 'Condensor en pluizenfilter schoonmaken'), 1, 'months', 3)],
  },
  {
    id: 'dishwasher', icon: 'dishwasher', name: t('Dishwasher', 'Vaatwasser'),
    tasks: [task('filter', t('Clean filter', 'Filter schoonmaken'), 1, 'months', 3), task('descale', t('Cleaning program', 'Reinigingsprogramma'), 3, 'months')],
  },
  {
    id: 'extractor', icon: 'extractor', name: t('Extractor', 'Afzuiging'),
    tasks: [task('clean', t('Clean vent / filter', 'Ventiel / filter schoonmaken'), 6, 'months', 14)],
  },
  {
    id: 'cooker_hood', icon: 'cooker_hood', name: t('Cooker hood', 'Afzuigkap'),
    tasks: [task('grease', t('Clean grease filter', 'Vetfilter schoonmaken'), 3, 'months'), task('carbon', t('Replace carbon filter', 'Koolstoffilter vervangen'), 1, 'years', 14)],
  },
  {
    id: 'ventilation', icon: 'ventilation', name: t('Mechanical ventilation', 'Mechanische ventilatie'),
    tasks: [task('vents', t('Clean vents', 'Ventielen schoonmaken'), 6, 'months', 14), task('unit', t('Clean unit / replace filter', 'Unit schoonmaken / filter vervangen'), 1, 'years', 14)],
  },
  {
    id: 'air_conditioner', icon: 'air_conditioner', name: t('Air conditioner', 'Airco'),
    tasks: [task('filters', t('Clean filters', 'Filters schoonmaken'), 3, 'months'), task('service', t('Professional service', 'Onderhoud door installateur'), 2, 'years', 30)],
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
      task('lubricate', t('Lubricate rods / rails', 'Geleiders smeren'), 3, 'months'),
      task('nozzle', t('Check nozzle and print sheet', 'Spuitmond en printplaat controleren'), 3, 'months'),
    ],
  },
  {
    id: 'robot_vacuum', icon: 'robot_vacuum', name: t('Robot vacuum', 'Robotstofzuiger'),
    tasks: [
      task('filter', t('Replace filter', 'Filter vervangen'), 3, 'months'),
      task('brushes', t('Clean brushes', 'Borstels schoonmaken'), 1, 'months', 3),
      task('sensors', t('Clean sensors', 'Sensoren schoonmaken'), 1, 'months', 3),
    ],
  },
  {
    id: 'coffee_machine', icon: 'coffee_machine', name: t('Coffee machine', 'Koffiezetapparaat'),
    tasks: [task('descale', t('Descale', 'Ontkalken'), 2, 'months')],
  },
  {
    id: 'litter_box', icon: 'litter_box', name: t('Litter box', 'Kattenbak'),
    tasks: [task('carbon', t('Replace carbon filter', 'Koolstoffilter vervangen'), 3, 'months'), task('deep_clean', t('Deep clean', 'Grote schoonmaak'), 3, 'months')],
  },
  {
    id: 'pet_fountain', icon: 'pet_fountain', name: t('Pet fountain', 'Drinkfontein'),
    tasks: [task('filter', t('Replace filter', 'Filter vervangen'), 1, 'months', 3)],
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

const ICON_DIR = path.join(__dirname, '..', 'drivers', 'maintenance_item', 'assets', 'icons');
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
