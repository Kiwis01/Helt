# loop-coverage

Microservicio de elegibilidad de Loop. Envuelve la API de eligibility check
(270/271) de **Stedi Healthcare**, traduce la respuesta a un JSON simple y
redacta el **`voiceSummary`** que el agente de voz lee literal al paciente.

Puerto **3003** (`PORTS.coverage`). Sin base de datos. Sin estado.

Lo consumen dos clientes:

| Cliente | Cuándo | Qué le importa |
|---|---|---|
| `loop-voice` (:3002) | síncrono, a mitad de llamada | `voiceSummary`, y que responda **siempre** en < 3 s |
| Bot de Medplum (Kiwis) | asíncrono, post-encuentro | `status`, `copayCents`, `checkId` |

---

## Cómo correrlo

```bash
# desde la raíz del repo
cp ops/.env.example .env          # opcional: sin .env arranca igual, en modo mock

npm run dev   --workspace @loop/coverage    # tsx watch
npm run start --workspace @loop/coverage    # una sola vez

npm run typecheck --workspace @loop/coverage
npm run test      --workspace @loop/coverage   # unitarios (config, .env, mock, map271, voiceSummary)
npm run smoke     --workspace @loop/coverage   # levanta la app en proceso y le pega por HTTP
```

**El `.env` se lee solo.** `src/config.ts` lo carga al arrancar (ver
`src/env-file.ts`), sin `dotenv` y sin tocar el script de arranque. No hace
falta `source .env` ni exportar nada a mano: si escribes `STEDI_API_KEY` en el
archivo, el servicio la ve.

- Se busca primero `coverage/.env` y después el `.env` de la raíz del repo. Gana
  el primero que exista.
- **El entorno del shell siempre gana sobre el archivo**, así que
  `USE_MOCKS=true npm run start` sigue mandando aunque el `.env` diga otra cosa.
- `COVERAGE_ENV_FILE=/ruta/al/.env` fuerza otro archivo; `COVERAGE_ENV_FILE=none`
  desactiva la carga (es lo que hace el smoke, que tiene que ser hermético).
- El log del arranque dice qué archivo se aplicó (`envFile`) y en qué modo quedó
  el servicio. Si sales al escenario, mira esa línea.
- Cuidado con `PORT` y `HOST`: el `.env` de la raíz lo comparten los cuatro
  servicios, así que ponerlos ahí se los aplica a todos. `ops/.env.example` no
  los incluye a propósito — cada servicio usa su puerto de `PORTS`.

`smoke` no necesita otra terminal ni red: levanta dos instancias en puertos
efímeros (una en modo mock y otra con Stedi apuntado a un puerto cerrado) y
valida cada respuesta contra los esquemas de `@loop/shared`.

### Comprobación rápida

```bash
curl -s localhost:3003/healthz | jq

curl -s -X POST localhost:3003/api/v1/coverage/check \
  -H 'content-type: application/json' \
  -d '{"patientId":"loop-demo-patient-001",
       "serviceType":"telehealth-mental-health",
       "cptCode":"90834",
       "requestedBy":"voice-agent",
       "callId":"call-8f2a"}' | jq
```

---

## Endpoints

### `POST /api/v1/coverage/check`

Contrato 3 de `shared/contracts.ts`. Body: `CoverageCheckRequest`.
Respuesta: `CoverageCheckResponse`, siempre validada con zod **antes** de salir.

- `checkId` es único por llamada: `cov-<uuid>`.
- `checkedAt` es el instante de la respuesta, `latencyMs` está medido de verdad.
- **Nunca devuelve 5xx por un fallo de upstream.** Si Stedi falla, tarda o
  manda algo ilegible → `200` con `status:"unknown"`, todos los campos
  desconocidos en `null` y un `voiceSummary` honesto.
- Un body malformado **sí** devuelve `400` con la forma `ApiError`. Eso es un
  bug del cliente y tiene que salir a la luz rápido, no esconderse tras un
  "unknown" plausible.

### `GET /healthz`

`HealthResponse` con `service: "loop-coverage"` y
`upstream: { stedi: "ok" | "not-configured" | "down" }`.

- `not-configured` → falta alguna de las variables que exige el 270 (ver abajo).
- `down` → el último intento real contra Stedi falló.

### CORS

Abierto a `http://localhost:3000` (dashboard) y `http://localhost:3002` (voice).

---

## Modo mock vs modo real

El servicio está en **modo mock** si `USE_MOCKS=true` **o** si le falta algo para
poder preguntarle a Stedi. Eso es deliberado: nadie debe quedarse bloqueado
esperando el alta de Stedi.

Para salir a modo real hacen falta **las cuatro**:

| Variable | Por qué es obligatoria |
|---|---|
| `STEDI_API_KEY` | sin ella no hay a quién autenticarse |
| `STEDI_TEST_PAYER_ID` | es el `tradingPartnerServiceId` del 270: a quién se pregunta |
| `STEDI_TEST_MEMBER_ID` | por quién se pregunta |
| `STEDI_TEST_MEMBER_DOB` | el pagador la exige para identificar al miembro (se normaliza a `YYYYMMDD`) |

La API key sola **no** basta. `ops/.env.example` trae payer y miembro vacíos, así
que ese es el estado más probable: con solo la key, el servicio saldría a real y
mandaría un 270 lleno de `null` que el pagador rechaza — y en el escenario la
tarjeta de cobertura diría *"no pude verificar"* en vez de enseñar el copago.
Mejor un fixture honesto que un real roto. Si falta alguna, el arranque lo avisa
con un `warn` diciendo **cuál**, y `/healthz` responde `not-configured`.

En modo mock se sirve el fixture de `shared/fixtures/`, pero con `checkId`,
`checkedAt`, `latencyMs` y `voiceSummary` **frescos**:

- `checkId`/`checkedAt`/`latencyMs`, porque si se devolvieran los del archivo el
  dashboard mostraría dos checks con el mismo `checkId` y la demo se vería falsa.
- El **`voiceSummary` se regenera** con `buildVoiceSummary()` a partir de los
  datos del fixture, en vez de copiarse. Así el camino que se ensaya es el mismo
  código que corre en real, y la frase deja de nombrar un servicio que nadie
  pidió: el fixture dice *"Tu sesión de telesalud sí está cubierta"* y el mock
  responde a cualquier `serviceType`.

### Cómo forzar cada escenario

Sin reiniciar nada, solo cambiando el `cptCode` del curl:

| Petición | Fixture | `status` |
|---|---|---|
| `cptCode: "90834"` (psicoterapia 45 min) | `coverage.covered.json` | `covered` ← **el camino del demo** |
| `cptCode: "90832"` (psicoterapia 30 min) | `coverage.needsauth.json` | `needs-auth` |
| `cptCode: "99213"` (visita de consultorio) | `coverage.unknown.json` | `unknown` |
| `serviceType: "prescription-drug"` | `coverage.needsauth.json` | `needs-auth` |
| cualquier otra cosa | `coverage.covered.json` | `covered` |

El `cptCode` manda sobre el `serviceType`.

También se puede fijar el escenario para **todas** las peticiones con
`COVERAGE_MOCK_SCENARIO=covered|needsauth|unknown`. Útil en el ensayo del demo,
cuando quieres el mismo resultado tres veces seguidas.

---

## `voiceSummary` — el campo crítico

Vive en `src/voice-summary.ts`. Es una **plantilla determinista**: función pura,
cero I/O, cero aleatoriedad, cero LLM. Misma entrada → misma frase, siempre.

```ts
buildVoiceSummary(
  { status, copayCents, coinsurancePercent, deductible, priorAuthRequired, payerName },
  'es' | 'en',
): string
```

Reglas que los tests hacen cumplir:

- Menos de 220 caracteres, segunda persona, sin jerga de seguros.
- Montos en lenguaje humano: `2500` → `"25 dólares"` / `"25 dollars"`.
- La palabra `cent`/`centavo` **no puede aparecer nunca** en la salida. Por eso
  en inglés se escribe `20%` y no `20 percent`: esa palabra contiene "cent" y
  el TTS lee el símbolo igual de bien.
- Si un dato no se conoce, **la frase lo dice**: *"No pude confirmar tu copago."*
  Nunca se omite en silencio ni se inventa un número.
- Montos que no caen en dólares enteros se redondean y se marcan como
  aproximados (`"alrededor de 26 dólares"`), porque decir los centavos está
  prohibido y leer un decimal suena a robot.
- **Ningún monto se lee jamás como "0 dólares".** El copago de cero tiene su
  propia frase (*"No tienes que pagar copago"*) y el deducible cubierto también,
  así que un cero hablado solo puede entenderse como "no hay nada que pagar".
  Por eso el tramo de 1 a 99 centavos se dice `"menos de un dólar"` en vez de
  redondearse a cero. Los tests lo comprueban en toda la salida, no solo en el
  formateador.
- **Un coaseguro del 0% no promete el costo completo si queda deducible.** El 0%
  se aplica *después* del deducible; hasta entonces paga el paciente. Con saldo
  pendiente la frase es *"Tu plan cubre el costo completo una vez que cubras tu
  deducible"*, nunca la mitad favorable a secas.

Idioma por defecto: `COVERAGE_VOICE_LANG` (`es` por defecto). El servicio
soporta los dos idiomas a propósito — el equipo aún no decidió el del demo, y
así ese riesgo desaparece.

---

## Variables de entorno

Todas salen de `ops/.env.example`, salvo cuatro que son propias de este
servicio y están documentadas aquí porque `ops/` es de solo lectura:

| Variable | Default | Para qué |
|---|---|---|
| `COVERAGE_VOICE_LANG` | `es` | idioma del `voiceSummary` (`es` \| `en`) |
| `COVERAGE_MOCK_SCENARIO` | — | fuerza un escenario mock en todas las peticiones |
| `COVERAGE_ENV_FILE` | — | ruta del `.env` a cargar, o `none` para no cargar ninguno |
| `STEDI_BASE_URL` | `https://healthcare.us.stedi.com` | host de Stedi (ver asunciones) |
| `STEDI_ELIGIBILITY_PATH` | `/2024-04-01/change/medicalnetwork/eligibility/v3` | ruta del endpoint |
| `STEDI_AUTH_SCHEME` | — | prefijo del header `Authorization` (p. ej. `Bearer`) |

Las de siempre: `USE_MOCKS`, `STEDI_API_KEY`, `STEDI_ENV`, `STEDI_TEST_PAYER_ID`,
`STEDI_TEST_PAYER_NAME`, `STEDI_TEST_MEMBER_*`, `STEDI_PROVIDER_NPI`,
`STEDI_PROVIDER_ORG_NAME`. También se admiten `PORT`, `HOST` y `LOG_LEVEL`.

---

## Captura del 271 crudo

**Cada llamada real** a Stedi escribe `coverage/captures/<checkId>.json` con la
petición enviada, el HTTP status, la latencia y la respuesta cruda. Nunca se
guardan headers ni la API key.

Es la red de seguridad del demo: si Stedi se cae en el escenario, esa captura
es el respaldo, y el pitch sigue siendo honesto porque se dice en voz alta que
es una respuesta capturada del sandbox.

El directorio está en `.gitignore` (salvo el `.gitkeep`). Si quieres versionar
una captura como respaldo permanente, cópiala fuera con otro nombre.

---

## Qué asumí de Stedi

**No hay credenciales de Stedi en este entorno**, así que nada de lo de abajo se
ha podido verificar contra el servicio real. Todo el contacto con Stedi está
aislado en dos archivos —`src/stedi/client.ts` y `src/stedi/map271.ts`— y cada
asunción está marcada con un comentario `ASUNCIÓN:` en el código.

**Transporte** (`src/stedi/client.ts`):

1. El endpoint es `POST https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3`.
2. La autenticación es el header `Authorization` con la API key **cruda**, sin
   esquema (`Bearer` se activa con `STEDI_AUTH_SCHEME=Bearer`).
3. El body del 270 es JSON con `controlNumber`, `tradingPartnerServiceId`,
   `provider {organizationName, npi}`, `subscriber {memberId, firstName,
   lastName, dateOfBirth}` y `encounter {serviceTypeCodes, procedureCode,
   productOrServiceIDQualifier}`.
4. `controlNumber` es numérico de 9 dígitos.
5. `dateOfBirth` va en `YYYYMMDD` (el `.env` lo trae como `YYYY-MM-DD` y
   `config.ts` lo normaliza al arrancar; si no se puede, el servicio se queda en
   modo mock en vez de mandar la fecha en `null`).
6. `productOrServiceIDQualifier: "HC"` es el qualifier correcto para un CPT.
7. Una respuesta correcta llega como HTTP 200 con JSON.

**Forma del 271** (`src/stedi/map271.ts`):

8. Stedi devuelve el 271 ya deserializado a JSON, no EDI crudo.
9. Los beneficios vienen en `benefitsInformation[]`, con `code` = EB01
   (`1` Active, `A` Co-Insurance, `B` Co-Payment, `C` Deductible, `I`
   Non-Covered, `6/7/8` Inactive, `V` Cannot Process).
10. `benefitAmount` viene en **dólares** como string (se admiten `$`, comas y
    decimales).
11. `benefitPercent` viene como **fracción** (`"0.2"` = 20 %). Si llega > 1 se
    interpreta como puntos porcentuales, para aguantar las dos convenciones.
12. `authOrCertIndicator: "Y"` significa que hace falta autorización previa.
13. `inPlanNetworkIndicatorCode: "Y"/"N"` distingue in-network de out-of-network.
14. El deducible se identifica por `timeQualifierCode` `23` (Calendar Year) /
    `29` (Remaining), y `coverageLevelCode: "IND"` es el nivel individual.
15. `serviceTypeCodes` lleva los códigos EB03; `"30"` es el genérico.
16. La identidad de la respuesta está en `meta.traceId`, con `controlNumber` y
    `reassociationKey` como alternativas.
17. Los errores del pagador llegan en `errors[]`. Un 271 con `errors[]` **no se
    toma por bueno** aunque traiga beneficios sueltos: se degrada a `unknown`
    salvo que el pagador diga además, explícitamente, que la póliza está vigente
    (`planStatus` con `statusCode: "1"`). Un *"no sé quién es este miembro"* no
    puede acabar en *"tu copago son 25 dólares"*.

**Limitación conocida:** el Contrato 3 exige los tres montos del deducible
(`individualCents`, `metCents`, `remainingCents`). Si el 271 solo trae uno,
`deductible` sale `null` y la frase dice que no se pudo confirmar. Preferimos
un hueco honesto a dos números plausibles.

---

## Qué verificar cuando llegue la API key de Stedi

Por orden. Los primeros cuatro puntos son los que pueden romper el demo.

1. **Haz un `curl` crudo al endpoint antes de tocar el servicio.** Guarda la
   respuesta tal cual en un archivo. Ese archivo vale más que cualquier
   suposición de este README.
2. **Confirma la URL** (asunciones 1). Si difiere, se arregla con
   `STEDI_BASE_URL` y `STEDI_ELIGIBILITY_PATH`, sin tocar código.
3. **Confirma el header de autenticación** (asunción 2). Si Stedi quiere
   `Bearer`, pon `STEDI_AUTH_SCHEME=Bearer`. Si quiere otro header
   (`x-api-key`, por ejemplo), hay que editar `authHeader()` en `client.ts`.
4. **Confirma el shape del 270** (asunciones 3-6). Si el sandbox rechaza el
   body, el error suele decir exactamente qué campo falta. Se corrige en
   `buildEligibilityRequest()`.
5. **Guarda un 271 real de un caso "covered"** y compáralo con el payload
   `full271` de `src/stedi/map271.test.ts`. Actualiza el test con el payload
   real: a partir de ahí los tests dejan de probar mi suposición y prueban la
   realidad.
6. **`benefitAmount`: ¿dólares o centavos?** Es el error más caro posible —
   confundirlos multiplica el copago por 100 delante de los jueces. Verifica
   con un copago que conozcas.
7. **`benefitPercent`: ¿`0.2` o `20`?** (asunción 11).
8. **¿Cómo marca el pagador de prueba la autorización previa?** ¿Con
   `authOrCertIndicator`, o con un `additionalInformation` en texto libre?
   De eso depende que el escenario `needs-auth` funcione en real.
9. **¿Qué `timeQualifierCode` usa para el deducible?** Si no manda el total del
   año, `deductible` saldrá `null` y la frase perderá la mitad de su gracia.
   Ver la limitación conocida de arriba.
10. **¿Devuelve algo útil para CPT 90834 con el payer de prueba?** Si el
    sandbox solo responde a nivel de service type y no de CPT, hay que decidir
    si se pide solo `A4` sin `procedureCode`.
11. **Mide la latencia real** de 5 llamadas seguidas. Si la p95 se acerca a los
    2500 ms de `TIMEOUTS_MS.stediUpstream`, avísale a Lewis: el fallback va a
    dispararse en el escenario y hay que ensayarlo así.
12. **Comprueba la captura**: tras la primera llamada real,
    `coverage/captures/<checkId>.json` debe existir y **no** contener la API
    key. Copia una captura buena fuera del directorio como respaldo del demo.
13. **Vuelve a correr `npm run smoke`** con `USE_MOCKS=false` para ver el
    camino real de punta a punta.

---

## Estructura

```
coverage/
  src/
    config.ts               carga y valida el entorno con zod
    config.test.ts
    env-file.ts             lee el .env al arrancar (sin dependencias)
    env-file.test.ts
    server.ts               app Fastify, CORS, manejo de errores, listen
    mock.ts                 respuestas desde shared/fixtures/
    mock.test.ts
    voice-summary.ts        plantilla determinista  ← el campo crítico
    voice-summary.test.ts
    routes/
      check.ts              POST /api/v1/coverage/check
      health.ts             GET  /healthz
    stedi/
      client.ts             HTTP + timeout + captura del 271 crudo
      map271.ts             271 → contrato (función pura, tolerante)
      map271.test.ts
    tests/
      root-suite.test.ts    puente del glob de `npm test` (ver el archivo).
                            Todo test nuevo en la raíz de src/ se importa aquí.
  scripts/
    smoke.ts
  captures/                 271 crudos capturados (gitignored)
```

Fuera de `src/stedi/` nadie sabe cómo luce un 271. Si Stedi cambia su API, el
resto del servicio no se entera.
