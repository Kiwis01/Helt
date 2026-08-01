/**
 * Tests de `buildVoiceSummary`.
 *
 * Esta frase la escucha el público del demo. Los tests no comprueban solo que
 * la función corra: comprueban que la frase sea decible, honesta y corta.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVoiceSummary,
  centsToSpokenAmount,
  VOICE_SUMMARY_MAX_LENGTH,
  type VoiceLang,
  type VoiceSummaryInput,
} from './voice-summary.js';

const LANGS: VoiceLang[] = ['es', 'en'];

/** La misma expresión que usa `shared/validate-fixtures.ts`. */
const FORBIDDEN = [/cents?\b/i, /centavos?\b/i];

const base: VoiceSummaryInput = {
  status: 'covered',
  copayCents: 2500,
  coinsurancePercent: 0,
  deductible: { individualCents: 150_000, metCents: 142_000, remainingCents: 8_000 },
  priorAuthRequired: false,
  payerName: 'Test Payer Inc',
};

function assertSpeakable(summary: string, label: string): void {
  assert.ok(summary.length > 0, `${label}: la frase no puede quedar vacía`);
  assert.ok(
    summary.length < VOICE_SUMMARY_MAX_LENGTH,
    `${label}: ${summary.length} caracteres, el techo es ${VOICE_SUMMARY_MAX_LENGTH}`,
  );
  for (const pattern of FORBIDDEN) {
    assert.ok(!pattern.test(summary), `${label}: la salida menciona centavos → "${summary}"`);
  }
  // Un monto leído como "0 dólares" es siempre un bug: el copago de cero y el
  // deducible cubierto tienen sus propias frases, así que si aparece un cero es
  // que se redondeó hacia abajo algo que no era cero.
  assert.ok(
    !/\b0\s+(dólar|dollar)/.test(summary),
    `${label}: un monto se está leyendo como cero → "${summary}"`,
  );
}

/* ------------------------------------------------------------------ */
/* Los 4 status × los 2 idiomas                                        */
/* ------------------------------------------------------------------ */

const STATUSES: VoiceSummaryInput['status'][] = ['covered', 'not-covered', 'needs-auth', 'unknown'];

for (const status of STATUSES) {
  for (const lang of LANGS) {
    test(`status=${status} lang=${lang} produce una frase decible`, () => {
      const summary = buildVoiceSummary({ ...base, status }, lang);
      assertSpeakable(summary, `${status}/${lang}`);
    });
  }
}

test('es determinista: la misma entrada devuelve exactamente la misma frase', () => {
  for (const lang of LANGS) {
    const a = buildVoiceSummary(base, lang);
    const b = buildVoiceSummary({ ...base }, lang);
    assert.equal(a, b);
  }
});

/* ------------------------------------------------------------------ */
/* covered — el camino del demo                                        */
/* ------------------------------------------------------------------ */

test('covered/es dice el copago y el deducible restante en lenguaje humano', () => {
  const summary = buildVoiceSummary(base, 'es');
  assert.match(summary, /cubierto/);
  assert.match(summary, /25 dólares/);
  assert.match(summary, /80 dólares/); // 8000 centavos restantes de deducible
  assertSpeakable(summary, 'covered/es');
});

test('covered/en dice el copago y el deducible restante en lenguaje humano', () => {
  const summary = buildVoiceSummary(base, 'en');
  assert.match(summary, /covered/);
  assert.match(summary, /25 dollars/);
  assert.match(summary, /80 dollars/);
  assertSpeakable(summary, 'covered/en');
});

test('covered con priorAuthRequired=true lo menciona', () => {
  const es = buildVoiceSummary({ ...base, priorAuthRequired: true }, 'es');
  const en = buildVoiceSummary({ ...base, priorAuthRequired: true }, 'en');
  assert.match(es, /autorización previa/);
  assert.match(en, /prior approval/);
});

test('copago cero no se lee como "0 dólares"', () => {
  assert.match(buildVoiceSummary({ ...base, copayCents: 0 }, 'es'), /No tienes que pagar copago/);
  assert.match(buildVoiceSummary({ ...base, copayCents: 0 }, 'en'), /no copay/);
});

/* ------------------------------------------------------------------ */
/* Datos ausentes — la frase lo dice, no lo inventa                     */
/* ------------------------------------------------------------------ */

test('copay null y coinsurance null: la frase admite que no conoce el copago', () => {
  for (const lang of LANGS) {
    const summary = buildVoiceSummary({ ...base, copayCents: null, coinsurancePercent: null }, lang);
    const expected = lang === 'es' ? /No pude confirmar tu copago/ : /could not confirm your copay/;
    assert.match(summary, expected);
    // Y sobre todo: no se afirma ningún copago inventado.
    const invented = lang === 'es' ? /Tu copago (es|sería) de/ : /Your copay (is|would be)/;
    assert.ok(!invented.test(summary), `no debe inventar un copago → "${summary}"`);
    assertSpeakable(summary, `copay-null/${lang}`);
  }
});

test('sin copago ni deducible conocidos no aparece ningún monto', () => {
  for (const lang of LANGS) {
    const summary = buildVoiceSummary(
      { ...base, copayCents: null, coinsurancePercent: null, deductible: null },
      lang,
    );
    assert.ok(!/\d+\s+(dólar|dollar)/.test(summary), `no debe inventar un monto → "${summary}"`);
    assertSpeakable(summary, `sin-datos/${lang}`);
  }
});

test('deductible null: la frase admite que no conoce el deducible', () => {
  for (const lang of LANGS) {
    const summary = buildVoiceSummary({ ...base, deductible: null }, lang);
    const expected = lang === 'es' ? /No pude confirmar tu deducible/ : /could not confirm your deductible/;
    assert.match(summary, expected);
    assertSpeakable(summary, `deductible-null/${lang}`);
  }
});

test('coinsurance sin copago: se lee el porcentaje, no un monto', () => {
  const input: VoiceSummaryInput = { ...base, copayCents: null, coinsurancePercent: 20 };

  const es = buildVoiceSummary(input, 'es');
  assert.match(es, /20 por ciento/);
  assertSpeakable(es, 'coinsurance/es');

  const en = buildVoiceSummary(input, 'en');
  assert.match(en, /20% of the cost/);
  assertSpeakable(en, 'coinsurance/en');
});

test('coinsurance 0 con el deducible ya cubierto sí es cobertura completa', () => {
  const input: VoiceSummaryInput = {
    ...base,
    copayCents: null,
    coinsurancePercent: 0,
    deductible: { individualCents: 150_000, metCents: 150_000, remainingCents: 0 },
  };
  assert.match(buildVoiceSummary(input, 'es'), /Tu plan cubre el costo completo\./);
  assert.match(buildVoiceSummary(input, 'en'), /Your plan covers the full cost\./);
});

test('coinsurance 0 con deducible pendiente NO promete el costo completo sin condición', () => {
  // El coaseguro del 0% se aplica después del deducible. Con 1200 dólares
  // pendientes, "tu plan cubre el costo completo" a secas es falso, y es la
  // parte de la frase que el paciente se va a quedar.
  const input: VoiceSummaryInput = {
    ...base,
    copayCents: null,
    coinsurancePercent: 0,
    deductible: { individualCents: 150_000, metCents: 30_000, remainingCents: 120_000 },
  };

  const es = buildVoiceSummary(input, 'es');
  assert.match(es, /cubre el costo completo una vez que cubras tu deducible/);
  assert.ok(
    !/costo completo\./.test(es),
    `la promesa no puede quedar sin condición → "${es}"`,
  );
  assertSpeakable(es, 'coinsurance-0-deducible-pendiente/es');

  const en = buildVoiceSummary(input, 'en');
  assert.match(en, /covers the full cost once you meet your deductible/);
  assert.ok(!/full cost\./.test(en), `la promesa no puede quedar sin condición → "${en}"`);
  assertSpeakable(en, 'coinsurance-0-deducible-pendiente/en');
});

test('needs-auth con coaseguro 0 y deducible pendiente también condiciona la frase', () => {
  const input: VoiceSummaryInput = {
    ...base,
    status: 'needs-auth',
    copayCents: null,
    coinsurancePercent: 0,
    deductible: { individualCents: 150_000, metCents: 30_000, remainingCents: 120_000 },
  };
  assert.match(buildVoiceSummary(input, 'es'), /cubriría el costo completo una vez que cubras tu deducible/);
  assert.match(buildVoiceSummary(input, 'en'), /would cover the full cost once you meet your deductible/);
});

test('deducible ya cubierto no dice "te quedan 0 dólares"', () => {
  const input: VoiceSummaryInput = {
    ...base,
    deductible: { individualCents: 150_000, metCents: 150_000, remainingCents: 0 },
  };
  assert.match(buildVoiceSummary(input, 'es'), /Ya cubriste tu deducible/);
  assert.match(buildVoiceSummary(input, 'en'), /already met your deductible/);
});

/* ------------------------------------------------------------------ */
/* unknown — el fallback honesto                                       */
/* ------------------------------------------------------------------ */

test('unknown nunca menciona un monto, aunque le pasen datos sueltos', () => {
  const input: VoiceSummaryInput = { ...base, status: 'unknown' };
  for (const lang of LANGS) {
    const summary = buildVoiceSummary(input, lang);
    assert.ok(!/\d/.test(summary), `unknown no debe llevar cifras → "${summary}"`);
    assertSpeakable(summary, `unknown/${lang}`);
  }
});

test('unknown/es coincide con el fixture coverage.unknown.json', () => {
  assert.equal(
    buildVoiceSummary({ ...base, status: 'unknown' }, 'es'),
    'No pude verificar tu cobertura en este momento. Tu equipo de cuidado puede confirmarlo por ti.',
  );
});

/* ------------------------------------------------------------------ */
/* Formateo de montos                                                  */
/* ------------------------------------------------------------------ */

test('centsToSpokenAmount nunca usa la palabra prohibida y respeta el singular', () => {
  const cases: [number, VoiceLang, string][] = [
    [2500, 'es', '25 dólares'],
    [2500, 'en', '25 dollars'],
    [100, 'es', '1 dólar'],
    [100, 'en', '1 dollar'],
    [0, 'es', '0 dólares'],
    [8000, 'en', '80 dollars'],
  ];
  for (const [cents, lang, expected] of cases) {
    assert.equal(centsToSpokenAmount(cents, lang), expected);
  }
});

test('montos no enteros se redondean y se marcan como aproximados', () => {
  assert.equal(centsToSpokenAmount(2550, 'es'), 'alrededor de 26 dólares');
  assert.equal(centsToSpokenAmount(2550, 'en'), 'about 26 dollars');
  for (const pattern of FORBIDDEN) {
    assert.ok(!pattern.test(centsToSpokenAmount(2550, 'en')));
  }
});

test('un monto por debajo del dólar no se lee como cero', () => {
  // Redondear 49 centavos daba "alrededor de 0 dólares", y el copago de cero ya
  // tiene su propia frase ("No tienes que pagar copago"): decir cero cuando no
  // es cero solo se puede entender como que no hay nada que pagar.
  for (const cents of [1, 49, 99]) {
    assert.equal(centsToSpokenAmount(cents, 'es'), 'menos de un dólar', `${cents} centavos`);
    assert.equal(centsToSpokenAmount(cents, 'en'), 'less than a dollar', `${cents} centavos`);
  }
  assert.equal(centsToSpokenAmount(0, 'es'), '0 dólares'); // el cero sigue siendo cero
  assert.equal(centsToSpokenAmount(100, 'es'), '1 dólar');
});

test('un copago sub-dólar no se anuncia como 0 dólares en la frase completa', () => {
  const input: VoiceSummaryInput = {
    ...base,
    copayCents: 49,
    deductible: { individualCents: 150_000, metCents: 149_960, remainingCents: 40 },
  };

  const es = buildVoiceSummary(input, 'es');
  assert.ok(!/0 dólares/.test(es), `no puede leerse como cero → "${es}"`);
  assert.match(es, /Tu copago es de menos de un dólar/);
  assert.match(es, /Te queda menos de un dólar por cubrir de tu deducible/);
  assertSpeakable(es, 'sub-dólar/es');

  const en = buildVoiceSummary(input, 'en');
  assert.ok(!/0 dollars/.test(en), `no puede leerse como cero → "${en}"`);
  assert.match(en, /Your copay is less than a dollar/);
  assertSpeakable(en, 'sub-dólar/en');
});

/* ------------------------------------------------------------------ */
/* Barrido de seguridad                                                */
/* ------------------------------------------------------------------ */

test('ninguna combinación razonable produce "cent"/"centavo" ni supera el techo', () => {
  // Los sub-dólar (1, 49, 99) están aquí a propósito: son el tramo que antes
  // se leía como "alrededor de 0 dólares".
  const copays: (number | null)[] = [null, 0, 1, 49, 99, 100, 2500, 2550, 4000, 123_456];
  const coins: (number | null)[] = [null, 0, 12.5, 20, 100];
  const deductibles: (VoiceSummaryInput['deductible'])[] = [
    null,
    { individualCents: 150_000, metCents: 150_000, remainingCents: 0 },
    { individualCents: 150_000, metCents: 149_960, remainingCents: 40 },
    { individualCents: 150_000, metCents: 142_000, remainingCents: 8_000 },
    { individualCents: 999_999, metCents: 0, remainingCents: 999_999 },
  ];

  let combinations = 0;
  for (const status of STATUSES) {
    for (const lang of LANGS) {
      for (const copayCents of copays) {
        for (const coinsurancePercent of coins) {
          for (const deductible of deductibles) {
            for (const priorAuthRequired of [true, false, null]) {
              const summary = buildVoiceSummary(
                { status, copayCents, coinsurancePercent, deductible, priorAuthRequired, payerName: 'X' },
                lang,
              );
              assertSpeakable(summary, `${status}/${lang}`);
              combinations++;
            }
          }
        }
      }
    }
  }
  assert.ok(combinations > 500, 'el barrido debe cubrir cientos de combinaciones');
});
