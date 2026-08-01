/**
 * Los peldaños de la escala que globals.css no define.
 *
 * globals.css fija los extremos —`.label` a 11px y `.hero` a 34px— pero deja
 * sin nombre los dos peldaños de en medio. Por eso los tres bloques de la
 * pantalla derivaron a once tamaños escritos a mano (10.5, 11, 11.5, 12.5, 13,
 * 13.5, 15, 17, 19, 21, 22) con TRES valores distintos para el mismo papel de
 * "número secundario". Diferencias de medio píxel que nadie percibe una a una,
 * pero que juntas hacen que la pantalla se lea ensamblada por tres personas
 * distintas en vez de diseñada por una.
 *
 * La escala completa, de arriba abajo:
 *
 *   .hero   34px  el número del panel. UNO por widget.
 *   STAT    19px  número secundario.
 *   DATA    13px  dato terciario y cuerpo pequeño.
 *   .pill   11.5px estado.
 *   .label  11px  etiqueta susurrada (= `text-2xs` de tailwind.config).
 *
 * Esto debería vivir en globals.css como `.stat` y `.foot` —está reportado—;
 * mientras tanto vive aquí, que es un único sitio donde cambiarlo, y no
 * repartido por cinco archivos.
 *
 * Se guardan como cadenas completas a propósito: el extractor de Tailwind lee
 * los `.ts` de `src/` y solo reconoce clases literales, nunca concatenadas.
 */

/** Número secundario: el segundo dato de un panel, ya bajo el héroe. */
export const STAT = 'text-[19px] font-semibold leading-none tracking-[-0.03em]';

/** Unidad colgada de un STAT. La cifra manda, la unidad acompaña. */
export const STAT_UNIT = 'ml-1 text-[11px] font-medium text-ink-3';

/** Dato terciario y cuerpo pequeño. Sin peso: lo pone quien lo usa. */
export const DATA = 'text-[13px] leading-tight';

/**
 * Pie técnico: origen, identificadores, latencia. Monoespaciado porque lo que
 * lleva son IDs y tiempos, y en proporcional un UUID baila de ancho cada vez
 * que cambia.
 */
export const FOOT = 'font-mono text-[11px] text-ink-3';

/**
 * Fondo de las capas que FLOTAN sobre el vidrio (tooltip del baseline, aviso
 * de los controles de demo).
 *
 * Casi opaco a propósito: apilar dos `backdrop-filter` ensucia el fondo, y
 * texto translúcido sobre texto translúcido es lo que se ve roto en un
 * proyector. Había dos negros semiopacos distintos, uno por componente.
 */
export const FLOATING_SURFACE = 'rgba(10, 16, 22, 0.94)';
