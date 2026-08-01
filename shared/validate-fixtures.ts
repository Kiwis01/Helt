/**
 * Valida cada fixture contra su esquema zod, y después comprueba las
 * invariantes que cruzan archivos.
 *
 *   npm run fixtures:validate
 *
 * La validación de esquema por sí sola no basta: lo que rompe un demo es que
 * el gráfico de outcomes diga una cosa y la lista de episodios diga otra. Las
 * comprobaciones cruzadas de abajo son las que de verdad protegen el pitch.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodTypeAny, TypeOf } from 'zod';

import {
  PatientContext,
  CoverageCheckResponse,
  EpisodeWriteRequest,
  EpisodeList,
  OutcomesSummary,
  PatientSummary,
  ObservationSeries,
} from './contracts.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const read = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

let failures = 0;

/** Genérico para que lo validado salga TIPADO y las invariantes de abajo no
 *  degeneren a `any` — que es justo donde se cuelan los errores de nombre. */
function check<T extends ZodTypeAny>(name: string, schema: T): TypeOf<T> | null {
  const result = schema.safeParse(read(name));
  if (result.success) {
    console.log(`  ok    ${name}`);
    return result.data;
  }
  failures++;
  console.log(`  FALLA ${name}`);
  for (const issue of result.error.issues.slice(0, 6)) {
    console.log(`          ${issue.path.join('.') || '(raíz)'}: ${issue.message}`);
  }
  if (result.error.issues.length > 6) {
    console.log(`          ... y ${result.error.issues.length - 6} más`);
  }
  return null;
}

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FALLA ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. Validación de esquema                                            */
/* ------------------------------------------------------------------ */

console.log('\nEsquemas:');

const happy = check('context.happy.json', PatientContext);
const redflag = check('context.redflag.json', PatientContext);

check('coverage.covered.json', CoverageCheckResponse);
check('coverage.unknown.json', CoverageCheckResponse);
check('coverage.needsauth.json', CoverageCheckResponse);
check('episode.sample.json', EpisodeWriteRequest);

const episodeList = check('episodes.sample.json', EpisodeList);
const outcomes = check('outcomes.sample.json', OutcomesSummary);
check('summary.sample.json', PatientSummary);

const seriesFiles = readdirSync(FIXTURES).filter((f) => f.startsWith('observations.'));
const series: Record<string, ReturnType<typeof read>> = {};
for (const f of seriesFiles) {
  const parsed = check(f, ObservationSeries);
  if (parsed) series[parsed.metric] = parsed;
}

/* ------------------------------------------------------------------ */
/* 2. Invariantes cruzadas — lo que de verdad protege el demo          */
/* ------------------------------------------------------------------ */

console.log('\nInvariantes:');

// El fixture de red-flag DEBE violar el envelope; si no, no hay nada que
// demostrar en el bloque de seguridad del pitch.
if (redflag) {
  const { current, safetyEnvelope } = redflag;
  const violates =
    current.heartRate.latest > safetyEnvelope.heartRateMax ||
    current.heartRate.latest < safetyEnvelope.heartRateMin ||
    current.respiratoryRate.latest > safetyEnvelope.respiratoryRateMax ||
    (current.spo2?.latest ?? 100) < safetyEnvelope.spo2Min;
  assert('context.redflag viola el safetyEnvelope (RF-08 debe disparar)', violates);
}

// Y el fixture feliz NO debe violarlo, o el demo escalaría cuando no toca.
if (happy) {
  const { current, safetyEnvelope } = happy;
  const withinEnvelope =
    current.heartRate.latest <= safetyEnvelope.heartRateMax &&
    current.heartRate.latest >= safetyEnvelope.heartRateMin &&
    current.respiratoryRate.latest <= safetyEnvelope.respiratoryRateMax &&
    (current.spo2?.latest ?? 100) >= safetyEnvelope.spo2Min;
  assert('context.happy NO viola el safetyEnvelope', withinEnvelope);
}

// Los deltas deben cuadrar con baseline y current, si no el agente de voz
// dice números que no corresponden.
if (happy) {
  const expectedSd = (happy.current.heartRate.latest - happy.baseline.heartRate.mean) / happy.baseline.heartRate.sd;
  assert(
    'deltas.heartRate.sdFromBaseline coincide con baseline/current',
    Math.abs(expectedSd - happy.deltas.heartRate.sdFromBaseline) < 0.05,
    `esperado ~${expectedSd.toFixed(2)}, fixture dice ${happy.deltas.heartRate.sdFromBaseline}`,
  );
  assert(
    'deltas.heartRate.absolute coincide con baseline/current',
    happy.deltas.heartRate.absolute === happy.current.heartRate.latest - happy.baseline.heartRate.mean,
  );
}

// El gráfico de outcomes tiene que derivarse de la lista de episodios. Esta
// es la comprobación que evita que un juez encuentre una contradicción.
if (episodeList && outcomes) {
  const grouped = new Map<string, { durations: number[]; reliefs: number[] }>();
  const noIntervention: number[] = [];

  for (const e of episodeList.episodes) {
    if (e.interventions.length === 0) {
      noIntervention.push(e.durationMinutes);
      continue;
    }
    for (const i of e.interventions) {
      if (!grouped.has(i.carePlanActivityId)) grouped.set(i.carePlanActivityId, { durations: [], reliefs: [] });
      const g = grouped.get(i.carePlanActivityId)!;
      g.durations.push(e.durationMinutes);
      if (i.patientReportedRelief !== null) g.reliefs.push(i.patientReportedRelief);
    }
  }

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.06;

  for (const o of outcomes.byIntervention) {
    const g = grouped.get(o.carePlanActivityId);
    assert(`outcomes[${o.carePlanActivityId}] existe en episodes`, !!g);
    if (!g) continue;
    assert(
      `outcomes[${o.carePlanActivityId}].timesAttempted = ${o.timesAttempted}`,
      o.timesAttempted === g.durations.length,
      `episodes dice ${g.durations.length}`,
    );
    assert(
      `outcomes[${o.carePlanActivityId}].avgEpisodeDurationMinutes = ${o.avgEpisodeDurationMinutes}`,
      near(o.avgEpisodeDurationMinutes, avg(g.durations)),
      `episodes dice ${avg(g.durations).toFixed(2)}`,
    );
    assert(
      `outcomes[${o.carePlanActivityId}].avgReliefScore = ${o.avgReliefScore}`,
      near(o.avgReliefScore, avg(g.reliefs)),
      `episodes dice ${avg(g.reliefs).toFixed(2)}`,
    );
  }

  assert(
    `baselineNoInterventionAvgDurationMinutes = ${outcomes.baselineNoInterventionAvgDurationMinutes}`,
    near(outcomes.baselineNoInterventionAvgDurationMinutes, avg(noIntervention)),
    `episodes dice ${avg(noIntervention).toFixed(2)}`,
  );

  const weekTotal = outcomes.episodeCountByWeek.reduce((a, w) => a + w.count, 0);
  assert(
    'episodeCountByWeek suma el total de episodios',
    weekTotal === episodeList.episodes.length,
    `${weekTotal} vs ${episodeList.episodes.length}`,
  );

  // La narrativa del pitch: la intervención que más se usó es la que produce
  // episodios más cortos, y todas baten a no hacer nada.
  const best = outcomes.byIntervention[0];
  assert(
    'la mejor intervención bate al baseline sin intervención',
    best.avgEpisodeDurationMinutes < outcomes.baselineNoInterventionAvgDurationMinutes,
    `${best.avgEpisodeDurationMinutes} vs ${outcomes.baselineNoInterventionAvgDurationMinutes}`,
  );
}

// Cada pico declarado en un episodio debe existir de verdad en la serie.
if (episodeList && series.heartRate && series.hrv) {
  let mismatches = 0;
  for (const e of episodeList.episodes) {
    const a = new Date(e.startedAt).getTime();
    const b = new Date(e.endedAt).getTime() + 10 * 60_000;
    const inWindow = (pts: { t: string; v: number }[]) =>
      pts.filter((p) => {
        const t = new Date(p.t).getTime();
        return t >= a && t <= b;
      });

    const hr = inWindow(series.heartRate.points);
    const hrv = inWindow(series.hrv.points);
    if (hr.length === 0) {
      mismatches++;
      continue;
    }
    if (Math.max(...hr.map((p) => p.v)) !== e.peakHeartRate) mismatches++;
    else if (e.minHrv !== null && hrv.length && Math.min(...hrv.map((p) => p.v)) !== e.minHrv) mismatches++;
  }
  assert(
    'cada peakHeartRate/minHrv declarado aparece en la serie de observaciones',
    mismatches === 0,
    `${mismatches} de ${episodeList.episodes.length} episodios no cuadran`,
  );
}

// El resumen tiene que contar los mismos episodios que la lista.
const summary = read('summary.sample.json');
if (episodeList) {
  assert(
    'summary.episodeCount coincide con episodes.sample.json',
    summary.episodeCount === episodeList.episodes.length,
    `${summary.episodeCount} vs ${episodeList.episodes.length}`,
  );
  const last = episodeList.episodes[episodeList.episodes.length - 1];
  assert('summary.lastEpisodeAt es el episodio más reciente', summary.lastEpisodeAt === last.startedAt);
}

// voiceSummary lo lee un agente de voz en voz alta. Sin jerga de centavos.
for (const f of ['coverage.covered.json', 'coverage.unknown.json', 'coverage.needsauth.json']) {
  const c = read(f);
  assert(`${f}: voiceSummary no menciona "cents"`, !/cents?\b/i.test(c.voiceSummary));
  assert(`${f}: voiceSummary es una frase legible (< 220 chars)`, c.voiceSummary.length < 220);
}

/* ------------------------------------------------------------------ */

console.log(
  failures === 0
    ? '\nTodos los fixtures validan y las invariantes se cumplen.\n'
    : `\n${failures} problema(s). Corrígelos antes de que alguien construya contra estos fixtures.\n`,
);
process.exit(failures === 0 ? 0 : 1);
