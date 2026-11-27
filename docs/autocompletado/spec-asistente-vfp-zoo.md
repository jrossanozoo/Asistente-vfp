# Spec de corrección: `asistente-vfp-zoo`

**Versión instalada:** 0.2.1. En el repo, `package.json` dice `0.1.0`: confirmar que el fuente corresponde a lo instalado (ver P2-2).
**Contexto:** ver [diagnostico-autocompletado.md](diagnostico-autocompletado.md).

Prioridades: **P1** = defecto actual o pedido principal. **P2** = mejora relacionada.

---

## P1-1. `language-configuration.json` no es JSON válido

**Problema:** las regex de `indentationRules` tienen `\s` y `\b` sin escapar. El parser JSON falla (`Bad JSON escape sequence: \s`, línea 14), así que es probable que VS Code ignore las reglas de indentación. Además, `(?i:…)` (modificador inline) no está soportado en todas las versiones del motor de regex que usa VS Code.

**Corrección:** escapar las barras y usar el formato de objeto `{ pattern, flags }`, que VS Code acepta para `indentationRules`:

```json
"indentationRules": {
  "increaseIndentPattern": {
    "pattern": "^\\s*(define\\s+class|((protected|hidden)\\s+)?(function|procedure)|if|else|do\\s+case|case|otherwise|for|do\\s+while|scan|with|try|catch|finally|text)\\b.*$",
    "flags": "i"
  },
  "decreaseIndentPattern": {
    "pattern": "^\\s*(enddefine|endfunc|endproc|endif|else|endcase|case|otherwise|endfor|next|enddo|endscan|endwith|catch|finally|endtry|endtext)\\b.*$",
    "flags": "i"
  }
}
```

A revisar al implementar:

- `text` en `increaseIndentPattern` también matchea `textmerge` y otras palabras que empiezan igual. Usar `text\\b` estricto. Además, dentro de `TEXT … ENDTEXT` lo ideal es no reindentar.
- `if` matchea `iif(…)` solo si la línea empieza con `if`, así que está bien. Verificarlo igual con un test.
- `case` está en las dos listas (correcto para `do case`). Verificar el resultado con `otherwise`.

**Criterio de aceptación:**

- El archivo parsea con `JSON.parse`. Agregar un test que lo valide.
- Prueba manual: Enter después de `define class X as custom` indenta un tab, y escribir `enddefine` desindenta. Lo mismo con `function`/`endfunc`, `if`/`endif` y `try`/`catch`/`endtry`.

## P1-2. Proveedor de completado según el contexto (LSP `completionProvider`)

**Objetivo:** que al escribir `class`, `define`, `function` o `procedure` se ofrezca la plantilla Organic correcta, **en minúsculas** y **con la indentación que corresponde al contexto**. Esto no se puede lograr con un snippet estático.

### Dónde va

- Nuevo feature en `src/core/features/completion.ts`, con el mismo patrón que `hover.ts` y `signatureHelp.ts`.
- Registrar `completionProvider` en `capabilities()` de `src/core/lspHost.ts` y el handler `c.onCompletion(…)`.
- Sin trigger characters: se activa por palabra.

### Detección de contexto

Determinar si la línea del cursor está **dentro de un `define class` abierto**:

- No depender solo de `ClassDecl.range` del índice. Mientras se escribe, el archivo suele estar incompleto (sin `enddefine`) y el rango es aproximado.
- Hacer un escaneo hacia atrás desde la línea del cursor sobre líneas lógicas (`text/logicalLines.ts`, que ya resuelve la continuación con `;`): la última línea que matchee `^\s*define\s+class\b` o `^\s*enddefine\b` define el contexto.
- Ignorar comentarios (`*`, `&&`, `NOTE` con continuación), bloques `TEXT … ENDTEXT` y bloques `#if .f. … #endif`.
- No ofrecer nada si el cursor está dentro de un string o de un comentario.

### Items a ofrecer

Todos como `CompletionItemKind.Snippet` con `insertTextFormat: Snippet`, `insertTextMode: asIs` y un `textEdit` que reemplaza **desde la columna 0 hasta el cursor**, para que la indentación la fije el proveedor y no la herede de la línea.

**a) Fuera de clase, al escribir `class` o `define`** → `define class`:

```foxpro
define class ${1:Nombre} as ${2:custom}${3: of ${4:archivo}.prg}

	$0

enddefine
```

Dentro de una clase **no** se ofrece, porque VFP no permite clases anidadas.

**b) Dentro de clase, al escribir `function` o `procedure`** → método con separador, indentado en un nivel más que el `define class`:

```foxpro
	*-----------------------------------------------------------------------------------------
	function ${1:Nombre}( ${2:tcParametro} as ${3:String} ) as ${4:Void}
		$0
	endfunc
```

- El separador mide 90 caracteres (`*` + 89 `-`), igual que en el código existente (por ejemplo, `colaboradorcomprobantes.prg`).
- Variantes opcionales: `protected function` y `hidden function` (prefijos `protected`, `hidden`).
- Si el usuario escribió `procedure`, usar `procedure` / `endproc`.

**c) Fuera de clase, al escribir `function` o `procedure`** → función suelta en la columna 0, sin indentar:

```foxpro
function ${1:Nombre}( ${2:tcParametro} as ${3:String} ) as ${4:Void}
	$0
endfunc
```

**d) `funcnote` según el contexto.** El snippet estático actual inserta el `NOTE` sin indentar. Moverlo al proveedor para que, dentro de una clase, quede como en el código existente:

```foxpro
	*-----------------------------------------------------------------------------------------
	NOTE	[${1|Dependencia,Extension,Generacion,Contrato,Gotcha|}] ${2:Resumen}. ;
			Parametros: ;
				${4:tcParametro} - ${5:Descripción}. ;
			Retorna: ${6:Void} - ${7:Descripción}.
	function ${3:Nombre}( ${4:tcParametro} as String ) as ${6:Void}
		$0
	endfunc
```

Después de moverlo, quitar `funcnote` de `snippets/foxpro.json` para que no aparezca dos veces. `note` y `notes` pueden quedar como snippets estáticos.

### Orden frente a los snippets del tool-kit

Los snippets de otra extensión no se pueden ocultar desde la Asistente. Para que nuestras plantillas aparezcan primero:

- `sortText` con prefijo bajo (por ejemplo `"0_define_class"`).
- `preselect: true` en el item principal de cada contexto.
- `label` claro: `define class (Organic)` y `function – método (Organic)`.
- `detail`/`documentation` con una vista previa del código.

### Casing

Siempre en minúsculas. Opcionalmente, una setting `asistenteVfp.completion.keywordCase` (`lower` por defecto, `upper` opcional) por si otro proyecto de la familia la necesita. No es obligatorio en esta iteración.

### Criterio de aceptación (tests en `test/features.test.ts`, nuevo `describe('completion')`)

- [ ] Archivo vacío, escribir `class` → el primer item inserta `define class … as custom` / `enddefine` en minúsculas, en la columna 0.
- [ ] Dentro de `define class X as custom` (sin `enddefine` todavía), escribir `function` → inserta el separador y `function`/`endfunc` con un tab, y el cuerpo con dos.
- [ ] Mismo caso con la clase cerrada y el cursor entre métodos → mismo resultado.
- [ ] Después de `enddefine`, escribir `function` → función en la columna 0, sin separador de método.
- [ ] Dentro de una clase, escribir `class` → no se ofrece `define class`.
- [ ] Cursor dentro de un string, de un comentario `&&` o de un bloque `TEXT … ENDTEXT` → no hay items.
- [ ] `define class` precedido por un `NOTE` con continuación `;` → se detecta bien el contexto.
- [ ] `procedure` dentro de una clase → `procedure`/`endproc`.

---

## P2-1. Coordinar `language-configuration.json` con zoo-tool-kit

Las dos extensiones declaran el lenguaje `foxpro`. zoo-tool-kit aporta `folding`, y la Asistente aporta `indentationRules` y `wordPattern`. Hay que acordar quién es dueño de cada clave (ver P3-2 de [spec-zoo-tool-kit.md](spec-zoo-tool-kit.md)). Si la Asistente queda como dueña de la indentación, puede sumar `onEnterRules`, por ejemplo para continuar `NOTE … ;` con la indentación correcta.

## P2-2. Versión del fuente y versión instalada

`package.json` del repo dice `0.1.0`, pero la extensión instalada es `0.2.1`. Confirmar que el fuente de `c:\LinceV3\code.extensions\Asistente-vfp` es el que se empaqueta, y subir la versión al publicar estas correcciones.

## P2-3. Documentar el workaround para los snippets del tool-kit

Agregar al README una nota: hasta que zoo-tool-kit corrija sus snippets, se pueden ocultar `vfpClass`, `function` y `vfpFunction` desde **Snippets: Insert Snippet** (ícono de ojo) para que no compitan con el completado de la Asistente.
