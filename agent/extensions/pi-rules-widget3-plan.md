# Pi Rules — widget de tres líneas y alineación

Estado: aprobado por el usuario («Me agrada si»); autonomía run-through.
Una tarea de código (W3) tras baseline (B0): implementar → revisar → commit, sin push. El posible cambio de notificaciones se difirió al descubrir que el aviso descrito no existe para reglas inline en TUI.

## Roles y workspace

- Workspace `C:\Users\andre\.pi`, rama `master`. Último commit relacionado: `2ff44e4` (retiro de planes); código actual del widget: `ce68d21`. No asumir HEAD: verificar.
- Único archivo de código: `agent/extensions/pi-rules.ts` (`updateWidget`, constantes e imports estrictamente necesarios).
- Orquestador `archon@pi-rules`; implementador `claude@pi-rules`; revisor `gpt@pi-rules`; committer `committer@.pi`. Solo terminales con cwd `C:\Users\andre\.pi`.
- Documentos del orquestador: este plan (se incluye en el commit W3) y `agent/extensions/LEDGER-pi-rules-widget3-plan.md` (nunca se commitea; se elimina al terminar).
- Dirt pre-existente ajeno: `.vscode/sessions.json` modificado (estado del editor, no código). Nadie lo toca, limpia o commitea.
- Contexto: 150K útiles por worker; compactar solo en límites de tarea.

## Comportamiento actual (referencia)

- Preview lógico: primera línea, corte a `MAX_PREVIEW = 280`, `...` si se omitió contenido por multilínea o longitud.
- Widget: `wrapTextWithAnsi` sobre ` ⚙ ${text}` atenuado; máximo 2 líneas visuales; si sobran, se reúne el resto en la segunda y `truncateToWidth` añade `...` atenuado; `pad=true`; `width <= 0` devuelve `[""]`.
- Aviso al establecer reglas: solo `warnIfLarge` (> 20 000 chars, warning). No existe aviso informativo de tamaño en TUI: el éxito inline se muestra por el transcript; `@file` notifica ruta y chars en todos los modos.

## Cambios requeridos (W3: alineación y tres líneas)

### 1. Alineación de líneas continuadas

Problema: la primera línea empieza con ` ⚙ ` y las siguientes empiezan en la columna 0, así que el texto salta de columna al continuar.

Requisito: las líneas 2..N deben alinearse con el inicio del texto de la primera (sangría igual al ancho visible de ` ⚙ `, medido con utilidades públicas, no contado a mano). La sangría cuenta dentro de `width`; ninguna línea excede `width` en columnas visibles. En anchos donde la sangría no deja espacio útil, priorizar seguridad de ancho y seguir mostrando algo razonable (sin overflow, sin bucles).

### 2. Tres líneas por defecto

Requisito: máximo 3 líneas visuales, una constante nombrada (p.ej. `WIDGET_LINES = 3`) en lugar del literal. Misma semántica que hoy: usar solo las que hagan falta, sin filas vacías reservadas; si el preview no cabe, la última línea visible termina en `...` atenuado, sin marcadores duplicados; `width <= 0` sigue devolviendo `[""]`. El truco de reunir el resto en la última línea (para que el marcador aparezca cuando un corte cae exacto en `width`) debe seguir garantizando marcador visible.

### Cambio de notificaciones diferido

El baseline demostró que no existe un aviso informativo al establecer reglas inline en TUI: los avisos de tamaño actuales son `warnIfLarge` (> 20 000 caracteres) y `Rules loaded from … (N chars)` para `@file`. Por tanto, no había un aviso inline que condicionar sin introducir comportamiento nuevo. La elección entre condicionar `@file`, añadir un aviso inline o hacer ambos queda fuera de W3 y requiere una decisión explícita del usuario. Todas las notificaciones deben permanecer idénticas en este cambio.

## Invariantes

- Reglas almacenadas, `appendEntry`, restauración, prompt inyectado y renderer del transcript no cambian.
- Tema resuelto en cada `render` de la misma instancia; puntos, marcador y texto atenuados de forma efectiva (por glifo).
- Sin utilidades propias de ancho/truncado; solo API pública de `@earendil-works/pi-tui`. Sin dependencias, sin archivos nuevos en el repo, sin cache/memo.
- U1/U2/F2: sin notify inline de éxito en TUI, clear vacío no-op, clear activo con una confirmación TUI vía transcript y notify fuera de TUI.

## Gate (secuencial; el build dir de los harnesses es compartido)

Scratch: `C:\Users\andre\AppData\Local\Temp\pi-rules-check`.
1. `./node_modules/.bin/tsc --noEmit -p tsconfig.json` → 0 errores.
2. Desde el workspace: `pi -e agent/extensions/pi-rules.ts --list-models >/dev/null 2>&1` → exit 0 real (sin `NUL`, sin pipe que oculte el exit).
3. Harness W3 en scratch (`widget3/verify.mjs` o extensión del existente `widget/verify.mjs`), con factory y componentes reales: alineación de continuaciones (columna de inicio igual al texto de la 1.ª línea), 1/2/3 líneas según quepa, sin fila reservada, overflow con un solo `...` atenuado, widths -1/0/1/2/3/4/10/20/40/80/300, contenidos short/2-3 líneas/largo/multilínea/acentos/CJK/emoji, `visibleWidth(line) <= width` y ≤ 3 filas, misma instancia con resize y cambio de tema (SGR efectivo por glifo incluidos puntos). Las notificaciones de reglas inline, `@file`, fuera de TUI y `warnIfLarge` permanecen idénticas al baseline. No-vacuidad contra el snapshot pinned del código actual (`ce68d21`/`2ff44e4`: 2 líneas y sin sangría).
4. Suites previas sobre sus snapshots pinned (`ux/verify.mjs` etapas y `widget/verify.mjs` sobre su snapshot original); la suite W1 actual fallará deliberadamente en el conteo de 2 líneas: reportar como esperado, jamás debilitar.
5. `git diff --check`.

Nunca dar por verde un modo vacío, una prueba obsoleta o el emit de TS sin el typecheck estricto. Si se ajusta una aserción, documentar por qué.

## Entrega y commit

- Implementador: DONE/BLOCKED con diff, gates, evidencia y todas las decisiones materiales; nunca commitea. Baseline rojo o dirt inesperado ⇒ BLOCKED, sin limpiar ni auto-autorizar excepciones.
- Revisor independiente: lee este plan (untracked hasta el commit) y el diff; repite gates; verifica invariantes. Máximo 2 iteraciones; desacuerdo no resuelto ⇒ usuario.
- Committer: solo `agent/extensions/pi-rules.ts` y este plan. Nunca el ledger ni `.vscode/sessions.json`. Sin push, amend, version bump ni lockfiles.

Fuera de alcance: autocompletado de `@`, saneamiento de ANSI embebido en reglas, cambios al transcript, a la persistencia o al prompt.
