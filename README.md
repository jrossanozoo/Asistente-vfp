# Asistente VFP

Extensión de VS Code para Visual FoxPro (`.prg`): navegación semántica, ayuda contextual y **docstrings `NOTE`**.

Es la versión **genérica**: sirve para cualquier sistema VFP, no depende de dovfp ni de un framework en particular, y solo lee fuentes `.prg`. La versión con el conocimiento del framework Organic (productos, fábricas, `.symbols`, stubs, VCX) es **Asistente-vfp-zoo** (repo hermano `code.extensions\Asistente-vfp-zoo`), que reutiliza este núcleo.

## Funcionalidades

| | Qué hace |
|---|---|
| **Outline** (Document Symbols) | Clases, métodos, propiedades, `add object`, funciones y procedimientos sueltos. |
| **Ctrl+T** (Workspace Symbols) | Busca clases, funciones y métodos en todas las carpetas indexadas. |
| **F12** (Go to Definition) | Sobre `AS Clase`, `DEFINE CLASS … AS Padre`, `OF lib.prg` (abre el archivo), `createobject("X")` y `newobject("X", "lib.prg")`, `this.Metodo`, `thisform.X`, `dodefault()` (salta al método del padre), variables con `LOCAL x AS Clase` y bloques `WITH`. Si el tipo del receptor no se conoce, devuelve los candidatos por nombre (*resolución heurística*). |
| **Go to Type Definition** | Sobre una variable, propiedad o cadena `a.b.c`: abre la **clase** del tipo deducido (`LOCAL x AS Clase`, `this`, `thisform`, propiedades con tipo conocido). Si el tipo no se puede deducir, no devuelve nada (nunca cae en la búsqueda por nombre). |
| **Go to Declaration** | Dónde se declara el símbolo aunque tenga un tipo deducido: la variable `LOCAL loX`, la propiedad `oX = null`, el método. |
| **Ctrl+F12** (Go to Implementation) | Sobre una clase: sus subclases transitivas. Sobre un método: los overrides en las subclases. Incluye los repos configurados en `vfp.downstreamRoots`. |
| **Type Hierarchy** | Supertipos y subtipos nativos de VS Code. |
| **Hover** | Firma, docstring `NOTE` en Markdown, jerarquía, subclases y procedencia. Si un método no tiene `NOTE`, muestra el del ancestro más cercano ("Doc heredada de X") o, como respaldo, los comentarios `*` / `*!*` / `&&` de encima. |
| **Signature Help** | Al abrir `(` muestra los parámetros con la descripción del `NOTE`. El parámetro actual avanza con cada `,`, sin contar comas de strings, llamadas anidadas o subíndices, y funciona con llamadas partidas por `;`. |
| **Diagnósticos** | **D1** `NOTE` huérfano (warning). **D2** comentario cuya última línea termina en `;` y se come la declaración siguiente (error, con *quick fix* "Quitar el ';' final"). |
| **Snippets** | `note`, `notes`, `funcnote`. |

## Docstrings `NOTE`

`NOTE` es el comando de comentario de VFP. La convención es usar un bloque `NOTE` antes de la declaración que documenta:

```foxpro
*-----------------------------------------------------------------------------------------
NOTE	[Generacion] Devuelve las opciones del combo listas para asignar a RowSource. ;
		Lo llama el formulario generado (ver DespuesDeSerializar). ;
		Parametros: ;
			tcEntidad - Entidad del combo (con o sin el prefijo ADT_). ;
			tcAtributo - Atributo de la entidad. ;
		Retorna: String - etiqueta,valor,... sin coma final; "" si la clave no tiene definicion.
function ObtenerLista( tcEntidad as String, tcAtributo as String ) as String
```

- **Primera línea:** `[Categoría]` opcional y un resumen. `[Obsoleto]` se muestra tachado.
- **Detalle:** las líneas siguientes, hasta la primera sección.
- **Secciones:** `Parametros:` / `Parámetros:` (`nombre - texto`), `Retorna:` (`Tipo - texto`) y `Ejemplo:`.
- **Asociación:** el bloque documenta la primera declaración que lo sigue (`function`, `procedure`, `define class` o una propiedad). Entre medio solo puede haber líneas en blanco, separadores `*---` o etiquetas `*-- @tag`.
- ⚠️ Todas las líneas menos la última terminan en `;`. Si la última también termina en `;`, VFP toma la línea siguiente como parte del comentario y **la función desaparece**. La extensión lo marca como error (D2).

## Configuración

| Clave | Por defecto | Para qué |
|---|---|---|
| `vfp.extraRoots` | `[]` | Carpetas adicionales con fuentes (repos hermanos). Relativas a la primera carpeta del workspace. |
| `vfp.downstreamRoots` | `[]` | Repos que consumen este código: solo para implementaciones y jerarquía. |
| `vfp.exclude` | `node_modules`, `.git`, `bin`, `obj` | Globs que no se indexan. |
| `vfp.index.headersOnly` | `["**/*Generated*/**"]` | Archivos que se indexan solo por `define class` / `function` / `procedure` (código generado voluminoso). |
| `vfp.index.maxFileSizeKB` | `512` | Más grandes que esto: solo encabezados. |
| `vfp.docstring.fallbackComments` | `true` | Usar comentarios clásicos cuando no hay `NOTE`. |
| `vfp.features.documentSymbols` | `true` | Apagarlo si otra extensión (zoo-tool-kit) ya da el Outline y se ve duplicado. |
| `vfp.trace.server` | `"off"` | Traza del protocolo LSP en el panel de salida (para diagnosticar problemas). |

Comando: **Asistente VFP: Reindexar workspace**.

Los `.prg` se leen siempre como **Windows-1252**. El índice se guarda en una cache en el storage del workspace (carpeta `index-cache`, partida en 32 archivos; cada `.prg` se valida por fecha y tamaño). La primera indexación de un repo grande tarda decenas de segundos; las siguientes leen la cache y solo reparsean los archivos que cambiaron (en un workspace de ~17.000 archivos, pocos segundos). Si la cache no se puede guardar, el error queda en el panel de salida del servidor.

## Convivencia

- **zoo-tool-kit:** las dos registran el lenguaje `foxpro`. Si se ve el Outline duplicado, apagar `vfp.features.documentSymbols`.
- **vsc-f12-vfp:** queda obsoleta (choca con F12). La extensión avisa si está instalada.
- **Asistente-vfp-zoo:** incluye todo lo de esta. No instalar las dos a la vez.

## Desarrollo

```bash
npm install
npm run build        # esbuild → dist/client.js y dist/server.js
npm test             # vitest
npm run typecheck
npm run package      # genera el .vsix
```

F5 abre un *Extension Development Host*. Medición sobre un repo real:

```bash
VFP_BENCH_ROOT=c:/LinceV3/Organic.Drawing npx vitest run test/bench.test.ts
```

### Estructura

- `src/core/`: núcleo reutilizable (sin dependencia de `vscode`). Lo importa Asistente-vfp-zoo.
  - `text/`: lectura 1252, scanner de strings/comentarios, líneas lógicas (`;`).
  - `parser/`: parser PRG tolerante, parser `NOTE`, Markdown.
  - `index/`: índice de símbolos por capas, escaneo y cache.
  - `features/`: resolución bajo el cursor y providers LSP.
  - `plugin.ts`: puntos de extensión (capas, resolución de tipos y strings, diagnósticos, hover, code actions).
  - `lspHost.ts`: conecta todo al protocolo LSP.
- `src/server/server.ts`: servidor genérico (núcleo sin plugins).
- `src/client/extension.ts`: cliente VS Code.
