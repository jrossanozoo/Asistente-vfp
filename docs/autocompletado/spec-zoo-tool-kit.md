# Spec de corrección: snippets de `zoologicsa.zoo-tool-kit`

**Versión analizada:** 26.11.1
**Archivo afectado:** `resources/snippets/vfp-snippets.json` (69 snippets, registrado para `foxpro`, `foxpro-dbf`, `foxpro-vcx`, `foxpro-form`, `foxpro-project`, `foxpro-report`, `foxpro-app` y `foxpro-exe`).
**Contexto:** ver [diagnostico-autocompletado.md](diagnostico-autocompletado.md).

Prioridades: **P1** = genera código inválido o contrario al estándar en el uso diario. **P2** = defecto puntual. **P3** = mejora.

---

## P1-1. `VFP Class` (`vfpClass`) genera sintaxis inválida

Hoy inserta:

```foxpro
CLASS ${1:className}
	${2:// properties and methods here}
ENDCLASS
```

`CLASS` sin `DEFINE` y `ENDCLASS` no existen en VFP. Además, el snippet aparece al escribir `class`.

**Corrección:** eliminarlo, porque ya existe `VFP Define Class` (`vfpDc`), o reemplazarlo por:

```json
"VFP Define Class": {
  "prefix": "vfpDc",
  "body": [
    "define class ${1:Nombre} as ${2:custom}",
    "",
    "\t*-----------------------------------------------------------------------------------------",
    "\tfunction ${3:Init}() as Boolean",
    "\t\t$0",
    "\tendfunc",
    "",
    "enddefine"
  ],
  "description": "define class … as … / enddefine"
}
```

**Criterio de aceptación:** ningún snippet inserta `CLASS` ni `ENDCLASS`.

## P1-2. Palabras clave en mayúsculas en todos los snippets

El estándar Organic escribe las palabras clave y funciones nativas en minúsculas (`define class`, `function`, `endfunc`, `local`, `if`, `endif`, `createobject(…)`, `with`, `endwith`, etc.). Los 69 snippets usan mayúsculas.

**Corrección:** pasar a minúsculas todas las palabras clave y funciones nativas del `body` de cada snippet. Lo que es texto de usuario (nombres de campo, `ClassName`, etc.) no cambia.

**Criterio de aceptación:** ningún `body` contiene palabras clave VFP en mayúsculas.

## P1-3. `function` / `vfpFunction` en mayúsculas y con cuerpo forzado

`Function Definition` (prefijo `function`) inserta `FUNCTION … RETURN ${3:value} … ENDFUNC`. El `return` obligatorio no aplica a métodos `Void`.

**Corrección:**

```json
"Function Definition": {
  "prefix": "vfpFunction",
  "body": [
    "function ${1:Nombre}( ${2:tcParametro} as ${3:String} ) as ${4:Void}",
    "\t$0",
    "endfunc"
  ]
}
```

Un snippet estático no puede saber si está dentro de una clase, así que el separador `*---…` y la indentación de método los resuelve el completado de la Asistente (ver [spec-asistente-vfp-zoo.md](spec-asistente-vfp-zoo.md)). Por eso el prefijo `function` desnudo se renombra (ver P1-5).

## P1-4. Comentarios estilo `//` (no válidos en VFP)

En VFP, `//` no es comentario. Si el usuario no reemplaza el placeholder, el código no compila. Dentro de `TEXT … ENDTEXT`, además, el texto queda como contenido literal.

Snippets afectados: `VFP Function`, `VFP Class`, `If Statement`, `Do While Loop`, `For Loop`, `Case Statement`, `Function Definition`, `VFP Scan Loop`, `VFP Try-Catch Block` y `VFP Text-EndText Block`.

**Corrección:** reemplazar `${n:// code}` por `$0` o por un tab stop vacío (`$n`). Si se quiere un texto guía, que sea un comentario válido (`&& …`).

## P1-5. Prefijos genéricos que chocan con el tipeo normal

Los prefijos `if`, `for`, `case`, `do while` y `function` coinciden con las palabras que se escriben todo el tiempo, así que el snippet aparece primero cada vez que se tipea la palabra.

**Corrección:** usar el prefijo `vfp…` en todos, como el resto del archivo, o eliminarlos porque ya hay equivalentes (ver P2-4).

## P1-6. `;` al final de los snippets SQL

`vfpSelect`, `vfpInsert`, `vfpUpdate` y `vfpDelete` terminan en `;`. En VFP, `;` es **continuación de línea**, así que la línea siguiente se pega al SQL y da error de sintaxis.

**Corrección:** quitar el `;` final.

---

## P2-1. `VFP dal.WhereFalse` (`vfpDwfalse`) inserta el método equivocado

El body es `.WhereTrue(…)`. **Corrección:** `.WhereFalse('${1:Field}','${2:TableAlias}')`.

## P2-2. Placeholder roto en `VFP dal.WhereInList_Iterable` (`vfpDwiterable`)

`select (${3:CursorAlias)` no cierra la llave. **Corrección:** `select (${3:CursorAlias})`.

## P2-3. Prefijos con errores de tipeo

| Snippet | Prefijo actual | Propuesto |
|---|---|---|
| VFP try catch block | `vfptTryc` | `vfpTryc` |
| VFP Multiprompt Definition | `vfpNulti` | `vfpMulti` |
| VFP if else endif | `vfpLfel` | `vfpIfel` (probable: verificar la intención) |

## P2-4. Snippets duplicados

| Concepto | Duplicados | Conservar |
|---|---|---|
| try/catch | `vfptTryc`, `vfpTryCatch` | uno |
| if/endif | `vfpIfend`, `if` | `vfpIfend` |
| for/endfor | `vfpFore`, `for` | `vfpFore` |
| do case | `vfpDocase`, `case` | `vfpDocase` |
| función | `vfpFunction`, `function` | uno (ver P1-3) |
| clase | `vfpClass`, `vfpDc` | `vfpDc` (ver P1-1) |
| createobject | `vfpEo`/`vfpCreateObject` (distinto propósito) | revisar |

## P2-5. `VFP Define Class Of` (`vfpDco`) usa `.fxp`

Inserta `of ${2}.fxp`. En Organic el `of` apunta al fuente: `of ${2}.prg`.

---

## P3-1. Convenciones Organic

- Los nombres de placeholders siguen la notación húngara del proyecto (`tcParametro`, `loObjeto`, `lnContador`), como ya hacen algunos (`loData`, `lcValue`).
- `vfpNewo` (`NEWOBJECT`) y `vfpCreateObject` van contra la convención de crear objetos con las fábricas (`_Screen.zoo.CrearObjeto(…)`, `_Screen.zoo.InstanciarEntidad(…)`). Se puede sumar un snippet con la fábrica o documentar cuándo corresponde cada uno.
- Estilo de firma: `procedure Nombre ()` → `function Nombre() as Tipo` (sin espacio antes del paréntesis).

## P3-2. Coordinar `language-configuration.json` con la Asistente

Las dos extensiones declaran el lenguaje `foxpro`. zoo-tool-kit aporta `folding`, y la Asistente aporta `indentationRules` y `wordPattern`. Hay que acordar quién es dueño de cada clave para que no se pisen.

Propuesta: zoo-tool-kit se queda con `folding` y la Asistente con `indentationRules`/`onEnterRules`, o se mueven todas a una sola extensión.

---

## Checklist de aceptación

- [ ] No hay snippets que inserten `CLASS`/`ENDCLASS`.
- [ ] Todas las palabras clave de los bodies están en minúsculas.
- [ ] No quedan `//` en los bodies.
- [ ] No quedan `;` al final de los snippets SQL.
- [ ] Ningún prefijo coincide exactamente con una palabra clave VFP (`if`, `for`, `case`, `function`, `do while`).
- [ ] `vfpDwfalse` inserta `.WhereFalse(…)`.
- [ ] El placeholder `${3:CursorAlias}` de `vfpDwiterable` funciona.
- [ ] Prefijos con errores de tipeo corregidos y duplicados resueltos.
- [ ] `vfpDco` usa `.prg`.
- [ ] Prueba manual: en un `.prg` vacío, escribir `class` y `function` no ofrece código inválido ni en mayúsculas.
