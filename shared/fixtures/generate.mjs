/**
 * Generador de fixtures de Loop.
 *
 *   node shared/fixtures/generate.mjs
 *
 * Fuente única: la lista EPISODES de abajo. Todo lo demás se DERIVA de ella:
 * las series de observaciones (con sus spikes en el momento exacto de cada
 * episodio), los agregados de outcomes y el resumen del paciente.
 *
 * Que sea derivado y no tecleado a mano importa: si un juez cruza el gráfico
 * de outcomes con la lista de episodios, los números cuadran.
 *
 * PRNG con semilla fija → salida reproducible. Correr esto dos veces produce
 * bytes idénticos.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ================================================================== */
/* Parámetros del paciente demo                                        */
/* ================================================================== */

const PATIENT_ID = 'loop-demo-patient-001';
const DISPLAY_NAME = 'Alex Rivera';
const AGE = 34;

/** Ventana de baseline: 30 días hasta "hoy" en el mundo del demo. */
const WINDOW_START = new Date('2026-07-02T00:00:00Z');
const WINDOW_END = new Date('2026-08-01T00:00:00Z');

const BASELINE = {
  heartRate: { mean: 68, sd: 6, unit: 'bpm' },
  hrv: { mean: 54, sd: 11, unit: 'ms' },
  respiratoryRate: { mean: 14, sd: 2, unit: 'breaths/min' },
  sleepHours: { mean: 6.8, sd: 1.1, unit: 'h' },
};

const ACTIVITY_TITLES = {
  'cp-act-1': 'Box breathing',
  'cp-act-2': '5-4-3-2-1 grounding',
  'cp-act-3': 'Message care team',
};

/* ================================================================== */
/* FUENTE DE VERDAD — los 12 episodios                                 */
/* ================================================================== */

/**
 * Tendencia deliberada: la frecuencia de episodios baja de 3/semana a
 * 2/semana, y los episodios con box breathing son consistentemente más
 * cortos que los que usan grounding o los que no tienen intervención.
 * Esa es la señal que el gráfico de outcomes tiene que mostrar.
 */
const EPISODES = [
  { id: 'enc-0001', start: '2026-07-02T21:50:00Z', min: 33, act: null,        relief: null, peakHr: 118, minHrv: 22, sev: 8 },
  { id: 'enc-0002', start: '2026-07-03T07:20:00Z', min: 29, act: 'cp-act-2',  relief: 3,    peakHr: 121, minHrv: 20, sev: 7 },
  { id: 'enc-0003', start: '2026-07-05T23:40:00Z', min: 31, act: null,        relief: null, peakHr: 123, minHrv: 19, sev: 8 },
  { id: 'enc-0004', start: '2026-07-07T14:15:00Z', min: 16, act: 'cp-act-1',  relief: 6,    peakHr: 117, minHrv: 23, sev: 7 },
  { id: 'enc-0005', start: '2026-07-09T02:05:00Z', min: 27, act: 'cp-act-2',  relief: 4,    peakHr: 120, minHrv: 21, sev: 7 },
  { id: 'enc-0006', start: '2026-07-11T19:30:00Z', min: 15, act: 'cp-act-1',  relief: 6,    peakHr: 115, minHrv: 24, sev: 6 },
  { id: 'enc-0007', start: '2026-07-15T09:35:00Z', min: 13, act: 'cp-act-1',  relief: 7,    peakHr: 112, minHrv: 26, sev: 5 },
  { id: 'enc-0008', start: '2026-07-18T22:10:00Z', min: 24, act: 'cp-act-2',  relief: 2,    peakHr: 122, minHrv: 18, sev: 7 },
  { id: 'enc-0009', start: '2026-07-22T16:45:00Z', min: 12, act: 'cp-act-1',  relief: 7,    peakHr: 114, minHrv: 25, sev: 6 },
  { id: 'enc-0010', start: '2026-07-25T03:20:00Z', min: 29, act: null,        relief: null, peakHr: 124, minHrv: 17, sev: 8 },
  { id: 'enc-0011', start: '2026-07-28T02:14:00Z', min: 14, act: 'cp-act-1',  relief: 6,    peakHr: 121, minHrv: 22, sev: 7 },
  { id: 'enc-0012', start: '2026-07-31T20:05:00Z', min: 24, act: 'cp-act-2',  relief: 3,    peakHr: 119, minHrv: 20, sev: 6 },
];

/* ================================================================== */
/* PRNG con semilla (mulberry32) + gaussiana Box-Muller                */
/* ================================================================== */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGaussian(rand) {
  let spare = null;
  return function gaussian(mean, sd) {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return mean + sd * v;
    }
    let u, v, s;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return mean + sd * (u * mul);
  };
}

const rand = mulberry32(0x10029);
const gauss = makeGaussian(rand);

/* ================================================================== */
/* Modelo circadiano                                                   */
/* ================================================================== */

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** Hora decimal UTC (0–24). */
function hourOf(date) {
  return date.getUTCHours() + date.getUTCMinutes() / 60;
}

/**
 * Ritmo circadiano normalizado: -1 a las 4am (mínimo), +1 a las 4pm (máximo).
 * Es lo que hace que la curva de 30 días se vea humana y no como ruido.
 */
function circadian(date) {
  return Math.cos((2 * Math.PI * (hourOf(date) - 16)) / 24);
}

/** ¿Está durmiendo? Aproximación: 23:00–07:00 UTC. */
function isAsleep(date) {
  const h = hourOf(date);
  return h >= 23 || h < 7;
}

/* ================================================================== */
/* Influencia de los episodios sobre las series                        */
/* ================================================================== */

const EPISODE_WINDOWS = EPISODES.map((e) => {
  const start = new Date(e.start).getTime();
  return { ...e, startMs: start, endMs: start + e.min * MIN_MS };
});

/**
 * Intensidad del episodio en un instante dado.
 *
 * Perfil de un ataque de pánico: escalada rápida (~2 min), meseta cerca del
 * pico durante la primera mitad, y decaimiento gradual. Se extiende 10 min
 * más allá del cierre — la recuperación fisiológica es más lenta que la
 * subjetiva, y ese "cola" es justo lo que hace creíble la curva.
 */
function episodeIntensity(tMs) {
  for (const e of EPISODE_WINDOWS) {
    const tail = e.endMs + 10 * MIN_MS;
    if (tMs < e.startMs || tMs > tail) continue;

    const rampMs = 2 * MIN_MS;
    const rampEnd = e.startMs + rampMs;
    const plateauEnd = e.startMs + (e.endMs - e.startMs) * 0.5;

    if (tMs <= rampEnd) {
      return { intensity: (tMs - e.startMs) / rampMs, ep: e };
    }
    if (tMs <= plateauEnd) {
      // Meseta con una ligera caída: 1.0 → 0.88
      const p = (tMs - rampEnd) / Math.max(1, plateauEnd - rampEnd);
      return { intensity: 1 - 0.12 * p, ep: e };
    }
    const decayed = 0.88 * ((tail - tMs) / (tail - plateauEnd));
    return { intensity: Math.max(0, Math.min(1, decayed)), ep: e };
  }
  return { intensity: 0, ep: null };
}

/* ================================================================== */
/* Generación de series                                                */
/* ================================================================== */

const SAMPLE_INTERVAL_MS = 15 * MIN_MS;
/** Dentro de un episodio el wearable muestrea más seguido — y así el pico
 *  declarado en episodes.sample.json sí aparece en la gráfica. */
const EPISODE_SAMPLE_INTERVAL_MS = 1 * MIN_MS;

function round(n, places = 0) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Rejilla de 15 min, densificada a 1 min dentro de cada ventana de episodio. */
function sampleTimestamps() {
  const set = new Set();
  for (let t = WINDOW_START.getTime(); t <= WINDOW_END.getTime(); t += SAMPLE_INTERVAL_MS) {
    set.add(t);
  }
  for (const e of EPISODE_WINDOWS) {
    const tail = e.endMs + 10 * MIN_MS;
    for (let t = e.startMs; t <= tail; t += EPISODE_SAMPLE_INTERVAL_MS) {
      if (t >= WINDOW_START.getTime() && t <= WINDOW_END.getTime()) set.add(t);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function generateSeries() {
  const heartRate = [];
  const hrv = [];
  const respiratoryRate = [];

  for (const t of sampleTimestamps()) {
    const d = new Date(t);
    const c = circadian(d);
    const asleep = isAsleep(d);
    const { intensity, ep } = episodeIntensity(t);

    // ---- heart rate ----
    let hr = BASELINE.heartRate.mean + 8 * c + gauss(0, 2.4);
    if (asleep) hr -= 5;
    if (ep) {
      const restingHr = BASELINE.heartRate.mean + 8 * c;
      hr = restingHr + (ep.peakHr - restingHr) * intensity + gauss(0, 2.0);
    }

    // ---- HRV (se mueve al revés que HR) ----
    let v = BASELINE.hrv.mean + (asleep ? 12 : -4) - 6 * c + gauss(0, 5.5);
    if (ep) {
      const restingHrv = BASELINE.hrv.mean + (asleep ? 12 : -4) - 6 * c;
      v = restingHrv + (ep.minHrv - restingHrv) * intensity + gauss(0, 2.0);
    }

    // ---- respiratory rate ----
    let rr = BASELINE.respiratoryRate.mean + (asleep ? -1.5 : 1.0) + 0.8 * c + gauss(0, 1.0);
    if (ep) {
      const restingRr = BASELINE.respiratoryRate.mean + (asleep ? -1.5 : 1.0);
      const peakRr = 24 + (ep.sev - 6) * 1.5;
      rr = restingRr + (peakRr - restingRr) * intensity + gauss(0, 0.9);
    }

    const iso = d.toISOString();
    heartRate.push({ t: iso, v: round(Math.max(38, hr)) });
    hrv.push({ t: iso, v: round(Math.max(6, v)) });
    respiratoryRate.push({ t: iso, v: round(Math.max(8, rr), 1) });
  }

  // ---- sueño: un valor por noche ----
  const sleepHours = [];
  for (let d = new Date(WINDOW_START); d <= WINDOW_END; d = new Date(d.getTime() + 24 * HOUR_MS)) {
    // Una noche con un episodio nocturno se duerme peor.
    const dayStart = d.getTime();
    const dayEnd = dayStart + 24 * HOUR_MS;
    const nightEpisode = EPISODE_WINDOWS.some(
      (e) => e.startMs >= dayStart && e.startMs < dayEnd && (hourOf(new Date(e.startMs)) >= 22 || hourOf(new Date(e.startMs)) < 6),
    );
    let h = gauss(BASELINE.sleepHours.mean, BASELINE.sleepHours.sd);
    if (nightEpisode) h -= 1.8;
    sleepHours.push({ t: new Date(dayStart + 7 * HOUR_MS).toISOString(), v: round(Math.max(2.5, Math.min(10, h)), 1) });
  }

  return { heartRate, hrv, respiratoryRate, sleepHours };
}

/* ================================================================== */
/* Derivados: episodios, outcomes, resumen                             */
/* ================================================================== */

/**
 * peakHeartRate y minHrv se LEEN de la serie ya generada, no se teclean.
 * Los valores de EPISODES solo dan forma a la curva; la cifra que se publica
 * es la que de verdad está en el gráfico. Así no hay forma de que la lista de
 * episodios y la serie se contradigan.
 */
function extremesFor(episode, series) {
  const a = new Date(episode.start).getTime();
  const b = a + episode.min * MIN_MS + 10 * MIN_MS;
  const inWindow = (pts) => pts.filter((p) => {
    const t = new Date(p.t).getTime();
    return t >= a && t <= b;
  });

  const hrPts = inWindow(series.heartRate);
  const hrvPts = inWindow(series.hrv);
  if (hrPts.length === 0) {
    throw new Error(
      `${episode.id} (${episode.start}) no tiene muestras en la ventana de observación. ` +
        `Revisa que caiga entre ${WINDOW_START.toISOString()} y ${WINDOW_END.toISOString()}.`,
    );
  }
  return {
    peakHeartRate: Math.max(...hrPts.map((p) => p.v)),
    minHrv: hrvPts.length ? Math.min(...hrvPts.map((p) => p.v)) : null,
  };
}

function buildEpisodeList(series) {
  return {
    patientId: PATIENT_ID,
    episodes: EPISODES.map((e) => {
      const start = new Date(e.start);
      const end = new Date(start.getTime() + e.min * MIN_MS);
      const { peakHeartRate, minHrv } = extremesFor(e, series);
      return {
        encounterId: e.id,
        startedAt: start.toISOString(),
        endedAt: end.toISOString(),
        durationMinutes: e.min,
        outcome: e.act ? 'resolved-with-intervention' : 'self-resolved',
        peakHeartRate,
        minHrv,
        severitySelfReported: e.sev,
        interventions: e.act
          ? [
              {
                carePlanActivityId: e.act,
                title: ACTIVITY_TITLES[e.act],
                completed: true,
                patientReportedRelief: e.relief,
              },
            ]
          : [],
        escalation: { triggered: false, rule: null, triggeredAt: null, action: null },
      };
    }),
  };
}

/** Lunes de la semana ISO que contiene `date`. */
function weekStart(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // 0 = lunes
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * El loop cerrado. Todo se computa desde EPISODES — ningún promedio está
 * escrito a mano.
 */
function buildOutcomes() {
  const byActivity = new Map();
  const noIntervention = [];

  for (const e of EPISODES) {
    if (!e.act) {
      noIntervention.push(e.min);
      continue;
    }
    if (!byActivity.has(e.act)) byActivity.set(e.act, []);
    byActivity.get(e.act).push(e);
  }

  const byIntervention = [...byActivity.entries()]
    .map(([act, eps]) => ({
      carePlanActivityId: act,
      title: ACTIVITY_TITLES[act],
      timesAttempted: eps.length,
      avgEpisodeDurationMinutes: round(mean(eps.map((e) => e.min)), 1),
      avgReliefScore: round(mean(eps.map((e) => e.relief)), 1),
    }))
    .sort((a, b) => a.avgEpisodeDurationMinutes - b.avgEpisodeDurationMinutes);

  const weeks = new Map();
  for (const e of EPISODES) {
    const w = weekStart(e.start);
    weeks.set(w, (weeks.get(w) ?? 0) + 1);
  }

  return {
    byIntervention,
    baselineNoInterventionAvgDurationMinutes: round(mean(noIntervention), 1),
    episodeCountByWeek: [...weeks.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([weekStart, count]) => ({ weekStart, count })),
  };
}

function buildSummary() {
  const last = EPISODES[EPISODES.length - 1];
  return {
    patientId: PATIENT_ID,
    displayName: DISPLAY_NAME,
    age: AGE,
    gender: 'female',
    conditions: [
      {
        code: '197480006',
        system: 'http://snomed.info/sct',
        display: 'Anxiety disorder',
        onsetDate: '2023-04-12',
        clinicalStatus: 'active',
      },
    ],
    medications: [
      { display: 'Sertraline 50mg', status: 'active', rxnorm: '312938', coverageCheckable: true },
    ],
    carePlanAuthor: 'Dr. Maya Chen',
    carePlanLastUpdated: '2026-07-02',
    baseline: BASELINE,
    episodeCount: EPISODES.length,
    lastEpisodeAt: new Date(last.start).toISOString(),
  };
}

/* ================================================================== */
/* Escritura                                                           */
/* ================================================================== */

function write(name, data) {
  const path = join(HERE, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  const size = JSON.stringify(data).length;
  console.log(`  ${name.padEnd(38)} ${(size / 1024).toFixed(1)} KB`);
}

const series = generateSeries();

console.log('Generando fixtures de Loop...\n');

for (const [metric, points] of Object.entries(series)) {
  write(`observations.${metric}.json`, {
    metric,
    unit: BASELINE[metric].unit,
    bucket: metric === 'sleepHours' ? '1d' : '15m/1m-during-episodes',
    baseline: BASELINE[metric],
    points,
  });
}

write('episodes.sample.json', buildEpisodeList(series));
write('outcomes.sample.json', buildOutcomes());
write('summary.sample.json', buildSummary());

const outcomes = buildOutcomes();
console.log('\nOutcomes derivados (verificación):');
for (const o of outcomes.byIntervention) {
  console.log(
    `  ${o.title.padEnd(22)} n=${o.timesAttempted}  dur=${o.avgEpisodeDurationMinutes}min  relief=${o.avgReliefScore}/10`,
  );
}
console.log(`  ${'(sin intervención)'.padEnd(22)} n=${EPISODES.filter((e) => !e.act).length}  dur=${outcomes.baselineNoInterventionAvgDurationMinutes}min`);
console.log(`\n  Episodios por semana: ${outcomes.episodeCountByWeek.map((w) => w.count).join(' → ')}`);
console.log(`  Muestras por métrica: ${series.heartRate.length}\n`);
