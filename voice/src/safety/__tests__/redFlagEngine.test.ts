/**
 * Suite del motor de red-flags.
 *
 * Es el entregable irrenunciable del brief: si todo lo demas falla, esto solo ya
 * es un pitch defendible. Por eso cada caso es un `it` independiente — cuando un
 * juez pregunta "¿cuantos casos tienen?", la respuesta esta en la salida de
 * vitest, no en un README.
 *
 * Organizacion:
 *   1. Positivos     — 2+ por regla, uno en espanol y uno en ingles
 *   2. Negativos     — frases que NO pueden disparar
 *   3. Bordes RF-08  — los umbrales, exactamente donde duelen
 *   4. Prioridad     — RF-09 gana sobre RF-01
 *   5. Pureza        — el motor es una funcion, no un servicio
 *   6. Contrato      — IDs exactos, acciones correctas, guiones hardcodeados
 */

import { describe, expect, it } from 'vitest';
import { evaluate } from '../redFlagEngine.js';
import { RED_FLAG_RULES, isNegated, normalize } from '../rules.js';
import { SCRIPT_911, SCRIPT_988 } from '../scripts.js';
import type { CurrentBiometrics, RedFlagResult, SafetyEnvelope } from '../../types.js';

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

/** El envelope del care plan del demo (identico al de los fixtures). */
const ENVELOPE: SafetyEnvelope = {
  heartRateMax: 150,
  heartRateMin: 40,
  respiratoryRateMax: 32,
  spo2Min: 92,
  note: 'Valores fuera del envelope DEBEN disparar escalacion determinista ANTES de cualquier llamada al LLM.',
};

interface BioOverrides {
  hr?: number;
  hrPeak?: number;
  hrv?: number;
  rr?: number;
  rrPeak?: number;
  spo2?: number;
}

/** Construye una biometria del contrato. Por defecto, pico = ultima lectura. */
function bio(over: BioOverrides = {}): CurrentBiometrics {
  const hr = over.hr ?? 118;
  const rr = over.rr ?? 24;
  const hrv = over.hrv ?? 21;
  const base: CurrentBiometrics = {
    windowMinutes: 30,
    heartRate: { latest: hr, max: over.hrPeak ?? hr, trend: 'rising', unit: 'bpm' },
    hrv: { latest: hrv, min: hrv, trend: 'falling', unit: 'ms' },
    respiratoryRate: {
      latest: rr,
      max: over.rrPeak ?? rr,
      trend: 'rising',
      unit: 'breaths/min',
    },
    lastSampleAt: '2026-08-01T18:21:40Z',
  };
  if (over.spo2 !== undefined) {
    base.spo2 = { latest: over.spo2, min: over.spo2, trend: 'falling', unit: '%' };
  }
  return base;
}

/**
 * Biometria de panico DENTRO del envelope: taquicardia real (96 bpm sobre una
 * baseline de 68) pero sin salirse de los limites del care plan. Es el default
 * de los tests de texto: asi ninguna regla biometrica contamina el resultado.
 */
const INSIDE_ENVELOPE = bio({ hr: 96, rr: 18, hrv: 30 });

/** Biometria del fixture `context.redflag.json`: HR 163, RR 34. Fuera. */
const OUTSIDE_ENVELOPE = bio({ hr: 163, hrPeak: 171, rr: 34, rrPeak: 36, hrv: 14 });

function run(text: string, biometrics: CurrentBiometrics | null = INSIDE_ENVELOPE): RedFlagResult {
  return evaluate({ transcriptText: text, biometrics, safetyEnvelope: ENVELOPE });
}

// =============================================================================
// 1. POSITIVOS — al menos dos por regla (espanol + ingles)
// =============================================================================

describe('RF-01-CHEST-PAIN-RADIATING · dolor de pecho que irradia', () => {
  it('[ES] "me duele el pecho y se me va al brazo izquierdo"', () => {
    const result = run('Me duele el pecho y se me va al brazo izquierdo');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-01-CHEST-PAIN-RADIATING');
    expect(result.action).toBe('advise-911');
    expect(result.severity).toBe('critical');
    expect(result.matchedEvidence).toContain('irradiacion');
  });

  it('[ES] opresion en el pecho que sube a la mandibula', () => {
    const result = run('Siento una opresión en el pecho que me sube a la mandíbula');
    expect(result.ruleId).toBe('RF-01-CHEST-PAIN-RADIATING');
  });

  it('[EN] "chest pain radiating to my jaw"', () => {
    const result = run('I have chest pain radiating to my jaw');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-01-CHEST-PAIN-RADIATING');
    expect(result.action).toBe('advise-911');
  });

  it('dolor de pecho SIN irradiacion no dispara RF-01 (con biometria normal)', () => {
    // Requisito explicito del brief: hacen falta las DOS señales.
    const result = run('Me duele el pecho');
    expect(result.triggered).toBe(false);
  });

  it('el modo hipotetico SI dispara — decision de criterio documentada', () => {
    // En emergencias se prefiere el falso positivo. Solo la negacion explicita
    // apaga la regla.
    const result = run('¿Qué pasa si me duele el pecho y se me va al brazo?');
    expect(result.ruleId).toBe('RF-01-CHEST-PAIN-RADIATING');
  });
});

describe('RF-02-SYNCOPE · desmayo o perdida de conciencia', () => {
  it('[ES] "me desmayé hace un rato"', () => {
    const result = run('Me desmayé hace un rato en la cocina');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-02-SYNCOPE');
    expect(result.action).toBe('advise-911');
  });

  it('[ES] "perdí el conocimiento unos segundos"', () => {
    expect(run('Perdí el conocimiento unos segundos').ruleId).toBe('RF-02-SYNCOPE');
  });

  it('[EN] "I passed out for a few seconds"', () => {
    const result = run('I passed out for a few seconds');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-02-SYNCOPE');
  });
});

describe('RF-03-UNILATERAL-WEAKNESS · debilidad de un solo lado', () => {
  it('[ES] "no siento el brazo izquierdo"', () => {
    const result = run('No siento el brazo izquierdo, lo tengo sin fuerza');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-03-UNILATERAL-WEAKNESS');
    expect(result.matchedEvidence).toContain('lateralidad');
  });

  it('[ES] "se me durmió medio cuerpo"', () => {
    expect(run('Se me durmió medio cuerpo de repente').ruleId).toBe('RF-03-UNILATERAL-WEAKNESS');
  });

  it('[EN] "weakness on my right side"', () => {
    const result = run('I feel weakness on my right side');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-03-UNILATERAL-WEAKNESS');
  });
});

describe('RF-04-SPEECH-FACIAL · habla arrastrada o caida facial', () => {
  it('[ES] "se me traba la lengua y hablo raro"', () => {
    const result = run('Se me traba la lengua y hablo raro');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-04-SPEECH-FACIAL');
  });

  it('[ES] "se me cayó media cara"', () => {
    expect(run('Se me cayó media cara, la tengo torcida').ruleId).toBe('RF-04-SPEECH-FACIAL');
  });

  it('[EN] "my speech is slurred and my face is drooping"', () => {
    const result = run('My speech is slurred and my face is drooping');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-04-SPEECH-FACIAL');
  });
});

describe('RF-05-THUNDERCLAP-HEADACHE · cefalea en trueno', () => {
  it('[ES] "el peor dolor de cabeza de mi vida"', () => {
    const result = run('Es el peor dolor de cabeza de mi vida, me dio de repente');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-05-THUNDERCLAP-HEADACHE');
  });

  it('[ES] dolor de cabeza de inicio subito', () => {
    expect(run('Me dio un dolor de cabeza súbito hace diez minutos').ruleId).toBe(
      'RF-05-THUNDERCLAP-HEADACHE',
    );
  });

  it('[EN] "worst headache of my life"', () => {
    const result = run('This is the worst headache of my life, it came on suddenly');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-05-THUNDERCLAP-HEADACHE');
  });
});

describe('RF-06-DYSPNEA-AT-REST · disnea en reposo', () => {
  it('[ES] "no puedo respirar"', () => {
    const result = run('No puedo respirar');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-06-DYSPNEA-AT-REST');
  });

  it('[ES] "no puedo terminar las frases"', () => {
    expect(run('No puedo terminar las frases de lo agitado que estoy').ruleId).toBe(
      'RF-06-DYSPNEA-AT-REST',
    );
  });

  it('[EN] "I cant breathe, I cant finish a sentence"', () => {
    const result = run("I can't breathe, I can't finish a sentence");
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-06-DYSPNEA-AT-REST');
  });
});

describe('RF-07-SELF-HARM · ideacion suicida (988, NO 911)', () => {
  it('[ES] "quiero matarme" — accion 988', () => {
    const result = run('Ya no aguanto más, quiero matarme');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-07-SELF-HARM');
    expect(result.action).toBe('advise-988');
    expect(result.script).toBe(SCRIPT_988);
  });

  it('[ES] "me quiero hacer daño"', () => {
    const result = run('A veces me quiero hacer daño');
    expect(result.ruleId).toBe('RF-07-SELF-HARM');
    expect(result.action).toBe('advise-988');
  });

  it('[EN] "I want to kill myself" — accion 988', () => {
    const result = run('I want to kill myself');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-07-SELF-HARM');
    expect(result.action).toBe('advise-988');
  });

  it('la negacion de la frase ANTERIOR no apaga la ideacion de la siguiente', () => {
    // El peor falso negativo posible del sistema. La ventana de negacion se
    // corta en la frontera de oracion justo para esto.
    const result = run('Ya no quiero seguir viviendo, quiero matarme');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-07-SELF-HARM');
  });
});

describe('RF-08-BIOMETRIC-ENVELOPE · biometria fuera del envelope', () => {
  it('[ES] texto neutro + HR 163 bpm', () => {
    const result = run('Me siento raro, no sé cómo explicarlo', bio({ hr: 163 }));
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-08-BIOMETRIC-ENVELOPE');
    expect(result.action).toBe('advise-911');
    expect(result.matchedEvidence).toContain('heartRate 163 bpm > max 150');
  });

  it('[EN] texto neutro + RR 34', () => {
    const result = run('I feel weird right now', bio({ rr: 34 }));
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-08-BIOMETRIC-ENVELOPE');
    expect(result.matchedEvidence).toContain('respiratoryRate 34 breaths/min > max 32');
  });

  it('dispara incluso sin texto: no necesita que el paciente hable', () => {
    const result = run('', bio({ hr: 175 }));
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-08-BIOMETRIC-ENVELOPE');
  });

  it('severidad "urgent": evidencia solo numerica, posible artefacto del wearable', () => {
    expect(run('todo bien', bio({ hr: 163 })).severity).toBe('urgent');
  });

  it('SpO2 por debajo del minimo dispara', () => {
    const result = run('Estoy mareado', bio({ spo2: 88 }));
    expect(result.ruleId).toBe('RF-08-BIOMETRIC-ENVELOPE');
    expect(result.matchedEvidence).toContain('spo2 88 % < min 92');
  });

  it('un pico dentro de la ventana cuenta aunque la ultima lectura sea normal', () => {
    const result = run('ya estoy más tranquilo', bio({ hr: 140, hrPeak: 168 }));
    expect(result.ruleId).toBe('RF-08-BIOMETRIC-ENVELOPE');
    expect(result.matchedEvidence).toContain('pico 168');
  });
});

describe('RF-09-COMBINED · dolor de pecho + biometria fuera de envelope', () => {
  it('[ES] "me duele el pecho" (sin irradiar) + HR 163', () => {
    const result = run('Me duele el pecho', bio({ hr: 163 }));
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-09-COMBINED');
    expect(result.severity).toBe('critical');
    expect(result.matchedEvidence).toContain('dolor toracico');
    expect(result.matchedEvidence).toContain('envelope');
  });

  it('[EN] "my chest hurts" + RR 34', () => {
    const result = run('My chest hurts', bio({ rr: 34 }));
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-09-COMBINED');
    expect(result.action).toBe('advise-911');
  });

  it('sin biometria (null) RF-09 se salta y el dolor de pecho aislado no dispara', () => {
    const result = run('Me duele el pecho', null);
    expect(result.triggered).toBe(false);
  });

  it('sin biometria (null) las reglas de TEXTO siguen funcionando', () => {
    const result = run('Me duele el pecho y se me corre al brazo', null);
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-01-CHEST-PAIN-RADIATING');
  });
});

// =============================================================================
// 2. NEGATIVOS — lo que NO puede disparar
// =============================================================================

describe('Negativos · frases que NO deben disparar', () => {
  const NEGATIVES: ReadonlyArray<[string, string]> = [
    ['me duele un poco la cabeza', 'cefalea leve, ni superlativo ni inicio subito'],
    ['siento el corazón acelerado', 'taquicardia subjetiva con biometria DENTRO del envelope'],
    ['estoy nervioso por el trabajo', 'ansiedad situacional, sin sintoma de alarma'],
    ['no me duele el pecho', 'negacion explicita'],
    ['no me duele el pecho, solo estoy agitado', 'negacion + frontera de oracion'],
    ['sin dolor de pecho ni mareo', '"sin" como pista de negacion'],
    ['me mareé un poco pero no me desmayé', 'negacion tras conjuncion adversativa'],
    ['nunca me he desmayado en mi vida', '"nunca" como pista de negacion'],
    ["I don't have chest pain", 'negacion en ingles, apostrofo normalizado'],
    ['tengo el brazo dormido de dormir mal', 'entumecimiento SIN lateralidad'],
    ['tengo hormigueo en las dos manos', 'parestesia BILATERAL: no es RF-03'],
    ['me falta el aire pero puedo hablar bien', 'hambre de aire, no incapacidad: va al care plan'],
    ['siento que me voy a morir', 'sensacion de muerte inminente = panico, NO ideacion suicida'],
    ['me tiemblan las manos y tengo un nudo en la garganta', 'sintomas de panico de manual'],
    ['no puedo dejar de pensar en el examen de mañana', 'rumiacion, no red-flag'],
    ['me duele la espalda de estar sentado todo el día', 'dolor musculoesqueletico sin pecho'],
    ['estoy sudando frío y con náuseas', 'sintomas asociados SIN dolor toracico: limitacion conocida'],
    ['', 'turno vacio: el STT no cerro nada'],
    ['   ', 'solo espacios'],
  ];

  for (const [phrase, why] of NEGATIVES) {
    it(`no dispara: "${phrase}" (${why})`, () => {
      const result = run(phrase);
      expect(result.triggered).toBe(false);
      expect(result.ruleId).toBeNull();
      expect(result.action).toBeNull();
      expect(result.script).toBeNull();
      expect(result.severity).toBe('none');
    });
  }

  it('biometria normal NO descarta una regla de texto (la inversion logica del brief)', () => {
    // Un paciente con datos perfectos que describe un sintoma cardiaco escala
    // igual. Nunca se infiere "biometria sana -> esto es ansiedad".
    const perfect = bio({ hr: 70, rr: 14, hrv: 55 });
    const result = run('me duele el pecho y se me va al brazo', perfect);
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-01-CHEST-PAIN-RADIATING');
  });
});

// =============================================================================
// 3. BORDES DE RF-08 — los umbrales, exactamente donde duelen
// =============================================================================

describe('RF-08 · bordes de los umbrales', () => {
  it('HR 150 exacto NO dispara (el envelope es > 150)', () => {
    expect(run('todo tranquilo', bio({ hr: 150 })).triggered).toBe(false);
  });

  it('HR 151 SI dispara', () => {
    const result = run('todo tranquilo', bio({ hr: 151 }));
    expect(result.ruleId).toBe('RF-08-BIOMETRIC-ENVELOPE');
    expect(result.matchedEvidence).toBe('heartRate 151 bpm > max 150');
  });

  it('HR 39 dispara por el minimo', () => {
    const result = run('todo tranquilo', bio({ hr: 39, hrPeak: 39 }));
    expect(result.ruleId).toBe('RF-08-BIOMETRIC-ENVELOPE');
    expect(result.matchedEvidence).toBe('heartRate 39 bpm < min 40');
  });

  it('HR 40 exacto NO dispara (el envelope es < 40)', () => {
    expect(run('todo tranquilo', bio({ hr: 40, hrPeak: 40 })).triggered).toBe(false);
  });

  it('RR 33 dispara', () => {
    const result = run('todo tranquilo', bio({ rr: 33 }));
    expect(result.ruleId).toBe('RF-08-BIOMETRIC-ENVELOPE');
    expect(result.matchedEvidence).toBe('respiratoryRate 33 breaths/min > max 32');
  });

  it('RR 32 exacto NO dispara', () => {
    expect(run('todo tranquilo', bio({ rr: 32 })).triggered).toBe(false);
  });

  it('SpO2 92 exacto NO dispara', () => {
    expect(run('todo tranquilo', bio({ spo2: 92 })).triggered).toBe(false);
  });

  it('SpO2 91 dispara', () => {
    expect(run('todo tranquilo', bio({ spo2: 91 })).ruleId).toBe('RF-08-BIOMETRIC-ENVELOPE');
  });

  it('SpO2 ausente en el contrato: la comprobacion se salta sin romper', () => {
    const sinSpo2 = bio({ hr: 100 });
    expect(sinSpo2.spo2).toBeUndefined();
    expect(run('todo tranquilo', sinSpo2).triggered).toBe(false);
  });

  it('HR 0 NO dispara: es un sensor caido, no bradicardia', () => {
    expect(run('todo tranquilo', bio({ hr: 0, hrPeak: 0 })).triggered).toBe(false);
  });

  it('un NaN del wearable no dispara ni revienta', () => {
    expect(run('todo tranquilo', bio({ hr: Number.NaN, hrPeak: Number.NaN })).triggered).toBe(
      false,
    );
  });
});

// =============================================================================
// 4. PRIORIDAD ENTRE REGLAS
// =============================================================================

describe('Prioridad de evaluacion', () => {
  it('RF-09 GANA sobre RF-01 cuando aplican las dos', () => {
    const result = run('Me duele el pecho y se me va al brazo izquierdo', OUTSIDE_ENVELOPE);
    expect(result.triggered).toBe(true);
    expect(result.ruleId).toBe('RF-09-COMBINED');
    expect(result.severity).toBe('critical');
  });

  it('RF-01 gana sobre RF-08 cuando la biometria esta dentro del envelope', () => {
    const result = run('Me duele el pecho y se me va al brazo', INSIDE_ENVELOPE);
    expect(result.ruleId).toBe('RF-01-CHEST-PAIN-RADIATING');
  });

  it('una regla de texto gana sobre RF-08 (RF-08 se evalua la ultima)', () => {
    const result = run('Me desmayé hace un momento', OUTSIDE_ENVELOPE);
    expect(result.ruleId).toBe('RF-02-SYNCOPE');
  });

  it('RF-07 gana sobre RF-08 y mantiene la accion 988, no la 911', () => {
    const result = run('quiero matarme', OUTSIDE_ENVELOPE);
    expect(result.ruleId).toBe('RF-07-SELF-HARM');
    expect(result.action).toBe('advise-988');
  });

  it('el orden declarado es RF-09 > RF-01..RF-07 > RF-08', () => {
    const ids = [...RED_FLAG_RULES]
      .sort((a, b) => b.priority - a.priority)
      .map((r) => r.id);
    expect(ids[0]).toBe('RF-09-COMBINED');
    expect(ids[ids.length - 1]).toBe('RF-08-BIOMETRIC-ENVELOPE');
  });
});

// =============================================================================
// 5. PUREZA — el motor es una funcion, no un servicio
// =============================================================================

describe('Pureza y determinismo', () => {
  it('dos llamadas con el mismo input dan un resultado identico (deep equal)', () => {
    const input = {
      transcriptText: 'Me duele el pecho y se me va al brazo izquierdo',
      biometrics: OUTSIDE_ENVELOPE,
      safetyEnvelope: ENVELOPE,
    };
    const first = evaluate(input);
    const second = evaluate(input);
    expect(second).toEqual(first);
  });

  it('cien llamadas seguidas dan siempre el mismo ruleId (sin estado de regex)', () => {
    const ids = new Set<string | null>();
    for (let i = 0; i < 100; i += 1) {
      ids.add(run('No siento el brazo izquierdo').ruleId);
    }
    expect([...ids]).toEqual(['RF-03-UNILATERAL-WEAKNESS']);
  });

  it('no muta la entrada', () => {
    const input = {
      transcriptText: 'Me duele el pecho',
      biometrics: bio({ hr: 163 }),
      safetyEnvelope: { ...ENVELOPE },
    };
    const snapshot = structuredClone(input);
    evaluate(input);
    expect(input).toEqual(snapshot);
  });

  it('el resultado no es un objeto compartido entre llamadas', () => {
    const a = run('hola');
    const b = run('hola');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('el orden de las llamadas no cambia el veredicto', () => {
    const first = run('Me duele el pecho y se me va al brazo');
    run('quiero matarme');
    run('no puedo respirar');
    const again = run('Me duele el pecho y se me va al brazo');
    expect(again).toEqual(first);
  });
});

// =============================================================================
// 6. CONTRATO — IDs, acciones y guiones
// =============================================================================

describe('Contrato del motor', () => {
  it('hay exactamente 9 reglas con los IDs exactos del brief', () => {
    expect(RED_FLAG_RULES).toHaveLength(9);
    expect(RED_FLAG_RULES.map((r) => r.id).sort()).toEqual([
      'RF-01-CHEST-PAIN-RADIATING',
      'RF-02-SYNCOPE',
      'RF-03-UNILATERAL-WEAKNESS',
      'RF-04-SPEECH-FACIAL',
      'RF-05-THUNDERCLAP-HEADACHE',
      'RF-06-DYSPNEA-AT-REST',
      'RF-07-SELF-HARM',
      'RF-08-BIOMETRIC-ENVELOPE',
      'RF-09-COMBINED',
    ]);
  });

  it('RF-07 es la UNICA regla que va a 988; el resto va a 911', () => {
    for (const rule of RED_FLAG_RULES) {
      expect(rule.action).toBe(rule.id === 'RF-07-SELF-HARM' ? 'advise-988' : 'advise-911');
    }
  });

  it('todas las reglas llevan un guion hardcodeado no vacio', () => {
    for (const rule of RED_FLAG_RULES) {
      expect(rule.script.length).toBeGreaterThan(40);
      expect(rule.script).toBe(rule.action === 'advise-988' ? SCRIPT_988 : SCRIPT_911);
    }
  });

  it('el guion del 911 dice el disclosure y manda a colgar', () => {
    expect(SCRIPT_911).toContain('nueve uno uno');
    expect(SCRIPT_911).toContain('cuelga');
    expect(SCRIPT_911.toLowerCase()).toContain('no soy un sustituto de atención de emergencia');
  });

  it('el guion del 988 manda a la linea de crisis, NO al 911', () => {
    expect(SCRIPT_988).toContain('nueve ocho ocho');
    expect(SCRIPT_988).not.toContain('nueve uno uno');
  });

  it('cuando dispara, el resultado trae SIEMPRE ruleId, action, script y evidencia', () => {
    const result = run('Me desmayé');
    expect(result.triggered).toBe(true);
    expect(result.ruleId).not.toBeNull();
    expect(result.action).not.toBeNull();
    expect(result.script).not.toBeNull();
    expect(result.matchedEvidence).not.toBeNull();
    expect(result.severity).not.toBe('none');
  });

  it('el motor sobrevive a un input degenerado sin lanzar', () => {
    const weird = {
      transcriptText: '¡¡¡...---***',
      biometrics: null,
      safetyEnvelope: ENVELOPE,
    };
    expect(() => evaluate(weird)).not.toThrow();
    expect(evaluate(weird).triggered).toBe(false);
  });
});

// =============================================================================
// 7. NORMALIZACION Y NEGACION — los dos ayudantes, testeados aparte
// =============================================================================

describe('normalize()', () => {
  it('quita acentos, baja a minusculas y colapsa espacios', () => {
    expect(normalize('  Me DUELE  el PECHO ')).toBe('me duele el pecho');
    expect(normalize('mandíbula')).toBe('mandibula');
    expect(normalize('opresión torácica')).toBe('opresion toracica');
  });

  it('pega los apostrofos: "don\'t" -> "dont"', () => {
    expect(normalize("I don't have chest pain")).toBe('i dont have chest pain');
  });

  it('convierte la puntuacion en frontera de oracion', () => {
    expect(normalize('me duele, mucho.')).toBe('me duele | mucho |');
  });

  it('es idempotente sobre su propia salida', () => {
    const once = normalize('¿Qué pasa si me duele el pecho?');
    expect(normalize(once)).toBe(once);
  });
});

// =============================================================================
// 8. BATERIA ADVERSARIAL — como habla la gente de verdad
// =============================================================================
//
// Cada caso de esta seccion fue un FALSO NEGATIVO real del motor antes de la
// auditoria adversarial: frases que un paciente diria en una llamada y que el
// motor dejaba pasar al LLM. Estan aqui uno por uno para que cualquier cambio de
// vocabulario futuro que los rompa se vea en la salida de vitest.
//
// Se agrupan por lo que le pasa al lenguaje bajo estres, no por regla:
// coloquialismos, code-switching, habla entrecortada, fraseo indirecto.

describe('Adversarial · coloquialismos y conjugaciones (RF-01)', () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ['se me cierra el pecho y me baja al brazo', 'ES: "se me cierra el pecho"'],
    ['siento como si me apretaran el pecho y me hormiguea la mano izquierda', 'apretaran conjugado + mano'],
    ['tengo un peso en el pecho que se corre al hombro', 'peso toracico'],
    ['me arde el pecho y se me sube a la quijada', 'ardor + quijada'],
    ['siento un peso encima del pecho que me corre hasta la espalda', 'peso + espalda'],
    ['me agarro el pecho, el dolor se me va al cuello', 'descripcion partida en dos oraciones'],
    ['my chest feels tight and it goes down my left arm', 'EN'],
  ];

  for (const [phrase, why] of CASES) {
    it(`dispara RF-01: "${phrase}" (${why})`, () => {
      const result = run(phrase);
      expect(result.triggered).toBe(true);
      expect(result.ruleId).toBe('RF-01-CHEST-PAIN-RADIATING');
      expect(result.action).toBe('advise-911');
    });
  }

  it('code-switching es/en: "me duele el chest y radiates to my arm"', () => {
    // `nova-3 language=multi` mezcla los dos idiomas en la misma frase.
    const result = run('me duele el chest y radiates to my arm');
    expect(result.ruleId).toBe('RF-01-CHEST-PAIN-RADIATING');
  });
});

describe('Adversarial · regionalismos de sincope (RF-02)', () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ['me dio el patatus y desperte en el piso', 'regionalismo caribeño'],
    ['se me nubla todo y me caigo', 'presincope descrito sin la palabra desmayo'],
    ['me quede sin conocimiento un momento', 'variante de "perdi el conocimiento"'],
    ['se me fue la luz un segundo y desperte en el suelo', 'idioma coloquial'],
  ];

  for (const [phrase, why] of CASES) {
    it(`dispara RF-02: "${phrase}" (${why})`, () => {
      expect(run(phrase).ruleId).toBe('RF-02-SYNCOPE');
    });
  }

  it('NO dispara: "se me nubla la vista cuando leo mucho" (sin caida)', () => {
    // La forma "se me nubla" exige una caida acompañandola. Sin ella es
    // astenopia, no sincope.
    expect(run('se me nubla la vista cuando leo mucho').triggered).toBe(false);
  });
});

describe('Adversarial · lateralidad mal fraseada (RF-03)', () => {
  it('dispara: "se me durmio la mitad de la cara"', () => {
    expect(run('se me durmio la mitad de la cara').ruleId).toBe('RF-03-UNILATERAL-WEAKNESS');
  });

  it('dispara: "se me durmio el brazo de este lado nada mas"', () => {
    expect(run('se me durmio el brazo de este lado nada mas').ruleId).toBe(
      'RF-03-UNILATERAL-WEAKNESS',
    );
  });

  it('sigue sin disparar el entumecimiento bilateral o postural', () => {
    expect(run('tengo el brazo dormido de dormir mal').triggered).toBe(false);
    expect(run('tengo hormigueo en las dos manos').triggered).toBe(false);
  });
});

describe('Adversarial · disartria en primera persona (RF-04)', () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ['no me sale hablar bien', 'coloquial'],
    ['estoy hablando raro, se me enreda la lengua', 'gerundio + "se me enreda"'],
    ['se me traba la lengua', 'la forma canonica'],
    ['tengo la boca chueca', 'caida facial coloquial'],
  ];

  for (const [phrase, why] of CASES) {
    it(`dispara RF-04: "${phrase}" (${why})`, () => {
      expect(run(phrase).ruleId).toBe('RF-04-SPEECH-FACIAL');
    });
  }

  it('NO dispara: "no me sale la palabra que busco" (anomia benigna)', () => {
    expect(run('no me sale la palabra que busco').triggered).toBe(false);
  });

  it('NO dispara: "me cuesta hablar de esto contigo"', () => {
    expect(run('me cuesta hablar de esto contigo').triggered).toBe(false);
  });
});

describe('Adversarial · cefalea sin el sintagma exacto (RF-05)', () => {
  it('dispara: "nunca me habia dolido tanto la cabeza, me dio de golpe"', () => {
    // Superlativo indirecto. Empieza por "nunca", que es una pista de negacion:
    // sin la excepcion de `beginsWithNegationCue` se apagaria sola.
    expect(run('nunca me habia dolido tanto la cabeza, me dio de golpe').ruleId).toBe(
      'RF-05-THUNDERCLAP-HEADACHE',
    );
  });

  it('dispara: "me exploto la cabeza de dolor de repente"', () => {
    expect(run('me exploto la cabeza de dolor de repente').ruleId).toBe(
      'RF-05-THUNDERCLAP-HEADACHE',
    );
  });

  it('NO dispara: "nunca me ha dolido la cabeza" (es una negacion, no un superlativo)', () => {
    expect(run('nunca me ha dolido la cabeza').triggered).toBe(false);
  });

  it('NO dispara: "me duele un poco la cabeza"', () => {
    expect(run('me duele un poco la cabeza').triggered).toBe(false);
  });
});

describe('Adversarial · habla entrecortada del panico (RF-06)', () => {
  // ==========================================================================
  //  EL PEOR FALSO NEGATIVO QUE TENIA EL MOTOR
  // ==========================================================================
  // Quien no puede respirar no habla de corrido: repite, se traba y hace pausas.
  // El STT devuelve eso como "no... no puedo... respirar" o "no puedo, respirar",
  // y la normalizacion convierte cada pausa en una frontera de oracion.
  //
  // Dos arreglos lo cubren, y los dos hacen falta:
  //   1. los patrones toleran hasta 5 caracteres de pausa entre "no puedo" y
  //      "respirar" (`[\s|]{0,5}`)
  //   2. un match que YA empieza por una pista de negacion no se somete a la
  //      comprobacion de negacion hacia atras — si no, el primer "no" del
  //      tartamudeo apagaria la regla

  const CASES: ReadonlyArray<[string, string]> = [
    ['no... no puedo... respirar... bien', 'puntos suspensivos del panico'],
    ['no, no puedo respirar', 'muletilla antes del sintoma'],
    ['no puedo, respirar', 'coma del STT partiendo la frase'],
    ['no me pasa el aire', 'variante de "no me entra el aire"'],
    ['me estoy ahogando', 'control positivo'],
  ];

  for (const [phrase, why] of CASES) {
    it(`dispara RF-06: "${phrase}" (${why})`, () => {
      const result = run(phrase);
      expect(result.triggered).toBe(true);
      expect(result.ruleId).toBe('RF-06-DYSPNEA-AT-REST');
      expect(result.action).toBe('advise-911');
    });
  }

  it('[EN] "I cant, breathe" entrecortado tambien dispara', () => {
    expect(run("I can't, breathe").ruleId).toBe('RF-06-DYSPNEA-AT-REST');
  });

  it('la linea disnea/hambre-de-aire NO se movio', () => {
    // Si estas dos empezaran a disparar, toda llamada de panico acabaria en un
    // guion del 911 y el producto dejaria de existir.
    expect(run('me falta el aire pero puedo hablar bien').triggered).toBe(false);
    expect(run('me cuesta respirar un poco').triggered).toBe(false);
  });
});

describe('Adversarial · ideacion indirecta y pasiva (RF-07 → 988)', () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ['creo que ya no quiero estar aqui', 'fraseo indirecto'],
    ['ya no le veo sentido a nada', 'desesperanza sin verbo de intencion'],
    ['ya no aguanto mas, prefiero no despertar', 'ideacion pasiva'],
    ['ya para que sigo, no quiero seguir', 'ideacion pasiva coloquial'],
    ['todos estarian mejor sin mi', 'carga percibida'],
    ['I dont want to be here anymore', 'EN indirecto'],
  ];

  for (const [phrase, why] of CASES) {
    it(`dispara RF-07 → 988: "${phrase}" (${why})`, () => {
      const result = run(phrase);
      expect(result.triggered).toBe(true);
      expect(result.ruleId).toBe('RF-07-SELF-HARM');
      // Lo que no se puede equivocar nunca: crisis suicida va al 988, no al 911.
      expect(result.action).toBe('advise-988');
      expect(result.script).toBe(SCRIPT_988);
    });
  }

  it('NO confunde el rechazo conversacional con ideacion', () => {
    expect(run('no quiero seguir hablando de eso').triggered).toBe(false);
    expect(run('ya no quiero seguir en este trabajo').triggered).toBe(false);
    expect(run('me quiero ir a dormir ya').triggered).toBe(false);
  });

  it('NO confunde la sensacion de muerte inminente con ideacion', () => {
    expect(run('siento que me voy a morir').triggered).toBe(false);
  });
});

describe('Adversarial · la negacion explicita SIGUE apagando las reglas', () => {
  // La excepcion de `beginsWithNegationCue` solo aplica cuando la pista de
  // negacion es parte del propio sintoma ("no puedo respirar"). Todo lo demas
  // se niega igual que antes. Esta es la lista de control.
  const NEGATED: readonly string[] = [
    'no me duele el pecho',
    'no me duele el pecho, solo estoy agitado',
    'sin dolor de pecho ni mareo',
    'nunca me he desmayado en mi vida',
    'me maree un poco pero no me desmaye',
    "I don't have chest pain",
    'no me he desmayado nunca',
  ];

  for (const phrase of NEGATED) {
    it(`sigue sin disparar: "${phrase}"`, () => {
      expect(run(phrase).triggered).toBe(false);
    });
  }
});

// =============================================================================
// 9. CORPUS BENIGNO — el contrapeso de la bateria adversarial
// =============================================================================
//
// Ampliar el vocabulario para cazar coloquialismos abre la puerta al fallo
// contrario: un motor que escala en cada frase y un producto que no existe.
// Este corpus es una llamada de panico completa, turno a turno, mas los dos
// falsos positivos que la ampliacion introdujo y que hubo que corregir.
//
// Regla: si al añadir vocabulario alguna de estas se pone roja, el vocabulario
// esta mal, no el test.

describe('Corpus benigno · una llamada de panico entera, sin escalar', () => {
  const BENIGN: readonly string[] = [
    'hola, estoy mal, me empezó hace como veinte minutos',
    'siento el corazón a mil, como si se me fuera a salir',
    'me tiemblan las manos y tengo un nudo en la garganta',
    'estoy sudando frío y con náuseas',
    'me cuesta respirar un poco pero puedo hablar',
    'me falta el aire, es la ansiedad de siempre',
    'siento que me voy a morir pero sé que no es real',
    'me mareo un poco cuando me levanto rápido',
    'no puedo dejar de pensar en el examen de mañana',
    'me duele un poco la cabeza de tanto llorar',
    'tengo el pecho apretado por la ansiedad',
    'siento presión aquí, en el estómago',
    'me duele la espalda de estar sentado todo el día',
    'me agarro el pecho cuando me río mucho',
    'la mitad de la clase estaba igual que yo',
    'de este lado de la casa hace más frío',
    'estoy hablando mucho, perdón',
    'para qué seguir con el ejercicio si no me funciona',
    'no le veo sentido a esta reunión de mañana',
    'mi mamá me dice que respire pero no puedo concentrarme',
    'sí, hagámoslo, vamos a respirar',
    'como un seis, creo que bajó bastante',
    'y cuánto me va a costar eso con mi seguro',
    'gracias, ya me siento mejor',
    'I feel my heart racing but I can talk fine',
    'my chest feels tight when I am anxious',
  ];

  for (const phrase of BENIGN) {
    it(`no escala: "${phrase}"`, () => {
      expect(run(phrase).triggered).toBe(false);
    });
  }

  it('"me duele la espalda. el pecho está bien" no se lee como un solo síntoma', () => {
    // El punto es una frontera de oracion y ningun patron la cruza sin permiso.
    expect(run('me duele la espalda. el pecho está bien').triggered).toBe(false);
  });

  it('"se me fue la luz anoche por la tormenta" es un apagón, no un síncope', () => {
    expect(run('se me fue la luz de la casa anoche por la tormenta').triggered).toBe(false);
  });

  it('"nunca me ha dolido la cabeza así de poco" no es una cefalea en trueno', () => {
    expect(run('nunca me ha dolido la cabeza así de poco').triggered).toBe(false);
  });
});

describe('isNegated()', () => {
  it('detecta la negacion en la ventana de 5 tokens', () => {
    const text = normalize('no me duele el pecho');
    expect(isNegated(text, text.indexOf('duele'))).toBe(true);
  });

  it('se corta en la frontera de oracion', () => {
    const text = normalize('ya no quiero seguir viviendo, quiero matarme');
    expect(isNegated(text, text.lastIndexOf('quiero matarme'))).toBe(false);
  });

  it('se corta en una conjuncion adversativa', () => {
    const text = normalize('no me duele la cabeza pero me duele el pecho');
    expect(isNegated(text, text.lastIndexOf('duele el pecho'))).toBe(false);
  });

  it('un match al inicio del turno nunca esta negado', () => {
    expect(isNegated('me duele el pecho', 0)).toBe(false);
  });
});
