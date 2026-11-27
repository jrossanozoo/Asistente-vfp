# Diagnóstico: autocompletado de `class` / `function` en archivos `.prg`

**Fecha:** 2026-11-26
**Entorno analizado:** VS Code con `zoologicsa.zoo-tool-kit` 26.11.1 y `local.asistente-vfp-zoo` 0.2.1 instaladas.

## Síntomas reportados

Al escribir código VFP en un `.prg`:

1. Las palabras clave se completan en **MAYÚSCULAS**, aunque el estándar Organic las pide en minúsculas.
2. Al completar `function` dentro de una clase, el método **no queda indentado** con un tabulador.
3. Al completar `class`, se inserta `CLASS …` **sin `define`** delante (lo correcto es `define class … as … / enddefine`).

## Origen

**No es DOVFP.** DOVFP es el compilador/CLI y no participa en la edición.

Hay dos extensiones que aportan al lenguaje `foxpro` en el editor:

| Extensión | Aporta | Relación con los síntomas |
|---|---|---|
| `zoologicsa.zoo-tool-kit` 26.11.1 | 69 snippets (`resources/snippets/vfp-snippets.json`) + `language-configuration.json` | **Causa de los síntomas 1, 2 y 3** |
| `local.asistente-vfp-zoo` 0.2.1 | 3 snippets (`note`, `notes`, `funcnote`, en minúsculas) + `language-configuration.json` con reglas de indentación | No causa los síntomas, pero tiene un error que **agrava el síntoma 2** (ver más abajo) |

### Los snippets responsables (zoo-tool-kit)

| Snippet | Prefijo | Inserta |
|---|---|---|
| `VFP Class` | `vfpClass` | `CLASS nombre` / `ENDCLASS` |
| `Function Definition` | `function` | `FUNCTION nombre` / `RETURN valor` / `ENDFUNC` |
| `VFP Function` | `vfpFunction` | `FUNCTION nombre(params)` / `ENDFUNC` |

- `vfpClass` aparece al escribir `class` porque el filtro de sugerencias de VS Code no exige que la coincidencia empiece al principio del prefijo. Además, `CLASS … ENDCLASS` **no es sintaxis VFP válida**.
- Todos los snippets del tool-kit están en mayúsculas.
- Un snippet es texto fijo, así que no sabe si el cursor está dentro de un `define class`: se inserta en la columna donde está el cursor.

Durante el análisis aparecieron otros defectos en esos snippets: comentarios estilo `//`, `;` al final de los SQL, un placeholder roto, un snippet que inserta el método equivocado y prefijos duplicados o con errores de tipeo. El detalle está en [spec-zoo-tool-kit.md](spec-zoo-tool-kit.md).

### El error de la Asistente que agrava la indentación

El archivo `language-configuration.json` de la Asistente **no es un JSON válido**. Las regex de `indentationRules` tienen `\s` y `\b` sin escapar (`Bad JSON escape sequence: \s`, línea 14). Pasa tanto en el repo como en la versión instalada.

Por eso es probable que VS Code descarte esas reglas, y entonces no hay indentación automática al presionar Enter después de `define class`, `function`, `if`, etc. Además usan el modificador inline `(?i:…)`, que no todas las versiones del motor de regex de VS Code soportan.

### Conflicto de configuración de lenguaje

Las dos extensiones declaran el lenguaje `foxpro` con su propio `language-configuration.json`:

- zoo-tool-kit define `folding`, pero no `indentationRules`.
- La Asistente define `indentationRules` (hoy inválidas) y `wordPattern`, pero no `folding`.

VS Code combina las dos configuraciones y no es obvio cuál gana para cada clave. Conviene acordar qué extensión es dueña de cada aspecto.

## ¿Quién corrige qué?

| Problema | Dónde se corrige | Spec |
|---|---|---|
| Snippets en mayúsculas, `vfpClass` inválido y demás defectos de snippets | **zoo-tool-kit**: la Asistente no puede modificar ni quitar snippets de otra extensión | [spec-zoo-tool-kit.md](spec-zoo-tool-kit.md) |
| Completado según el contexto (`define class` y métodos indentados dentro de clase, en minúsculas) | **asistente-vfp-zoo**, como proveedor de completado LSP | [spec-asistente-vfp-zoo.md](spec-asistente-vfp-zoo.md) |
| `language-configuration.json` inválido | **asistente-vfp-zoo** | [spec-asistente-vfp-zoo.md](spec-asistente-vfp-zoo.md) |
| Quién es dueño de `indentationRules` y `folding` del lenguaje `foxpro` | Acuerdo entre ambos equipos | Ambas specs |

## Workaround mientras tanto (por usuario)

`Ctrl+Shift+P` → **Snippets: Insert Snippet**. En la lista, cada snippet tiene un ícono de ojo que lo oculta de IntelliSense. Con eso se ocultan `VFP Class` (`vfpClass`), `Function Definition` (`function`) y `VFP Function` (`vfpFunction`) del tool-kit. Hay que repetirlo en cada máquina.
