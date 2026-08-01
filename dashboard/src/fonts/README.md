# Fuentes auto-hospedadas

## `manrope-latin-variable.woff2`

- **Familia:** Manrope, fuente variable, eje `wght` 200–800.
- **Subconjunto:** `latin` (el mismo `unicode-range` que sirve Google:
  `U+0000-00FF` más puntuación general y unos pocos símbolos). Cubre el español
  entero, acentos y `¿¡«»·±` incluidos.
- **Licencia:** SIL Open Font License 1.1 — permite redistribuir el binario
  junto al proyecto. Upstream: github.com/sharanda/manrope.
- **Procedencia:** es el `.woff2` que `next/font/google` ya descargaba y emitía
  en cada build; aquí está versionado en vez de bajado.

## Por qué está en el repo

`next/font/google` resuelve el runtime (auto-hospeda el archivo junto al bundle)
pero no el build: con la caché de `.next` limpia, construir exige red. El brief
pide cero dependencias del wifi, así que la fuente entra al repo y `next/font/local`
la sirve desde `src/app/layout.tsx`.

## Si hace falta añadir un peso o un idioma

No se añade otro archivo: la fuente ya es variable y cubre 200–800. Si algún día
hiciera falta latin-ext, cirílico o griego, se descarga ese subconjunto de
Manrope, se deja aquí y se declara como una fuente más en `layout.tsx` con su
`unicode-range` vía `declarations`.
