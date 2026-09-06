# Pi Rules — coherencia de confirmaciones y widget

Estado: aprobado con «Go run through!». Autonomía run-through: ejecutar baseline y U1 → U2 → U3 con revisión y commit por tarea; sin push.

## Alcance y roles

- Workspace: `C:\Users\andre\.pi`.
- Único archivo de código: `agent/extensions/pi-rules.ts`.
- Orquestador: `archon@pi-rules`; implementador: `claude@pi-rules`; revisor: `gpt@pi-rules`; committer: `committer@.pi`. Todos en el workspace indicado.
- Principios: simple, eficiente, legible, idiomático; ninguna abstracción o dependencia innecesaria.
- Tres tareas estrictamente secuenciales; implementar → gate → revisión → commit antes de la siguiente. Conflictos no resueltos tras dos iteraciones se elevan al usuario, dado el archivo compartido.
- Presupuesto orientativo de contexto: 150K tokens por worker; compactar en límites de tarea si el trabajo siguiente podría excederlo, nunca durante una tarea.

## Pre-flight obligatorio (tras GO)

El implementador verifica HEAD, `git status --short --branch`, índice vacío y baseline verde ANTES de editar código. No asumir hashes anteriores: otros commits pueden haber llegado.

Estado funcional requerido: transcript siempre completo; widget resumido y theme-aware; clear activo no duplica notify en TUI, pero lo conserva fuera de TUI. Si algún cambio previo sigue sin commit, o hay dirt inesperado, reportar BLOCKED. No limpiar ni adjudicar propiedad a archivos ajenos.

Dirt esperado del orquestador: este plan y `agent/extensions/LEDGER-pi-rules-ux-plan.md`. El plan se incluye en el primer commit; el ledger nunca se incluye y se elimina al terminar.

## U1 — Una confirmación al establecer texto inline

Dónde: rama final del handler `/rules`, notificación `Rules set (... chars)`.

Problema: en TUI, el transcript ya imprime el contenido completo y confirma el cambio.

Cambio: emitir esa notificación de éxito solo fuera de TUI. Conservar siempre la notificación de carga `Rules loaded from ...`, porque informa la ruta. Conservar errores, advertencias, consulta sin argumentos y todos los efectos de persistencia/widget.

Riesgo: bajo. Verificar TUI sin notify redundante; RPC con confirmación; carga desde archivo sigue informando ruta; warnings siguen activos. Transcript completo y appendEntry sin cambios.

## U2 — Clear sin reglas no crea historial ficticio

Dónde: inicio de la rama `trimmed === "clear"` del handler.

Problema: clear repetido persiste entradas de cambio aunque no había reglas activas.

Cambio: si no hay reglas activas, notificar `No rules set` (info) y retornar, sin appendEntry y sin actualizar el widget. Si hay reglas, mantener exactamente el flujo existente: persistir null, quitar widget, una confirmación visible en TUI mediante renderer, notify fuera de TUI.

Riesgo: bajo/medio por introducir un no-op explícito en un comando persistente. Verificar sesión vacía; set → clear → clear; branch con/sin reglas; conteo de entradas y notificaciones por modo. El primer clear efectivo debe persistir; el segundo no. Ningún cambio al restore o al hook del prompt.

## U3 — Widget de una sola línea visual

Dónde: `updateWidget`, componente devuelto a setWidget.

Problema: el límite de 280 caracteres puede envolver el recordatorio en varias líneas.

Cambio: cuando hay reglas, mostrar como máximo una línea visual dentro del ancho recibido por render(width). Conservar el límite MAX_PREVIEW como tope superior, primer renglón y señal de contenido omitido; añadir elipsis por recorte horizontal sin duplicarlas innecesariamente. Mantener marcador y alineación actual cuando quepan. En anchos extremos, priorizar no exceder width (width=0: ninguna celda visible).

Usar utilidades públicas de PI TUI que midan columnas visibles y manejen ANSI/Unicode; no implementar un truncador propio ni usar String.slice como medida del ancho de terminal. El implementador lee documentación completa y fuente pertinente del SDK para decidir el componente/utilidad mínima. No se fija un snippet sin verificar sus garantías.

Invariantes: colores resueltos al renderizar, actualización al cambiar tema o ancho; widget desaparece al clear efectivo; transcript conserva todo el contenido y su wrapping normal. Solo cambia la presentación del widget, no reglas almacenadas/enviadas al modelo.

Riesgo: medio (ancho, Unicode, tema). Verificar widths 0/1/2/10/20/80/300, texto corto/largo/multilínea y Unicode (acentos, CJK, emoji); cada línea <= width en columnas visibles y como máximo una línea. Sin recorte de contenido corto que sí cabe. Re-render tras cambiar ancho/tema sigue correcto.

## Gate reproducible

No hay build/test de proyecto configurado. Se usa typecheck real + carga PI + harness de comportamiento fuera del repo; no afirmar que la carga sola prueba renderizado.

1. Typecheck: desde `C:\Users\andre\AppData\Local\Temp\pi-rules-check`, `./node_modules/.bin/tsc --noEmit -p tsconfig.json`.
2. Smoke: desde workspace, `pi -e agent/extensions/pi-rules.ts --list-models >/dev/null 2>&1`; registrar exit real, no pipeline que lo oculte y nunca `> NUL`.
3. Harness: establecer fuera del repo `C:\Users\andre\AppData\Local\Temp\pi-rules-check\ux\verify.mjs`; comando `node ux/verify.mjs baseline|U1|U2|U3` desde scratch root. Capturar registros reales del extension factory y usar componentes TUI reales. Baseline verifica comportamiento vigente; cada etapa incluye sus criterios y regresiones acumuladas. Guardar snapshots fuera del repo con hashes explícitos, no asumir que HEAD siempre es pre-fix.
4. `git diff --check` sin errores.

Si scratch fue limpiado, reconstruir únicamente allí TypeScript y tsconfig strict/skipLibCheck, con paths a SDK global y pi-tui anidado bajo pi-coding-agent/node_modules. Documentar setup/comandos exactos antes de editar. Ningún gate rojo se ignora; una prueba obsoleta exige baseline explícito y evidencia, no debilitar aserciones.

## Restricciones y revisión

- Workers reportan DONE/BLOCKED al orquestador con diff, gates, pruebas y decisiones materiales. El orquestador transmite decisiones literalmente al revisor.
- Implementador/revisor no commitean. Committer verifica solo scope/higiene, no re-revisa. Sin push/version bumps/lockfiles/deps nuevas.
- Cada commit contiene solo el cambio aprobado; U1 incluye también este plan. Ledger excluido siempre.
- No cambios a lectura de archivos, payload persistido, restauración, hook de prompt, texto completo del transcript, ni notificaciones ajenas al alcance explícito.
- No autocompletado de paths, no deduplicadores globales, no mejoras oportunistas.
