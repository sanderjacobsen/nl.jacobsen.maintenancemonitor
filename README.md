[![Ko-fi](https://img.shields.io/badge/Buy%20me%20a%20coffee-Ko--fi-FF5E5B?style=flat&logo=ko-fi&logoColor=white)](https://ko-fi.com/sanderjacobsen)

# Maintenance Monitor — Homey App

Keep track of **all maintenance in and around your home** — and let Homey tell you when it's time.

Test the smoke detectors, clean the air conditioner filters, give the washing machine a hot cleaning programme, service the boiler, lubricate the 3D printer, clean the gutters: add your items once and Homey reminds you. Tasks can be **date based** or based on **measured usage** of a linked Homey device.

---

## Features

- **All maintenance in one place** — 25 item types with suggested tasks and intervals
- **By date or by usage** — every X days/weeks/months/years, or count running hours, the number of runs or a device counter of a linked Homey device; combine both ("after 30 washes or 2 months, whichever comes first")
- **Notifications** when a task is due soon, due or overdue — each step exactly once
- **One overview device** with a red dot when something needs attention — your appliances don't appear twice in your device list
- **Dashboard widget** with a *Done* button
- **Flow cards** to automate everything yourself
- **Wizard** to add items, in Homey's own look and feel
- Dutch and English

---

## Item types

Smoke detector · CO detector · Washing machine · Tumble dryer · Dishwasher · Extractor · Cooker hood · Mechanical ventilation · Air conditioner · Fan · Boiler / heat pump · Floor heating · 3D printer · Robot vacuum · Coffee machine · Litter box · Pet fountain · Pet feeder · Chicken coop · Camera / doorbell · Solar panels · Car · Water softener · House · Other

Every type comes with suggested tasks (for example *Smoke detector: test every year, replace after 10 years*). All tasks and intervals can be changed, and you can add your own.

---

## Installation

### Via Homey App Store
The app is currently in **test**. Install the test version via:
**https://homey.app/a/nl.jacobsen.maintenancemonitor/test/**

Requires Homey Pro (2023 or later), Homey Pro mini or Homey Self-Hosted Server, firmware 12.2.0 or newer.

### Manual / Development
```bash
npm install -g homey
npm install
homey app run       # Test on Homey
homey app install   # Install on Homey
npm test            # Unit tests for the date and usage logic
```

---

## Getting started

1. Open **Homey → Settings → Apps → Maintenance Monitor → Configure**
2. Tap **+ Add item**, choose the type, name and (optionally) the installation year and a Homey device to link
3. Check the suggested tasks and adjust the intervals — the overview shows when each task is first due
4. Optional: add the **Maintenance Monitor (overview)** device and the **Maintenance** widget to your dashboard

---

## Task types

| Type | How it works | Example |
|---|---|---|
| **By date** | Every X days/weeks/months/years since it was last done (or since installation) | Test smoke detector every year |
| **Counter** | A counter you increase with a Flow card | Robot vacuum: +40 per cleaning, due at 9000 |
| **By usage** | Measured from a linked Homey device | See below |

### Usage tracking (linked device)

| What to count | When does the device count as running? | Example |
|---|---|---|
| **Running hours** | A boolean capability is on, a number is above a threshold (e.g. power > 40 W), or a status equals a value | 3D printer: lubricate rods after 200 printing hours |
| **Number of runs** | Same, with *off-delay* (pauses don't count as a new run) and a minimum run time | Washing machine: clean drum after 30 washes (status = *In use*) |
| **Device counter** | Increase of a cumulative capability (kWh, cycles, …); resets of the device counter are handled | Litter-Robot: deep clean after 250 clean cycles |

Usage tasks can be combined with a date: **whichever comes first**.

---

## Overview device

| Capability | Description |
|---|---|
| Maintenance needed | Yes when a task is due or overdue (red dot on the tile) |
| Open tasks | Number of tasks that are due or overdue |
| Days until next task | Days until the next date-based task |
| Next item | Item of the most urgent task |
| Next task | Name of the most urgent task |

---

## Flow Cards

### Triggers
- **A task of [item] is due soon** — tokens: item, task, days
- **A task of [item] is due**
- **A task of [item] is overdue**

*[item]* can be a specific item or *All items*.

### Conditions
- **[item] has / has no open tasks**
- **[task] is / is not due within [days] days**

### Actions
- **Mark [task] as done**
- **Mark all open tasks of [item] as done**
- **Postpone [task] by [days] days**
- **Increase counter of [task] by [amount]**

### Example flow
```
WHEN  A task of [All items] is due
THEN  Send push notification: "Maintenance: [task] of [item]"
```

---

## Notifications

Maintenance Monitor writes to the Homey timeline when a task becomes *due soon*, *due* or *overdue* — every step only once. Push notifications can be enabled in **Homey → Settings → Notifications → Maintenance Monitor**. Each step can be switched off in the app settings, and you choose after how many days a task counts as *overdue*.

---

## Technical Details

- Items and tasks are stored in the app settings; no cloud service is used
- Linked devices are followed with the Homey Web API (`homey:manager:api` permission) via capability listeners; usage is saved immediately on start/stop and at most every 10 minutes while running
- Status is evaluated every hour and on every change
- Backup and restore of all items as JSON in the app settings

---

## Support

Questions, ideas or bugs? Reply in the [Homey Community topic](https://community.homey.app/t/app-pro-maintenance-monitor-keep-track-of-all-maintenance-in-and-around-your-home/161164) or open an [issue](https://github.com/sanderjacobsen/nl.jacobsen.maintenancemonitor/issues).

---

## Credits

Device pictograms: Athom (Homey), Sure Petcare (Felaqua Connect, SureFeed), Whisker (Litter-Robot 4) and Omlet (Autodoor) Homey apps; water softener pictogram from the AquaCell app.

---

## License

MIT
