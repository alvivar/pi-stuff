# Pi Rules — widget de hasta dos líneas y color uniforme

Aprobado: «Mejor los orquestamos normalmente. Go run through!».
Autonomía: run-through; baseline → una tarea W1 → revisión → commit, sin push.

## Roles y alcance

Workspace `C:\Users\andre\.pi`.
Código: `agent/extensions/pi-rules.ts`, función `updateWidget` y únicamente imports/comentarios requeridos.
Orquestador `archon@pi-rules`; implementador `claude@pi-rules`; revisor `gpt@pi-rules`; committer `committer@.pi`. Todos deben estar en este workspace.
Plan y ledger del orquestador: este archivo y `agent/extensions/LEDGER-pi-rules-widget-plan.md`. Plan se incluye en commit W1; ledger excluido y eliminado al terminar. No modificar el plan anterior `pi-rules-ux-plan.md`: documenta otro run.
Presupuesto de contexto 150K útiles; compactar antes de trabajo que no quepa, nunca durante tarea. Una tarea en vuelo, callbacks al orquestador; máximo dos iteraciones de review, desacuerdo no resuelto se eleva al usuario.

## B0 — baseline antes de editar

Capturar HEAD, `git status --short --branch`, índice vacío. Último commit conocido bfa5790 (widget una línea); no asumir que sigue en HEAD. Verificar cambios posteriores no alteran el target antes de adoptar otro baseline.

Único dirt permitido: nuevo plan y ledger del orquestador. Otro dirt, staged changes o baseline rojo => BLOCKED, sin limpiar ni autoautorizar excepción. Estado esperado: widget de una línea, transcript completo siempre, sin notify inline duplicado en TUI, clear activo con una confirmación TUI y clear vacío sin persistencia.

Guardar snapshot pre-edit del target con hash explícito fuera del repo. Ejecutar los gates existentes antes de modificar código. Si TEMP ha sido limpiado, restablecer tooling solo allí y reportar setup exacto; ningún fallo se ignora.

## W1 — ajustar presentación sin tocar las reglas

### Problema

Una línea visual resulta demasiado restrictiva. Además, `truncateToWidth` resetea ANSI antes de añadir su elipsis horizontal, por lo que los puntos actuales no comparten el color atenuado del resto del widget.

### Comportamiento requerido

- Hasta DOS líneas visuales. Usar solo una si el texto cabe; no reservar una segunda línea vacía.
- Ajuste natural del preview a la segunda línea. Si sobra contenido tras la segunda, indicar omisión con `...` al final de la última línea visible; no esconder contenido silenciosamente ni añadir marcadores duplicados por el algoritmo. Si cabe todo el preview, no añadir nueva elipsis horizontal.
- Mantener la semántica actual del preview lógico (primer renglón, MAX_PREVIEW=280, indicación de omisión por multilinea/límite). Esta tarea cambia la distribución visual, no qué reglas se guardan o qué se muestra en el transcript.
- Texto, marcador y elipsis generadas deben compartir el color `dim`, incluido cualquier indicador heredado del preview. Resolver tema durante render, no al crear el widget.
- El render de la MISMA instancia debe responder correctamente a cambios de ancho/tema.
- Cada línea debe medir <= width en columnas visibles, incluso con ANSI, CJK, emoji y acentos. Width0: ninguna celda visible. A widths1/2 puede abreviarse el indicador si no cabe; no overflow por padding o elipsis.
- Mantener alineación/marcador anteriores cuando haya espacio. No recortar texto que cabe en dos líneas para reservar espacio innecesario.
- Widget desaparece al clear efectivo; transcript sigue mostrando todo el contenido con wrapping normal.

### Implementación y riesgo

Riesgo medio: wrapping, elipsis y secuencias ANSI. Usar utilidades/componentes públicos de PI TUI; sin truncador/medidor propio, sin cambios al SDK y sin dependencias nuevas. Leer documentación PI completa relevante y fuente instalada antes de escoger las APIs.

Idea a verificar, no snippet obligatorio: resolver wrapping/truncamiento primero y aplicar tema a las líneas finales después. No asumir que colorear externamente corrige resets ANSI interiores: comprobar el estilo efectivo de los glifos de elipsis con pruebas, no solo presencia de una secuencia al comienzo.

Código simple, mínimo, legible e idiomático. No cache/memo/abstracción genérica por anticipación. Si las APIs públicas no satisfacen las garantías con un cambio razonable, reportar BLOCKED y explicar alternativas antes de relajar el contrato.

## Gate y evidencia

Scratch root: `C:\Users\andre\AppData\Local\Temp\pi-rules-check`.
1. Typecheck real: `./node_modules/.bin/tsc --noEmit -p tsconfig.json` desde scratch (strict, paths a SDK global y pi-tui anidado).
2. Smoke: `pi -e agent/extensions/pi-rules.ts --list-models >/dev/null 2>&1` desde workspace; registrar exit real, sin pipe ni `NUL`.
3. Baseline: `node ux/verify.mjs U3` (suite del run anterior, 150 asserts al cierre). Congelar snapshot para volver a correr ese modo sobre su versión original tras W1, no contra la nueva que deliberadamente permite dos líneas.
4. W1: establecer `node widget/verify.mjs` en scratch, con factory y componentes reales. Pruebas: short cabe una; preview cabe exactamente dos sin pérdida/ellipsis adicional; sobrepasa dos con aviso; widths0/1/2/10/20/80/300; multilínea/largo/acento/CJK/emoji; <=2 líneas y ancho seguro; mismo componente con cambio de tema y resize; estilo efectivo del contenido y los puntos igual a dim antes/después del cambio. Añadir no-vacuidad: baseline una línea vs nueva dos cuando se necesita, y baseline elipsis horizontal default vs nueva dim. Regresiones: transcript completo, U1 notificaciones, U2 clear no-op, clear activo, payload/prompt intactos.
5. `git diff --check`.

Ejecutar harnesses SECUENCIALMENTE porque comparten build dir. No atribuir verde a modos vacíos, pruebas obsoletas o emit TypeScript sin typecheck. Documentar cualquier ajuste de aserción con su razón y conservar pruebas ancladas a snapshots/hashes explícitos.

## Contrato de entrega y commit

Implementador reporta DONE/BLOCKED, diff, gates, evidencia y TODAS decisiones materiales; no commitea. Reviewer independiente evalúa diff y plan nuevo (untracked requiere lectura explícita), repite gates y verifica invariantes. Orquestador transmite decisiones literalmente, nunca revisa código.

Committer, tras APPROVE: solo target y este plan. No ledger, otros archivos, push, amend, version bump ni lockfiles. Higiene inesperada o hook que muta archivos => BLOCKED al orquestador, sin limpiar o bypass.

Fuera de alcance: comandos/notificaciones/persistencia/prompt/renderer del transcript, contenido del preview lógico, lectura de archivos, autocompletado, color de reglas con escapes ANSI arbitrarios embebidos (no expandir tarea a saneamiento de entradas).
