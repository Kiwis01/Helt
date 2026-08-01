/**
 * Auditor de idioma del proyecto de Medplum. **Ejecútalo después de sembrar.**
 *
 * ## Para qué sirve hoy
 *
 * El equipo vuelve a sembrar los pacientes en inglés. Este script es la
 * comprobación de que la siembra quedó COMPLETA: recorre los campos de texto
 * libre de los recursos que el dashboard pinta y lista todo lo que siga en
 * español. Un solo `Hipertensión` en un `Condition.code.text` aparece en la
 * primera pantalla del demo, y revisando a ojo se escapa.
 *
 *   npx tsx scripts/medplum-i18n.ts
 *
 * Salida esperada tras una siembra correcta:
 *   "No queda español pendiente en los campos revisados."
 *
 * Si algo se escapó, lo lista con su recurso y su ruta, y además escribe las
 * cadenas en `medplum-strings.json` con la traducción en blanco.
 *
 * ## El modo de traducción (--apply)
 *
 * Existe por si hay que arreglar una siembra en caliente en vez de repetirla:
 * rellena las traducciones en `medplum-strings.json` y ejecuta
 *
 *   npx tsx scripts/medplum-i18n.ts --apply
 *
 * Reemplaza por CADENA COMPLETA y coincidencia exacta, nunca por subcadena
 * (ver `DICT_DEPRECADO` para el porqué). Prefiere repetir la siembra: escribir
 * sobre un proyecto compartido en mitad de un hackathon es la clase de cosa
 * que sale mal mientras otro está mirando la pantalla.
 *
 * Ambos modos vuelcan SIEMPRE un respaldo JSON de los recursos tal y como
 * estaban, en `dashboard/.medplum-backup/` (ignorado por git: son datos del
 * proyecto, no código). Es la única vuelta atrás que hay.
 *
 * ## Qué NO toca
 *
 * - Nombres de personas (pacientes). Un nombre propio no se traduce.
 * - Códigos: LOINC, SNOMED, RxNorm, ICD. Son el estándar y el dashboard los
 *   usa para mapear rangos de referencia; cambiarlos rompería el expediente.
 * - Fechas, identificadores, referencias entre recursos.
 *
 * Solo se tocan campos de TEXTO LIBRE que un humano lee en pantalla.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MedplumClient } from '@medplum/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

/* ================================================================== */
/* Credenciales                                                        */
/* ================================================================== */

/** Lee el .env de la raíz sin depender de `server-only` (que exige Next). */
function loadEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(REPO, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

const baseUrl = (process.env.MEDPLUM_BASE_URL ?? 'https://api.medplum.com').replace(/\/+$/, '');
const clientId = (process.env.MEDPLUM_CLIENT_ID ?? '').trim();
const clientSecret = (process.env.MEDPLUM_CLIENT_SECRET ?? '').trim();

if (clientId === '' || clientSecret === '') {
  console.error('Faltan MEDPLUM_CLIENT_ID / MEDPLUM_CLIENT_SECRET en el .env de la raíz.');
  process.exit(1);
}

/* ================================================================== */
/* Diccionario                                                         */
/* ================================================================== */

/**
 * NO SE USA — se conserva como aviso.
 *
 * Primer intento: sustituir SUBCADENAS. Produce Spanglish, que en pantalla se
 * lee como un fallo y no como una decisión:
 *
 *   "1 tableta en la mañana y 1 en la noche — dosis dividida desde el 25-jul"
 *   -> "1 tablet in the morning y 1 en la noche — dosis dividida desde…"
 *
 * El reemplazo correcto es por CADENA COMPLETA y coincidencia exacta: o se
 * traduce entera o se deja intacta, nunca a medias. `TRANSLATIONS` (cargado de
 * `medplum-strings.json`) hace eso; esto se queda documentando por qué.
 */
const DICT_DEPRECADO: ReadonlyArray<readonly [string, string]> = [
  // --- condiciones ---
  ['Diabetes tipo 2', 'Type 2 diabetes'],
  ['Diabetes mellitus tipo 2', 'Type 2 diabetes mellitus'],
  ['Hipertensión arterial', 'Hypertension'],
  ['Hipertensión', 'Hypertension'],
  ['Colesterol alto', 'High cholesterol'],
  ['Hipercolesterolemia', 'Hypercholesterolemia'],
  ['Asma', 'Asthma'],
  ['Trastorno de ansiedad', 'Anxiety disorder'],
  ['Ansiedad', 'Anxiety'],
  ['Obesidad', 'Obesity'],
  ['Depresión', 'Depression'],

  // --- descripciones de cita ---
  ['Seguimiento diabetes + revisión de salpullido', 'Diabetes follow-up + rash review'],
  ['Seguimiento diabetes', 'Diabetes follow-up'],
  ['Control de presión y colesterol + revisión de medicación', 'BP and cholesterol check + medication review'],
  ['Control de presión y colesterol', 'BP and cholesterol check'],
  ['Control de asma + técnica de inhalador', 'Asthma check + inhaler technique'],
  ['Control de asma', 'Asthma check'],
  ['revisión de medicación', 'medication review'],
  ['revisión de salpullido', 'rash review'],
  ['Consulta de seguimiento', 'Follow-up visit'],
  ['Primera consulta', 'Initial visit'],
  ['Control', 'Check'],
  ['Seguimiento', 'Follow-up'],

  // --- medicación: pauta posológica ---
  ['1 tableta con el desayuno y 1 tableta con la cena', '1 tablet with breakfast and 1 tablet with dinner'],
  ['1 tableta diaria en la mañana', '1 tablet daily in the morning'],
  ['1 tableta diaria por la noche', '1 tablet daily at night'],
  ['dosis aumentada de', 'dose increased from'],
  ['tableta', 'tablet'],
  ['tabletas', 'tablets'],
  ['cápsula', 'capsule'],
  ['diaria', 'daily'],
  ['con el desayuno', 'with breakfast'],
  ['con la cena', 'with dinner'],
  ['en la mañana', 'in the morning'],
  ['por la noche', 'at night'],
  ['Metformina', 'Metformin'],
  ['Salbutamol', 'Albuterol'],
  ['Sertralina', 'Sertraline'],

  // --- documentos y notas ---
  ['Química sanguínea de 6 elementos', 'Basic metabolic panel'],
  ['Química sanguínea', 'Blood chemistry'],
  ['Biometría hemática', 'Complete blood count'],
  ['Laboratorio Central', 'Central Laboratory'],
  ['Perfil de lípidos', 'Lipid panel'],
  ['Nota de evolución', 'Progress note'],

  // --- signos vitales y laboratorio ---
  ['Presión sistólica', 'Systolic BP'],
  ['Presión diastólica', 'Diastolic BP'],
  ['Frecuencia cardiaca', 'Heart rate'],
  ['Frecuencia cardíaca', 'Heart rate'],
  ['Colesterol LDL', 'LDL cholesterol'],
  ['Colesterol HDL', 'HDL cholesterol'],
  ['Hemoglobina A1c', 'Hemoglobin A1c'],
  ['Hemoglobina glucosilada', 'Hemoglobin A1c'],
  ['Glucosa', 'Glucose'],
  ['Peso', 'Weight'],
  ['Talla', 'Height'],

  // --- tratamiento y roles ---
  ['Dra.', 'Dr.'],
  ['Dr.', 'Dr.'],
  ['Médico tratante', 'Attending physician'],
  ['Médico general', 'General practitioner'],
  ['Enfermera', 'Nurse'],
  ['Equipo de cuidado', 'Care team'],
];

/* ================================================================== */
/* Mapa de cadenas completas                                           */
/* ================================================================== */

const MAP_FILE = resolve(HERE, 'medplum-strings.json');

/**
 * Mapa `original -> traducción`, por CADENA COMPLETA.
 *
 * Se carga de disco en vez de vivir aquí porque lo produce un paso aparte
 * (extracción -> traducción -> revisión) y así queda versionado y auditable:
 * cualquiera puede leer el diff y ver exactamente qué se le va a cambiar a un
 * proyecto de Medplum compartido, antes de que se le cambie.
 */
function loadTranslations(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(MAP_FILE, 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      // Una entrada vacía significa "revisada y se deja como está". Sirve para
      // dejar constancia de que no se olvidó, no de que no se pudo.
      if (typeof v === 'string' && v.trim() !== '' && v !== k) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

const TRANSLATIONS = loadTranslations();

/**
 * Traduce por coincidencia EXACTA de la cadena completa.
 *
 * Sin normalizar espacios ni mayúsculas a propósito: si una cadena difiere en
 * un espacio, prefiero que aparezca como pendiente en el informe a que se
 * traduzca por aproximación y nadie lo revise.
 */
function translate(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const hit = TRANSLATIONS[value.trim()];
  return hit !== undefined && hit !== value ? hit : null;
}

/**
 * ¿Parece español?
 *
 * **Esta heurística ya falló una vez y por eso existe `--all`.** Marcaba por
 * acentos o por palabras funcionales, y `"Diabetes tipo 2"` no tiene ninguna
 * de las dos: pasó la auditoría como si estuviera en inglés y llegó a la
 * primera pantalla del demo. Lo mismo vale para `Asma`, `Colesterol alto` o
 * cualquier término clínico que se escriba igual en los dos idiomas salvo por
 * una palabra.
 *
 * Se conserva porque en el modo por defecto reduce el ruido, pero la auditoría
 * de verdad —la que se corre antes del demo— es `--all`, que no filtra nada y
 * obliga a mirar la lista completa. Un detector que se equivoca en silencio es
 * peor que no tener detector.
 */
function looksSpanish(value: string): boolean {
  if (/[áéíóúÁÉÍÓÚñÑ¿¡]/.test(value)) return true;
  if (/(^|\s)(de|del|con|por|la|el|los|las|un|una|en|sin|para|y|sobre|tipo)(\s|$)/i.test(value)) {
    return true;
  }
  // Terminología que se cuela sin tilde ni palabra funcional.
  return /\b(diabetes tipo|asma|colesterol|presion|sangre|orina|suero|higado|rinon|tableta|inhalacion|dosis|control|seguimiento|revision|consulta|cita|paciente|medico|enfermera|hombre|mujer)\b/i.test(
    value,
  );
}

/* ================================================================== */
/* Recorrido de recursos                                               */
/* ================================================================== */

interface Change {
  resourceType: string;
  id: string;
  path: string;
  from: string;
  to: string;
}

/**
 * Campos de texto libre por tipo de recurso.
 *
 * Se enumeran explícitamente en vez de recorrer el objeto entero buscando
 * cadenas: un recorrido ciego tocaría `system`, `reference`, `unit` y los
 * `code`, que NO se traducen y cuyo cambio rompería el expediente.
 */
const TEXT_PATHS: Record<string, readonly string[]> = {
  Condition: ['code.text', 'code.coding.*.display', 'note.*.text'],
  Appointment: ['description', 'comment', 'patientInstruction'],
  MedicationRequest: [
    'medicationCodeableConcept.text',
    'medicationCodeableConcept.coding.*.display',
    'dosageInstruction.*.text',
    'dosageInstruction.*.patientInstruction',
    'note.*.text',
  ],
  /* Las UNIDADES son texto visible aunque no lo parezcan: el panel de
     laboratorio las pinta pegadas al valor ("27 seg"), y una unidad en español
     al lado de una cifra canta más que una etiqueta, porque está en el sitio
     donde el ojo va primero. Se añadieron después de ver "27 seg" en una
     captura: la primera versión solo miraba nombres. */
  Observation: [
    'code.text',
    'code.coding.*.display',
    'note.*.text',
    'valueQuantity.unit',
    'valueCodeableConcept.text',
    'valueCodeableConcept.coding.*.display',
    'valueString',
    'component.*.valueQuantity.unit',
    'component.*.code.text',
    'component.*.code.coding.*.display',
    'referenceRange.*.low.unit',
    'referenceRange.*.high.unit',
    'referenceRange.*.text',
    'interpretation.*.text',
    'interpretation.*.coding.*.display',
  ],
  DocumentReference: ['description', 'type.text', 'type.coding.*.display', 'content.*.attachment.title'],
  ServiceRequest: ['code.text', 'code.coding.*.display', 'note.*.text', 'patientInstruction'],
  AllergyIntolerance: ['code.text', 'code.coding.*.display', 'note.*.text'],
  CareTeam: ['name', 'note.*.text'],
  Practitioner: ['name.*.prefix.*', 'name.*.text'],
};

/** Lee/escribe una ruta con comodín `*` sobre arrays. */
function walk(
  node: unknown,
  parts: readonly string[],
  visit: (parent: Record<string, unknown> | unknown[], key: string | number, value: string) => void,
): void {
  if (node === null || typeof node !== 'object') return;
  const [head, ...rest] = parts;

  if (head === '*') {
    if (!Array.isArray(node)) return;
    node.forEach((_, i) => {
      if (rest.length === 0) {
        const v = node[i];
        if (typeof v === 'string') visit(node, i, v);
      } else {
        walk(node[i], rest, visit);
      }
    });
    return;
  }

  const obj = node as Record<string, unknown>;
  if (rest.length === 0) {
    const v = obj[head];
    if (typeof v === 'string') visit(obj, head, v);
    return;
  }
  walk(obj[head], rest, visit);
}

/* ================================================================== */
/* Principal                                                           */
/* ================================================================== */

const APPLY = process.argv.includes('--apply');

/**
 * Vuelca TODAS las cadenas, no solo las que la heurística cree españolas.
 *
 * Es el modo que hay que correr antes del demo: la lista es de decenas de
 * entradas, se lee en un minuto, y no depende de que un regex acierte.
 */
const ALL = process.argv.includes('--all');

/**
 * Lee TODOS los recursos de un tipo, paginando.
 *
 * La primera versión pedía `_count: 200` y se quedaba ahí. Con 200+
 * Observations eso significaba auditar una muestra y creer que era el total:
 * al traducir las 200 primeras, la siguiente ejecución destapó doce cadenas
 * nuevas —CORTISOL EN SUERO, CILINDROS PATOLÓGICOS— que nunca habían estado en
 * ningún informe. Un auditor que solo mira una parte y dice "no queda nada" es
 * peor que no tener auditor, porque genera confianza injustificada.
 *
 * El tope de 5000 es una guarda contra un bucle infinito si el servidor
 * ignorara `_offset`, no un límite de negocio.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Escribe un recurso aguantando el limitador de tasa de Medplum.
 *
 * Medplum corta con `Too Many Requests` a los 50.000 puntos y devuelve en el
 * cuerpo `_msBeforeNext`: cuánto falta para que la ventana se reabra. La
 * primera versión escribía en bucle cerrado y perdía ~600 escrituras de golpe,
 * dejando el expediente MEDIO traducido — el peor estado posible, porque
 * parece que terminó.
 *
 * Se respeta el tiempo que pide el servidor en vez de un backoff inventado: es
 * el único número que sabe cuándo va a dejar de rechazar.
 */
async function writeWithRetry(
  medplum: MedplumClient,
  resource: Record<string, unknown>,
  resourceType: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await medplum.updateResource(resource as never);
      return true;
    } catch (error) {
      const message = (error as Error).message ?? '';
      const rateLimited = /too many requests|429/i.test(message);
      if (!rateLimited) {
        console.error(`  ! ${resourceType}/${resource.id}: ${message.slice(0, 120)}`);
        return false;
      }
      const hinted = Number(/"_msBeforeNext":(\d+)/.exec(message)?.[1] ?? 0);
      const waitMs = Math.max(hinted + 500, 2000 * (attempt + 1));
      process.stdout.write(`\r  limitado por tasa, esperando ${Math.ceil(waitMs / 1000)}s…   `);
      await sleep(waitMs);
    }
  }
  console.error(`  ! ${resourceType}/${resource.id}: agotados los reintentos`);
  return false;
}

async function readAll(
  medplum: MedplumClient,
  resourceType: string,
): Promise<Record<string, unknown>[]> {
  const PAGE = 100;
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 5000; offset += PAGE) {
    const batch = (await medplum.searchResources(
      resourceType as never,
      { _count: PAGE, _offset: offset } as never,
    )) as unknown as Record<string, unknown>[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

async function main() {
  const medplum = new MedplumClient({ baseUrl, clientId, clientSecret, cacheTime: 0 });
  await medplum.startClientLogin(clientId, clientSecret);

  const backup: Record<string, unknown[]> = {};
  const changes: Change[] = [];
  const untouched: string[] = [];
  /** Cadenas en español sin entrada en el mapa. Salen a disco para traducirlas. */
  const pending = new Set<string>();
  /** Recursos que no se pudieron escribir ni tras los reintentos. */
  const failures: string[] = [];

  for (const [resourceType, paths] of Object.entries(TEXT_PATHS)) {
    let resources: Record<string, unknown>[];
    try {
      resources = await readAll(medplum, resourceType);
    } catch (error) {
      console.log(`  ${resourceType}: no se pudo leer (${(error as Error).message})`);
      continue;
    }

    backup[resourceType] = JSON.parse(JSON.stringify(resources));
    let touched = 0;

    for (const resource of resources) {
      let dirty = false;

      for (const path of paths) {
        walk(resource, path.split('.'), (parent, key, value) => {
          const next = translate(value);
          if (next !== null) {
            changes.push({
              resourceType,
              id: String(resource.id),
              path,
              from: value,
              to: next,
            });
            (parent as Record<string | number, unknown>)[key] = next;
            dirty = true;
          } else if (ALL || looksSpanish(value)) {
            pending.add(value.trim());
            untouched.push(`${resourceType} ${path}: "${value}"`);
          }
        });
      }

      if (dirty && APPLY) {
        const ok = await writeWithRetry(medplum, resource, resourceType);
        if (!ok) failures.push(`${resourceType}/${resource.id}`);
      }
      if (dirty) touched += 1;
    }

    console.log(`  ${resourceType.padEnd(20)} ${resources.length} recursos, ${touched} con cambios`);
  }

  // El respaldo se escribe SIEMPRE, también en modo inventario: es el estado
  // previo, y solo sirve si existe antes de la primera escritura.
  const dir = resolve(HERE, '../.medplum-backup');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `backup-${process.env.LOOP_STAMP ?? 'latest'}.json`);
  writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');

  console.log(`\nRespaldo: ${file}`);
  console.log(`Cambios ${APPLY ? 'APLICADOS' : 'detectados (simulacro)'}: ${changes.length}`);
  if (failures.length > 0) {
    console.log(`ESCRITURAS FALLIDAS: ${failures.length} — vuelve a ejecutar --apply (es idempotente)`);
  }

  for (const c of changes.slice(0, 60)) {
    console.log(`  ${c.resourceType}.${c.path}`);
    console.log(`    - ${c.from}`);
    console.log(`    + ${c.to}`);
  }
  if (changes.length > 60) console.log(`  … y ${changes.length - 60} más`);

  /* Las cadenas pendientes salen SIEMPRE a disco, ordenadas y con la
     traducción en blanco, para que el paso de traducción tenga un fichero
     concreto que rellenar y el diff de git enseñe exactamente qué se decidió. */
  if (pending.size > 0) {
    const existing = (() => {
      try {
        return JSON.parse(readFileSync(MAP_FILE, 'utf8')) as Record<string, string>;
      } catch {
        return {};
      }
    })();
    const merged: Record<string, string> = { ...existing };
    for (const s of [...pending].sort((a, b) => a.localeCompare(b, 'es'))) {
      if (merged[s] === undefined) merged[s] = '';
    }
    writeFileSync(MAP_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    console.log(`\nPENDIENTES DE TRADUCIR: ${pending.size} cadenas`);
    console.log(`Escritas (con valor vacío) en: ${MAP_FILE}`);
    for (const u of [...new Set(untouched)].slice(0, 25)) console.log(`  ${u}`);
    if (untouched.length > 25) console.log(`  … y ${untouched.length - 25} apariciones más`);
  } else {
    console.log('\nNo queda español pendiente en los campos revisados.');
  }

  if (!APPLY) console.log('\nSimulacro. Repite con --apply para escribir.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
