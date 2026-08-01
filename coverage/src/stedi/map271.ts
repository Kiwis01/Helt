/**
 * 271 → hechos de cobertura. Función pura, cero I/O.
 *
 * Junto con `client.ts` es el único lugar del repo que sabe cómo luce un 271.
 * Fuera de `src/stedi/` nadie ve un `benefitsInformation` ni un código EB01.
 *
 * REGLA DE ORO: este módulo NUNCA lanza. Los payloads EDI reales casi nunca
 * vienen como uno espera — falta un segmento, un monto llega como string con
 * "$", el pagador manda un array donde debería haber un objeto. Cada campo que
 * no se pueda leer con certeza sale como `null`, y el `voiceSummary` lo dirá.
 * Reventar aquí significaría un 500 en mitad de una llamada de voz.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ASUNCIÓN (toda esta sección): no hay credenciales de Stedi en este entorno,
 * así que la forma del payload está escrita contra la documentación pública de
 * la Real-Time Eligibility Check API de Stedi Healthcare, que devuelve el 271
 * ya deserializado a JSON (no EDI crudo) con esta estructura:
 *
 *   {
 *     "meta": { "traceId": "..." },
 *     "controlNumber": "000000001",
 *     "payer":  { "name": "...", "payorIdentification": "..." },
 *     "planInformation": { "groupNumber": "...", "groupDescription": "..." },
 *     "planStatus": [ { "statusCode": "1", "status": "Active Coverage" } ],
 *     "benefitsInformation": [ {
 *        "code": "B",                  // EB01
 *        "name": "Co-Payment",
 *        "serviceTypeCodes": ["A4"],   // EB03
 *        "coverageLevelCode": "IND",   // EB02
 *        "timeQualifierCode": "27",    // EB06
 *        "benefitAmount": "25",        // EB07, en DÓLARES
 *        "benefitPercent": "0.2",      // EB08, como FRACCIÓN
 *        "authOrCertIndicator": "Y",   // EB11
 *        "inPlanNetworkIndicatorCode": "Y",
 *        "planCoverage": "PPO Silver"  // EB05
 *     } ],
 *     "errors": [ { "code": "...", "description": "..." } ]
 *   }
 *
 * Si la forma real difiere, el único archivo a tocar es este. Ver la sección
 * "Qué verificar cuando llegue la API key de Stedi" del README.
 * ─────────────────────────────────────────────────────────────────────
 */

/* ------------------------------------------------------------------ */
/* Códigos X12 que nos importan                                        */
/* ------------------------------------------------------------------ */

/** EB01 — Eligibility or Benefit Information. */
const EB01 = {
  activeCoverage: '1',
  coinsurance: 'A',
  copayment: 'B',
  deductible: 'C',
  inactive: '6',
  inactivePendingInvestigation: '7',
  inactiveAgent: '8',
  nonCovered: 'I',
  cannotProcess: 'V',
} as const;

/** EB06 — Time Period Qualifier. Solo los que usamos para el deducible. */
const EB06 = {
  calendarYear: '23',
  remaining: '29',
  yearToDate: '25',
} as const;

/** EB03 — "30" = Health Benefit Plan Coverage, el cajón de sastre del 271. */
const SERVICE_TYPE_GENERIC = '30';

/** Cualquiera de estos significa "la póliza no está vigente". */
const INACTIVE_CODES: readonly string[] = [
  EB01.inactive,
  EB01.inactivePendingInvestigation,
  EB01.inactiveAgent,
];

/* ------------------------------------------------------------------ */
/* Salida                                                              */
/* ------------------------------------------------------------------ */

export interface MappedDeductible {
  individualCents: number;
  metCents: number;
  remainingCents: number;
}

/**
 * Subconjunto del Contrato 3 que se puede derivar del 271. Los campos que
 * pone el servicio (checkId, checkedAt, latencyMs, voiceSummary) no viven aquí.
 */
export interface Mapped271 {
  status: 'covered' | 'not-covered' | 'needs-auth' | 'unknown';
  payerName: string;
  planName: string | null;
  copayCents: number | null;
  coinsurancePercent: number | null;
  deductible: MappedDeductible | null;
  priorAuthRequired: boolean | null;
  raw271Id: string | null;
}

export interface Map271Options {
  /** Código X12 de service type que se pidió en el 270 (EQ01), ej. "A4". */
  x12ServiceTypeCode?: string;
  /** Nombre del pagador a usar si el 271 no lo trae. */
  fallbackPayerName?: string;
}

/** Lo que devuelve el mapper cuando no hay nada de lo que fiarse. */
export function unknownFacts(payerName = 'Unknown'): Mapped271 {
  return {
    status: 'unknown',
    payerName,
    planName: null,
    copayCents: null,
    coinsurancePercent: null,
    deductible: null,
    priorAuthRequired: null,
    raw271Id: null,
  };
}

/* ------------------------------------------------------------------ */
/* Accesores tolerantes                                                */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Strings vacíos y espacios cuentan como ausencia: EDI los usa como relleno. */
function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asStringArray(value: unknown): string[] {
  return asArray(value)
    .map(asString)
    .filter((item): item is string => item !== null);
}

function get(record: Record<string, unknown> | null, key: string): unknown {
  return record === null ? undefined : record[key];
}

/**
 * EB07 llega en DÓLARES como string. Puede traer "$", comas o decimales.
 * "1,234.50" → 123450.
 */
export function dollarsToCents(value: unknown): number | null {
  const raw = asString(value);
  if (raw === null) return null;
  const cleaned = raw.replace(/[$,\s]/g, '');
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

/**
 * EB08 llega como fracción ("0.2" = 20%). ASUNCIÓN.
 * Si el valor viene > 1 se asume que ya está en puntos porcentuales, que es lo
 * que hacen algunos pagadores; así el mapper aguanta las dos convenciones.
 */
export function toCoinsurancePercent(value: unknown): number | null {
  const raw = asString(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const percent = parsed <= 1 ? parsed * 100 : parsed;
  if (percent > 100) return null;
  return Math.round(percent * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Normalización de benefitsInformation                                */
/* ------------------------------------------------------------------ */

interface Benefit {
  code: string | null;
  serviceTypeCodes: string[];
  coverageLevelCode: string | null;
  timeQualifierCode: string | null;
  timeQualifier: string | null;
  benefitAmountCents: number | null;
  benefitPercent: number | null;
  planCoverage: string | null;
  authRequired: boolean | null;
  inNetwork: boolean | null;
}

function normalizeBenefit(value: unknown): Benefit | null {
  const record = asRecord(value);
  if (record === null) return null;

  const authIndicator = asString(get(record, 'authOrCertIndicator'));
  const networkIndicator = asString(get(record, 'inPlanNetworkIndicatorCode'));

  return {
    code: asString(get(record, 'code')),
    serviceTypeCodes: asStringArray(get(record, 'serviceTypeCodes')),
    coverageLevelCode: asString(get(record, 'coverageLevelCode')),
    timeQualifierCode: asString(get(record, 'timeQualifierCode')),
    timeQualifier: asString(get(record, 'timeQualifier')),
    benefitAmountCents: dollarsToCents(get(record, 'benefitAmount')),
    benefitPercent: toCoinsurancePercent(get(record, 'benefitPercent')),
    planCoverage: asString(get(record, 'planCoverage')),
    authRequired: authIndicator === null ? null : authIndicator.toUpperCase() === 'Y',
    inNetwork: networkIndicator === null ? null : networkIndicator.toUpperCase() === 'Y',
  };
}

/**
 * Quédate con los beneficios que hablan del servicio que se preguntó.
 *
 * Los pagadores son inconsistentes con EB03: unos devuelven el código exacto
 * ("A4"), otros lo meten todo bajo "30", otros no mandan nada. En vez de
 * quedarnos sin datos, se degrada por niveles.
 */
function selectRelevantBenefits(benefits: Benefit[], wanted: string | undefined): Benefit[] {
  if (wanted !== undefined) {
    const exact = benefits.filter((b) => b.serviceTypeCodes.includes(wanted));
    if (exact.length > 0) return exact;
  }
  const generic = benefits.filter(
    (b) => b.serviceTypeCodes.length === 0 || b.serviceTypeCodes.includes(SERVICE_TYPE_GENERIC),
  );
  if (generic.length > 0) return generic;
  return benefits;
}

/**
 * Descarta lo explícitamente fuera de red: es el número que el paciente va a
 * pagar de verdad. Lo que no viene marcado se conserva — muchos pagadores no
 * mandan EB12, y descartarlo dejaría la respuesta vacía.
 */
function preferInNetwork(benefits: Benefit[]): Benefit[] {
  const inNetwork = benefits.filter((b) => b.inNetwork !== false);
  return inNetwork.length > 0 ? inNetwork : benefits;
}

function isDeductibleTimeQualifier(benefit: Benefit, kind: 'total' | 'remaining'): boolean {
  const code = benefit.timeQualifierCode;
  const label = benefit.timeQualifier?.toLowerCase() ?? '';
  if (kind === 'remaining') {
    return code === EB06.remaining || label.includes('remaining');
  }
  return code === EB06.calendarYear || code === EB06.yearToDate || label.includes('calendar year');
}

/**
 * El Contrato 3 exige los tres montos del deducible (total, cubierto,
 * restante). Si el 271 solo trae uno no se puede completar sin inventar los
 * otros dos, así que se devuelve `null` y la frase dirá que no se pudo
 * confirmar. Preferimos un hueco honesto a un número plausible.
 */
function extractDeductible(benefits: Benefit[]): MappedDeductible | null {
  const deductibles = benefits.filter((b) => b.code === EB01.deductible);
  if (deductibles.length === 0) return null;

  // Nivel individual si viene marcado; si el pagador no marca nada, se acepta.
  const individualScope = deductibles.filter(
    (b) => b.coverageLevelCode === null || b.coverageLevelCode.toUpperCase() === 'IND',
  );
  const scoped = individualScope.length > 0 ? individualScope : deductibles;

  const totalCents =
    scoped.find((b) => isDeductibleTimeQualifier(b, 'total'))?.benefitAmountCents ?? null;
  const remainingCents =
    scoped.find((b) => isDeductibleTimeQualifier(b, 'remaining'))?.benefitAmountCents ?? null;

  if (totalCents === null || remainingCents === null) return null;
  if (remainingCents > totalCents) return null; // incoherente: mejor no decir nada

  return {
    individualCents: totalCents,
    metCents: totalCents - remainingCents,
    remainingCents,
  };
}

/* ------------------------------------------------------------------ */
/* Mapper                                                              */
/* ------------------------------------------------------------------ */

/**
 * Traduce la respuesta de eligibility de Stedi a hechos de cobertura.
 * Nunca lanza: ante cualquier duda devuelve `status: "unknown"` con nulls.
 */
export function map271(raw: unknown, options: Map271Options = {}): Mapped271 {
  const fallbackPayerName = options.fallbackPayerName ?? 'Unknown';

  try {
    const root = asRecord(raw);
    if (root === null) return unknownFacts(fallbackPayerName);

    /* --- identidad de la respuesta, para poder cruzarla con la captura --- */
    const meta = asRecord(get(root, 'meta'));
    const traceId =
      asString(get(meta, 'traceId')) ??
      asString(get(root, 'controlNumber')) ??
      asString(get(root, 'reassociationKey'));
    const raw271Id = traceId === null ? null : `stedi-271-${traceId}`;

    /* --- pagador y plan --- */
    const payer = asRecord(get(root, 'payer'));
    const payerName = asString(get(payer, 'name')) ?? fallbackPayerName;

    const planInfo = asRecord(get(root, 'planInformation'));

    /* --- beneficios --- */
    const allBenefits = asArray(get(root, 'benefitsInformation'))
      .map(normalizeBenefit)
      .filter((b): b is Benefit => b !== null);

    const relevant = selectRelevantBenefits(allBenefits, options.x12ServiceTypeCode);
    const preferred = preferInNetwork(relevant);

    const planName =
      preferred.find((b) => b.planCoverage !== null)?.planCoverage ??
      allBenefits.find((b) => b.planCoverage !== null)?.planCoverage ??
      asString(get(planInfo, 'groupDescription')) ??
      asString(get(planInfo, 'planNumber')) ??
      null;

    const copayCents =
      preferred.find((b) => b.code === EB01.copayment && b.benefitAmountCents !== null)
        ?.benefitAmountCents ?? null;

    const coinsurancePercent =
      preferred.find((b) => b.code === EB01.coinsurance && b.benefitPercent !== null)
        ?.benefitPercent ?? null;

    // El deducible se busca en TODOS los beneficios: casi siempre viene bajo el
    // service type genérico "30", no bajo el que se preguntó.
    const deductible = extractDeductible(preferInNetwork(allBenefits));

    /* --- señales de estado --- */
    const hasErrors = asArray(get(root, 'errors')).length > 0;

    const planStatusCodes = asArray(get(root, 'planStatus'))
      .map((entry) => asString(get(asRecord(entry), 'statusCode')))
      .filter((code): code is string => code !== null);

    /** El pagador dijo explícitamente que la póliza está vigente. */
    const planStatusActive = planStatusCodes.includes(EB01.activeCoverage);

    const activeSignal =
      planStatusActive ||
      relevant.some((b) => b.code === EB01.activeCoverage) ||
      allBenefits.some((b) => b.code === EB01.activeCoverage);

    const inactiveSignal =
      planStatusCodes.some((code) => INACTIVE_CODES.includes(code)) ||
      allBenefits.some((b) => b.code !== null && INACTIVE_CODES.includes(b.code));

    const nonCoveredSignal = relevant.some((b) => b.code === EB01.nonCovered);
    const cannotProcessSignal = allBenefits.some((b) => b.code === EB01.cannotProcess);

    const authFlags = relevant
      .map((b) => b.authRequired)
      .filter((flag): flag is boolean => flag !== null);
    const priorAuthRequired = authFlags.length === 0 ? null : authFlags.some(Boolean);

    /* --- decisión --- */
    const hasAnyBenefitFact =
      copayCents !== null || coinsurancePercent !== null || deductible !== null;

    let status: Mapped271['status'];
    if (cannotProcessSignal) {
      status = 'unknown';
    } else if (nonCoveredSignal) {
      status = 'not-covered';
    } else if (inactiveSignal && !activeSignal) {
      status = 'not-covered';
    } else if (priorAuthRequired === true) {
      status = 'needs-auth';
    } else if (activeSignal || hasAnyBenefitFact) {
      status = 'covered';
    } else {
      status = 'unknown';
    }

    /*
     * Errores del pagador: la consulta salió mal, y lo que venga en la misma
     * respuesta no se puede tomar por bueno. Un 271 con
     * `errors: [{ code: "72", description: "Invalid/Missing Subscriber ID" }]`
     * y un `benefitsInformation` suelto significa "no sé quién es este miembro",
     * no "su copago son 25 dólares". Afirmar el copago ahí es exactamente el
     * número inventado que este servicio existe para no decir.
     *
     * Solo se sostiene un resultado si el pagador ADEMÁS dijo explícitamente
     * que la póliza está vigente (planStatus con statusCode "1"): entonces sí
     * hay una afirmación suya sobre la que apoyarse, y los errores suelen ser
     * de segmentos que no nos importan.
     */
    if (hasErrors && !planStatusActive) {
      status = 'unknown';
    }

    if (status === 'unknown') {
      // Se conserva la identidad del 271 y el pagador (sirven para depurar y
      // para la captura), pero ningún número: no se afirma lo que no se sabe.
      return { ...unknownFacts(payerName), raw271Id };
    }

    return {
      status,
      payerName,
      planName,
      copayCents,
      coinsurancePercent,
      deductible,
      priorAuthRequired,
      raw271Id,
    };
  } catch {
    // Defensa en profundidad: si algo escapó a los accesores tolerantes, el
    // servicio degrada. Un 500 aquí tumbaría una llamada de voz en curso.
    return unknownFacts(fallbackPayerName);
  }
}
