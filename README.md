# Loop

**Compañero de voz de circuito cerrado para ansiedad crónica.** Los datos del wearable entran, sale
apoyo contextualizado, y el resultado real se vuelve a medir.

Hackathon Y Combinator × Medplum. Usa los tres sponsors: Deepgram, Medplum y Stedi.

---

## La idea en un párrafo

Alguien con trastorno de pánico tiene tres malos momentos y ninguna buena herramienta para ninguno:
durante el episodio no sabe si es otro ataque o algo urgente; después, nada queda registrado; y entre
episodios nadie mide si el tratamiento funciona. Mientras tanto su reloj lleva meses grabando
frecuencia cardiaca, HRV y sueño — datos que nunca llegan a su expediente.

Loop es un agente de voz al que puede llamar en medio de un episodio. Ya conoce su baseline porque
lleva semanas ingiriendo esos datos como recursos FHIR. **No diagnostica**: refleja lo que el cuerpo
está haciendo y lee el plan de cuidado que escribió su clínico. Al colgar, el episodio queda escrito
como `Encounter` estructurado — y con el tiempo el sistema muestra qué intervención correlaciona con
episodios más cortos.

Ese último paso es el diferenciador. Todo el mundo está construyendo escribas de IA. Casi nadie
está construyendo el **feedback loop** que te dice si la intervención funcionó.

---

## Arquitectura

```
                          ┌──────────────────────┐
                          │  loop-dashboard      │  :3000   Carlos
                          │  vista clínica       │
                          └───┬──────────────┬───┘
              Contrato 4 ─────┘              └───── Contrato 5 (SSE)
              lecturas                              transcript en vivo
                    │                                      │
        ┌───────────▼──────────┐              ┌────────────▼─────────┐
        │  loop-core           │  :3001       │  loop-voice          │  :3002
        │  Medplum · FHIR      │◄─────────────┤  Deepgram            │
        │  Kiwis               │  Contrato 1  │  + motor red-flags   │
        │                      │  contexto    │  Lewis               │
        │                      │◄─────────────┤                      │
        └──────────────────────┘  Contrato 2  └────────────┬─────────┘
                                  episodio                 │
                                                Contrato 3 │ cobertura
                                                           │
                                              ┌────────────▼─────────┐
                                              │  loop-coverage       │  :3003
                                              │  Stedi 270/271       │
                                              │  Carlos              │
                                              └──────────────────────┘
```

Los 6 contratos están definidos en [`shared/contracts.ts`](shared/contracts.ts) como esquemas zod
— validador en runtime y tipo en compile time a la vez. Se congelaron en T0.

## Estado

| Servicio | Dueño | Estado |
|---|---|---|
| `shared/` — contratos y fixtures | — | listo, validado |
| `coverage/` — elegibilidad Stedi | Carlos | en construcción |
| `dashboard/` — vista clínica | Carlos | en construcción |
| `core/` — Medplum FHIR | Kiwis | pendiente |
| `voice/` — Deepgram + seguridad | Lewis | pendiente |

Mientras `core/` y `voice/` no existan, el dashboard corre contra `shared/fixtures/` y lo indica
con un badge visible. Esa no es una muleta temporal: es también el modo de respaldo si el wifi
muere durante el demo.

---

## Arrancar

```bash
npm install
cp ops/.env.example .env
npm run dev
```

`npm run dev` levanta el dashboard (`:3000`) y el servicio de cobertura (`:3003`).

Sin `STEDI_API_KEY` el servicio de cobertura arranca igual, en modo mock, y lo reporta en `/healthz`.
Es deliberado: nadie debe quedarse bloqueado esperando el alta de Stedi.

## Los datos del demo

Todo el dataset es sintético y **derivado**, no tecleado a mano:

```bash
npm run fixtures:generate    # 30 días de series + episodios + agregados
npm run fixtures:validate    # esquemas + invariantes cruzadas
```

`generate.mjs` tiene una sola fuente de verdad — la lista de 12 episodios. Las series de
observaciones se generan con un modelo circadiano y spikes en el momento exacto de cada episodio;
los picos que publica la lista de episodios se **leen de la serie ya generada**; y los promedios del
gráfico de outcomes se **computan** desde los episodios. Nada puede contradecirse.

`validate-fixtures.ts` comprueba esa consistencia en cada corrida, además de las invariantes que
protegen el pitch: que el fixture de red-flag de verdad viole el envelope de seguridad, que el
fixture normal no lo viole, y que la mejor intervención de verdad le gane a no hacer nada.

**Cero PHI real.** Paciente sintético, `loop-demo-patient-001`.

## Seguridad

El diseño de seguridad es el pitch, no el descargo de responsabilidad:

- **Escalación por red-flag determinista.** Corre *antes* del LLM, no como instrucción de prompt.
  Dolor de pecho irradiado, síncope, debilidad unilateral, habla arrastrada, o biometría fuera del
  envelope → el agente deja de razonar y escala. Ideación suicida va a la 988, no al 911.
- **Contextualizar, nunca diagnosticar.** El agente nunca dice "estás teniendo un ataque de pánico".
  Dice qué está haciendo el cuerpo y qué dice el plan que escribió el clínico.
- **Biometría normal desescala, nunca descarta.** Un paciente con historia cardiaca limpia puede
  tener un evento cardiaco y se presenta parecido a un ataque de pánico. Descartar es trabajo de la
  regla determinista y de un humano.
- Sin recomendaciones de medicamentos ni órdenes autónomas.

## Documentación

- [`plandevs/01-KIWIS-core-fhir.md`](plandevs/01-KIWIS-core-fhir.md) — Medplum, FHIR, dataset, Bots
- [`plandevs/02-LEWIS-voice-safety.md`](plandevs/02-LEWIS-voice-safety.md) — Deepgram, motor de red-flags
- [`plandevs/03-CARLOS-dashboard-coverage.md`](plandevs/03-CARLOS-dashboard-coverage.md) — Stedi, vista clínica
- [`CLAUDE.md`](CLAUDE.md) — reglas del repo para las tres sesiones de Claude Code
