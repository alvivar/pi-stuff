# Fricciones de uso real — laboratorio RV (2026-08-18)

**Contexto:** t-6f0c (Claude) usó pi-dock como granja de sujetos experimentales para un
experimento de juicio bajo cegado (40 ensayos, 3 agentes residentes, ~145 prompts por pipe,
~50 min de corrida autónoma orquestada por script externo). Cero fallos de la herramienta.
Estas fricciones salieron de ese uso; ordenadas por impacto.
Evidencia/artefactos: `C:\AERO\me\rv-ai-experiment\lab\` (run_trial.mjs, run_trial2.mjs).

---

## F1 — No hay forma de esperar la respuesta a un `send` (impacto: alto)

**Qué pasó:** el patrón obligatorio para uso programático fue: snapshot de tamaño del log →
`send` → poll del log buscando el siguiente `{event:"text"}`. Lo implementé 3 veces
(`waitForText()` en tres scripts) y casi me muerdo: un ACK tardío del prompt anterior podía
quedar dentro del offset del siguiente ensayo y ser tomado como respuesta actual.

**Propuesta:** `pi-dock send <name> <text> --await [--timeout <s>]` que bloquee hasta el
próximo `text` (o `idle`/`failed`) posterior a ESTE prompt y lo imprima por stdout.
Cubre ~90% del uso programático sin tocar la arquitectura (el runner ya serializa la cola).

**Alternativa mínima:** ver F2 (correlación en el log), que permite hacer el await bien
desde fuera.

## F2 — Eventos del log sin correlación prompt→respuesta (impacto: alto)

**Qué pasó:** para auditar que nadie contaminó al sujeto tuve que cruzar a mano el dock log
con el JSONL de sesión (tipos `custom_message`, roles, timestamps). Los eventos `text` no
dicen a qué prompt responden.

**Propuesta:** que `send` devuelva un id (`{ok:true, promptId:"..."}`) y que el runner
emita `{event:"prompt", id}` ... `{event:"text", replyTo:id}` / `{event:"idle", after:id}`.
Los pipelines se vuelven auditables gratis y F1 se puede resolver externamente sin carreras.

## F3 — Resolución de modelos hostil (impacto: medio)

**Qué pasó:** `--model codex/luna` → `model codex/luna not found`, sin pistas. Tuve que
importar el ModelRegistry a mano para descubrir que era `openai-codex/gpt-5.6-luna`
(y de paso que existen `azure-openai-responses/...`, `openai/...`, etc. con ids parecidos).

**Propuesta (cualquiera de las dos):**
- `pi-dock models [filtro]` — lista `provider/id` disponibles (con credenciales resueltas).
- Error con sugerencias: `model codex/luna not found; did you mean: openai-codex/gpt-5.6-luna?`
  (match por substring sobre `provider/id` completo).

## F4 — `ls` no muestra el modelo (impacto: medio)

**Qué pasó:** con 3 agentes de modelos distintos (luna/sol/terra) tuve que abrir los
manifiestos para confirmar quién era quién. El manifiesto ya tiene el campo `model`.

**Propuesta:** columna `model` en `ls`. Barato: es lectura del manifiesto, no del pipe.
(Bonus: columna `budget`.)

## F5 — El log no registra mensajes entrantes por pi-link (impacto: medio, nicho seguridad)

**Qué pasó:** mi auditoría de cegado necesitaba probar que NADIE le habló al sujeto salvo
yo. Los mensajes link (incluidos steers `triggerTurn:false`) no aparecen en el dock log —
solo en el JSONL de sesión como `custom_message`, con otro formato. El dock log da la
ilusión de ser la ventana completa ("the only window into a detached run", dice el
PROPOSAL) pero no lo es cuando el agente está en el link.

**Propuesta:** si la sesión recibe contenido que dispara/entra a contexto sin venir del
pipe, emitir `{event:"external", source:"link", from:"<name>"}` (sin cuerpo, para no
duplicar datos). Mantiene el log como fuente única de verdad del ciclo de vida.

## F6 — `send` con textos largos multilínea por CLI (impacto: bajo)

**Qué pasó:** prompts de coaching de ~1200 caracteres con saltos de línea como argumento
de CLI. Funcionó (execFile con array de args), pero desde un shell interactivo el quoting
es un campo minado en Windows.

**Propuesta:** `pi-dock send <name> --file <path>` o aceptar stdin
(`echo "..." | pi-dock send <name> -`).

## F7 — Sin comando de análisis/expiración del ciclo de vida en lote (impacto: bajo)

**Qué pasó:** al terminar hice `stop` × 3 a mano. Para granjas de N sujetos, un
`pi-dock stop --all` (o por patrón `rv-*`) evitaría dejar runners residentes olvidados —
justo el tipo de basura que el presupuesto intenta acotar.

---

## Lo que NO tocaría

- El diseño sin daemon, estado derivado del pipe: fue lo que hizo la corrida a prueba de
  todo; ni un estado mentiroso en 50 min.
- `spawn`/`send` separados (typo-safety): correcto.
- Presupuesto por prompt con reset en idle: exactamente el alcance necesario para agentes
  desatendidos.
- `--x` flags opacos para extensiones (link): la ortogonalidad dock⊥link funcionó perfecta.

## Nota de caso de uso

pi-dock resultó ideal para algo que quizá no era objetivo del diseño: **agentes como
especímenes** (aislados, presupuestados, forensemente auditables) y no solo como
trabajadores. dock (aislamiento+persistencia+presupuesto) × link (presencia+mensajería) ×
sesiones JSONL (auditoría) es una tríada potente para cualquier experimento con cegado o
evaluación multi-agente reproducible. Si ese caso de uso interesa, F1+F2 son la inversión
con mejor retorno.
