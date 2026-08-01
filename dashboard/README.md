# loop-dashboard

Vista clínica de **Loop** — el compañero de voz de circuito cerrado para
ansiedad crónica. Next.js (App Router) en el puerto **3000**.

Es la pantalla que abre y cierra el demo: 80 de los 180 segundos del pitch.

---

## Arrancar

Desde la raíz del repo (no hace falta instalar nada aparte, es un workspace):

```bash
npm run dev --workspace @loop/dashboard   # http://localhost:3000
npm run build --workspace @loop/dashboard
npm run typecheck --workspace @loop/dashboard
```

O los dos servicios de Carlos a la vez:

```bash
npm run dev                               # coverage :3003 + dashboard :3000
```

---

## Variables de entorno

Se copian de `ops/.env.example` al `.env` de la **raíz del repo** —el mismo
archivo que leen los cuatro servicios—. Todas llevan prefijo `NEXT_PUBLIC_`
porque el dashboard corre en el navegador.

Next solo lee archivos `.env` que estén dentro de `dashboard/`, así que el de la
raíz lo aplica `next.config.ts` a mano. De más fuerte a más débil:

1. el entorno del shell — `NEXT_PUBLIC_USE_FIXTURES=true npm run build` gana
   siempre;
2. `dashboard/.env.local` y `dashboard/.env`, si existen (los carga Next);
3. `<raíz>/.env` — el compartido, y el que documenta `ops/.env.example`.

Del `.env` de la raíz solo se aplican las variables `NEXT_PUBLIC_*`: el
dashboard no lee ninguna otra, y no tiene por qué tener en su proceso el
`STEDI_API_KEY` ni el `MEDPLUM_CLIENT_SECRET` de los servicios vecinos.

Al arrancar, `next dev`, `next build` y `next start` imprimen qué archivo
mandó:

```
[loop-dashboard] .env → /ruta/al/repo/.env · 5 variables NEXT_PUBLIC_
```

Si ahí pone `ninguno`, el `.env` no existe o `DASHBOARD_ENV_FILE=none` lo
desactivó, y la app corre con los valores por defecto de
`@loop/shared/constants`.

| Variable | Por defecto | Para qué |
|---|---|---|
| `NEXT_PUBLIC_LOOP_CORE_URL` | `http://localhost:3001` | loop-core (Kiwis). Contratos 4 y 6. |
| `NEXT_PUBLIC_LOOP_VOICE_URL` | `http://localhost:3002` | loop-voice (Lewis). Contrato 5, el SSE. |
| `NEXT_PUBLIC_LOOP_COVERAGE_URL` | `http://localhost:3003` | loop-coverage. Contrato 3. |
| `NEXT_PUBLIC_USE_FIXTURES` | `false` | **Modo respaldo.** En `true` no se toca la red. |
| `NEXT_PUBLIC_LOOP_PATIENT_ID` | `loop-demo-patient-001` | Paciente del demo. |

Los valores por defecto salen de `@loop/shared/constants`, así que la app
arranca sin `.env` y apunta a los puertos correctos.

> **Ojo con `npm run build`:** Next sustituye las `NEXT_PUBLIC_*` por su valor
> en tiempo de build. En `npm run dev` basta con editar el `.env` y el servidor
> recarga solo; si el demo corre sobre `build` + `start`, cambiar el modo
> respaldo exige **volver a construir**:
>
> ```bash
> # plan B, desde la raíz: se edita el .env y se reconstruye
> npm run build --workspace @loop/dashboard && npm run start --workspace @loop/dashboard
>
> # o sin tocar el .env, forzándolo desde el shell (el shell siempre gana)
> NEXT_PUBLIC_USE_FIXTURES=true npm run build --workspace @loop/dashboard
> ```

---

## Modo respaldo (`NEXT_PUBLIC_USE_FIXTURES=true`)

La palanca para cuando muere el wifi del hackathon. Con ella activada el
dashboard no intenta ni una petición: lee todo de `shared/fixtures/`, que van
en el bundle. El badge de la barra superior lo dice en pantalla.

Aun con la palanca en `false`, cada lectura cae al fixture por su cuenta si
loop-core no responde en 2 s, devuelve un error o manda algo que no cumple el
contrato. **El dashboard no se queda nunca en blanco.**

---

## Indicador de origen de los datos

Arriba a la derecha, siempre visible:

- **Datos en vivo** (punto verde) — todo vino de loop-core.
- **Fixtures** (punto ámbar) — al menos una lectura cayó al fixture, con el
  motivo al lado (*loop-core no está disponible*, *no respondió en 2000 ms*,
  *la respuesta no cumple el contrato*, *modo respaldo activo*).

Basta con que una lectura caiga para que el badge deje de decir "en vivo". Es
deliberado: enseñar datos de fixture creyéndolos reales delante de un jurado
es el peor fallo posible de esta pantalla.

---

## Estructura

```
dashboard/
  next.config.ts          transpilePackages: ['@loop/shared'] — sin esto no compila
  tailwind.config.ts      colores del tema, mapeados a las custom properties
  postcss.config.mjs
  src/
    app/
      layout.tsx          html lang="es", tema oscuro
      globals.css         paleta, tipografía del sistema, scrollbars
      page.tsx            página única + placeholders de los gráficos
    lib/
      config.ts           lectura del entorno
      fixtures.ts         imports estáticos de shared/fixtures/*.json
      core-client.ts      cliente de loop-core con fallback a fixtures
      format.ts           centavos, duraciones, fechas, biometría
    components/
      Card.tsx            primitivo de layout + hueco reservado
      PatientHeader.tsx   identidad clínica del paciente
      DataSourceBadge.tsx en vivo vs fixtures
      DemoControls.tsx    Contrato 6: spike y reset
```

`shared/` es de **solo lectura**. Cualquier cambio de contrato va por PR y
aviso a los tres.

---

## Estado actual

Hecho:

- Scaffold, configuración y capa de datos completa (Contratos 4 y 6).
- Header del paciente, badge de origen, panel de control de demo.
- Layout a 1280×720 sin scroll horizontal.

Pendiente (marcado con bloques `PLACEHOLDER —` en `src/app/page.tsx`):

- Gráfico de baseline de 30 días con banda y episodios marcados.
- Gráfico de outcomes por intervención — *el cierre del pitch*.
- Panel de llamada en vivo por SSE (Fase 3).
- Tarjeta de cobertura (Fase 3).

loop-core (:3001) todavía no existe, así que hoy la página corre entera desde
fixtures y los botones de demo responden con un aviso inline honesto en vez de
fingir que el spike ocurrió.
