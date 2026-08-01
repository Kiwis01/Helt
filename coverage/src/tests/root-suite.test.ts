/**
 * Puente para que `npm test` no se deje tests fuera.
 *
 * El script es `tsx --test src/**​/*.test.ts`, y npm lo ejecuta con `/bin/sh`,
 * que no tiene `globstar`: ahí `**` vale exactamente lo mismo que `*`, así que
 * el patrón real acaba siendo `src/*​/*.test.ts` — un solo nivel de
 * profundidad. Los tests que viven en la raíz de `src/` no se ejecutarían.
 *
 * `coverage/package.json` es de solo lectura para esta sesión, así que el
 * arreglo vive aquí: este archivo SÍ está a la profundidad que el patrón
 * alcanza, e importar un módulo de test registra sus casos en este proceso.
 *
 * Si algún día se corrige el script a `tsx --test --experimental-test-isolation`
 * o a un patrón que node expanda por su cuenta, este archivo sobra.
 */

import './../voice-summary.test.js';
import './../mock.test.js';
import './../env-file.test.js';
import './../config.test.js';
