# loop-coverage

Microservicio de elegibilidad (Stedi 270/271) para Loop. Puerto 3003.

## Reglas
- SOLO edito archivos dentro de `coverage/`. Nunca toco `core/` ni `voice/`.
- `../shared/contracts.ts` es de solo lectura.
- Soy el ÚNICO servicio que habla con Stedi. Nadie más ve un 271 crudo.

## Regla crítica
`voiceSummary` lo lee un agente de voz LITERAL, sin pasar por un LLM.
Por eso:
- Debe ser una frase corta, en segunda persona, sin jerga de seguros.
- Los montos van en lenguaje humano ("25 dólares", no "2500 cents").
- Si no tengo un dato con certeza, NO lo invento. Digo que no pude verificarlo.
- Nunca genero este campo con un LLM. Es una plantilla determinista.

## Fallback
Si Stedi falla o tarda >3s: status="unknown", voiceSummary honesto, HTTP 200.
NUNCA devuelvo 500 — hay una llamada de voz en curso que no se puede caer.

## Alcance
Apunto a servicios con respuesta real: visitas de telesalud (CPT 90834),
copagos, deducible, vigencia de receta. NUNCA a suplementos — los seguros
no los cubren y la respuesta no ayuda a nadie.

## Stack
TypeScript + Node + Fastify. zod para validar. Sin base de datos.
