/**
 * Tests de redaccion de PII.
 *
 * Dos bloques, y el SEGUNDO es el importante:
 *   1. que redacte cada tipo de PII;
 *   2. que NO toque la senal clinica. Un falso positivo aqui ("mi ritmo esta en
 *      118" -> "[TELEFONO]") arruinaria el transcript que se enseña en el demo.
 */

import { describe, expect, it } from 'vitest';

import { PII_MARKERS, redactText, redactTurns, redactWithReport } from '../pii.js';

describe('redactText — telefonos', () => {
  it('redacta un movil espanol con prefijo internacional', () => {
    const out = redactText('mi movil es +34 612 345 678, llamame');
    expect(out).toContain(PII_MARKERS.phone);
    expect(out).not.toMatch(/612/);
  });

  it('redacta un numero mexicano con prefijo internacional', () => {
    const out = redactText('marca al +52 55 1234 5678 si no contesto');
    expect(out).toContain(PII_MARKERS.phone);
    expect(out).not.toMatch(/1234/);
  });

  it('redacta un numero US con parentesis y con guiones', () => {
    expect(redactText('call me at (415) 555-0132')).toContain(PII_MARKERS.phone);
    expect(redactText('my number is 415-555-0132')).toContain(PII_MARKERS.phone);
  });

  it('redacta un bloque contiguo de 9 a 12 digitos', () => {
    const out = redactText('anota 612345678 por favor');
    expect(out).toBe(`anota ${PII_MARKERS.phone} por favor`);
  });

  it('redacta un numero dictado con espacios cuando hay palabra-pista', () => {
    const out = redactText('mi telefono es 612 345 678');
    expect(out).toContain(PII_MARKERS.phone);
    expect(out).not.toMatch(/345/);
  });
});

describe('redactText — email, tarjetas e identificadores', () => {
  it('redacta un email', () => {
    expect(redactText('escribeme a alex.rivera+loop@gmail.com')).toBe(
      `escribeme a ${PII_MARKERS.email}`,
    );
  });

  it('redacta una tarjeta de 16 digitos con y sin espacios', () => {
    expect(redactText('la tarjeta es 4111 1111 1111 1111')).toContain(PII_MARKERS.id);
    expect(redactText('la cuenta es 4111111111111111')).toContain(PII_MARKERS.id);
  });

  it('redacta CURP, DNI y SSN', () => {
    expect(redactText('mi curp es RIVA910312HDFVLX09')).toContain(PII_MARKERS.id);
    expect(redactText('el dni 12345678Z')).toContain(PII_MARKERS.id);
    expect(redactText('ssn 123-45-6789')).toContain(PII_MARKERS.id);
  });

  it('redacta un identificador con palabra-pista y conserva la pista', () => {
    const out = redactText('mi poliza es PPO88123');
    expect(out).toBe(`mi poliza es ${PII_MARKERS.id}`);
  });

  it('NO redacta una palabra normal detras de la pista (necesita digitos)', () => {
    expect(redactText('mi expediente medico esta en la clinica')).toBe(
      'mi expediente medico esta en la clinica',
    );
  });
});

describe('redactText — fechas de nacimiento', () => {
  it('redacta una fecha de nacimiento en formato largo y conserva la pista', () => {
    const out = redactText('naci el 12 de marzo de 1990');
    expect(out).toContain(PII_MARKERS.date);
    expect(out).toMatch(/^naci el /);
    expect(out).not.toMatch(/1990/);
  });

  it('redacta una fecha de nacimiento numerica', () => {
    const out = redactText('mi fecha de nacimiento es 03/12/1990');
    expect(out).toBe(`mi fecha de nacimiento es ${PII_MARKERS.date}`);
  });

  it('redacta el ano cuando la pista es explicita', () => {
    expect(redactText('naci en 1990')).toBe(`naci en ${PII_MARKERS.date}`);
  });
});

describe('redactText — direcciones', () => {
  it('redacta una direccion con "numero"', () => {
    const out = redactText('vivo en calle Reforma numero 45');
    expect(out).toBe(`vivo en ${PII_MARKERS.address}`);
  });

  it('redacta una avenida con numero pegado', () => {
    expect(redactText('estoy en avenida Insurgentes 300')).toContain(PII_MARKERS.address);
  });

  it('redacta una direccion en ingles', () => {
    expect(redactText('I live at 123 Main Street')).toContain(PII_MARKERS.address);
  });
});

describe('redactText — NO rompe la senal clinica (bloque critico)', () => {
  const clinical = [
    'mi ritmo esta en 118',
    'llevo 3 dias sin dormir',
    'me tome 50 miligramos',
    'mi hrv bajo a 21 y mi respiracion esta en 24',
    'del cero al diez, como un 6',
  ];

  for (const phrase of clinical) {
    it(`deja intacto: "${phrase}"`, () => {
      expect(redactText(phrase)).toBe(phrase);
    });
  }

  it('deja intacta una secuencia de lecturas biometricas separadas por comas', () => {
    const phrase = 'mi frecuencia fue 118, luego 122 y llego a 126';
    expect(redactText(phrase)).toBe(phrase);
  });

  it('NO confunde "calle" en lenguaje natural con una direccion', () => {
    const phrase = 'estoy en la calle y llevo 3 dias sin dormir';
    expect(redactText(phrase)).toBe(phrase);
  });

  it('deja intacta la frase de contextualizacion del agente', () => {
    const phrase =
      'Tu ritmo cardiaco esta en 118 y tu promedio es 68, asi que tu cuerpo esta muy activado ahora mismo.';
    expect(redactText(phrase)).toBe(phrase);
  });

  it('deja intacto el guion de respiracion de caja', () => {
    const phrase = 'Inhala cuatro tiempos: 1, 2, 3, 4. Sosten 4 tiempos.';
    expect(redactText(phrase)).toBe(phrase);
  });
});

describe('redactText — propiedades generales', () => {
  it('es idempotente', () => {
    const once = redactText('llamame al +34 612 345 678 o a alex@loop.health');
    expect(redactText(once)).toBe(once);
  });

  it('devuelve el texto sin cambios cuando no hay PII', () => {
    const phrase = 'no puedo respirar bien, el corazon se me va a salir';
    expect(redactText(phrase)).toBe(phrase);
  });

  it('tolera cadena vacia', () => {
    expect(redactText('')).toBe('');
  });

  it('informa que reglas dispararon sin filtrar el texto original', () => {
    const report = redactWithReport('escribeme a alex@loop.health o marca al 5512345678');
    const ruleIds = report.hits.map((hit) => hit.ruleId);
    expect(ruleIds).toContain('EMAIL');
    expect(ruleIds).toContain('PHONE_PLAIN');
    expect(JSON.stringify(report.hits)).not.toContain('alex@loop.health');
    expect(JSON.stringify(report.hits)).not.toContain('5512345678');
  });
});

describe('redactTurns', () => {
  const turns = [
    { speaker: 'patient' as const, at: '2026-08-01T18:20:05Z', text: 'mi ritmo esta en 118' },
    { speaker: 'agent' as const, at: '2026-08-01T18:20:11Z', text: 'anoto tu telefono 612345678' },
  ];

  it('redacta el texto y conserva speaker y at', () => {
    const out = redactTurns(turns);
    expect(out[0]).toEqual({
      speaker: 'patient',
      at: '2026-08-01T18:20:05Z',
      text: 'mi ritmo esta en 118',
    });
    expect(out[1]!.speaker).toBe('agent');
    expect(out[1]!.at).toBe('2026-08-01T18:20:11Z');
    expect(out[1]!.text).toContain(PII_MARKERS.phone);
  });

  it('no muta el array de entrada', () => {
    redactTurns(turns);
    expect(turns[1]!.text).toBe('anoto tu telefono 612345678');
  });
});
