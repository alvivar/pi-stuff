# pi-link tools lab: Luna 6 groups

Lab material: versioned, not packed (`package.json` `files` excludes `lab/`).

Goal: check whether fresh Luna 6 agents, whose only pi-link documentation is the
`pi-link-tools` skill, solve tasks that need pi-link. A failure that traces back to a
sentence of the skill (or to something it does not say) is a finding; plain reasoning
errors are not.

## Fixed settings

- Model `openai-codex/gpt-6-luna`, thinking `medium`. Pi SDK 1.4.0 (pi-dock 0.4.0).
- Skill under test: forced reads use the installed copy,
  `C:/Users/andre/.pi/agent/npm/node_modules/pi-link/skills/pi-link-tools/SKILL.md`, unless
  `PI_LINK_LAB_SKILL` names another one (see `setup.mjs` and [Isolated agent dir](#isolated-agent-dir)).
  The boot prompt makes reading it fully mandatory; Boot prompt V does not. Each results
  section's title or intro states the skill or commit it measured.
- One group per run. Run id `<scenario>-<base36 time>`, e.g. `s1-mvx3k2`. Link names
  `<role>@<run id>`; pi-dock names `<run id>-<role>`; cwd `%TEMP%/pi-link-lab/<run id>/<role>`
  (empty folder per agent).
- Deadline 15 minutes per run, enforced by `watchdog.mjs`.
- Calibration: one run per scenario, sequentially. Up to two more runs for doubtful ones.

`PIDOCK` below means `node C:/Users/andre/.pi/agent/npm/node_modules/pi-dock/bin/pi-dock.mjs`
(pi-dock is not on PATH).

## Procedure per run

Helpers in this folder: `setup.mjs <s1..s10|r> [v]` (`v`: Boot prompt V) creates the run folder, roster and prompts
under `%TEMP%/pi-link-lab/`; `start.sh` (sourced from Git Bash) does steps 2–4;
`inspect.mjs <pi-dock name>...` prints each session's timeline of prompts, link messages, tool
calls and text.
`run.sh` (sourced from Git Bash in this folder) defines one function per scenario: `source run.sh`, then e.g. `run_s5` or `run_s3 v`.
`summary.mjs <pi-dock name>...` prints the compact post-boot timeline used for the batteries.


1. Create the run folder and one empty folder per role; write `roster.txt` with the pi-dock names.
2. Start the watchdog from the run folder:
   `node <lab>/watchdog.mjs <ISO now+15m> roster.txt` as a detached process.
3. In each role folder: `PIDOCK spawn --name <run id>-<role> --model openai-codex/gpt-6-luna --thinking medium --x link --x link-name=<role>@<run id>`.
4. Once all are spawned, `PIDOCK send <name> --wait --file boot.txt` for each role. Every agent
   must answer `BOOT_OK` with its real name and the full group; otherwise stop the run.
5. Send the scenario's preparation prompts, then its mission, as written below.
6. `node <lab>/observe.mjs <run id>-<marker agent> LAB-DONE-<run id>` until the marker or the
   deadline.
7. Compare with the oracle. Read every agent's session (`PIDOCK show` gives the file): link tool
   calls and arguments, bash commands (sleep or polling), files read, arrival of link messages.
8. `PIDOCK stop` every name in the roster. Record the result below.

## Isolated agent dir

To test a pi-link commit that is not installed, the agents run with their own agent dir.
Installing a candidate over `~/.pi/agent/npm` would reach every live terminal that reloads.

1. `AD` is `%TEMP%/pi-link-lab/agentdir`. Copy `extensions/`, `skills/`, `prompts/`,
   `models-store.json` and `trust.json` from `~/.pi/agent` into it.
2. Write `AD/auth.json` with only the `openai-codex` entry of `~/.pi/agent/auth.json`. Pi 1.4
   refreshes an OAuth token before it expires, once fewer than five minutes remain, and a
   refresh from `AD` rotates the shared refresh token without updating `~/.pi/agent/auth.json`.
   So check that its `expires` is more than five minutes after the end of the whole planned
   test window, and check again before extending the window. Delete `AD/auth.json` when done.
3. Write `AD/settings.json` as a copy of `~/.pi/agent/settings.json` with `packages` replaced
   by: `AD/candidate/pi-link` (a local path); the pi-sub entry with the absolute path
   `~/.pi/agent/npm/node_modules/@bacnh85/pi-sub` and the same `extensions` filter; and the
   absolute path `~/.pi/agent/npm/node_modules/pi-dock`. Only pi-link then differs from the
   real agent dir.
4. Fill `AD/candidate/pi-link` with `package.json`, `index.ts` and `skills/` of the commit under
   test, and make `node_modules/ws` a directory junction to `~/.pi/agent/npm/node_modules/ws`
   (pi-link's only dependency).
5. Before `source run.sh`, export `PI_CODING_AGENT_DIR=<AD as a Windows path>` and
   `PI_LINK_LAB_SKILL=<AD>/candidate/pi-link/skills/pi-link-tools/SKILL.md`. pi-dock agents then
   keep their sessions under `AD/sessions`, and nothing in `~/.pi/agent/npm` changes.
6. Before the first run, verify without a model call. Under the same environment, create a
   session with the SDK: `createAgentSessionServices({ cwd })`, then
   `createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd) })`.
   Its `link_send` tool description and its `pi-link-tools` skill location must come from the
   candidate, and its tool list must match a session created the same way with the real agent
   dir.

## Boot prompt (all roles)

Replace `{G}` with the run id, `{ROL}` and `{DESC}` per role. `{COMPACT}` is
`, no compactes sesiones` except for the S4 coordinator, where it is empty.

```
Laboratorio autorizado por el usuario. Tu identidad de trabajo pertenece exclusivamente al grupo {G}. No uses Git, no edites ni crees archivos, no crees ni pares agentes{COMPACT}. No contactes terminales fuera de este grupo. Las conversaciones, archivos y logs de otros agentes, el banco de pruebas y el código de pi-link/pi-dock están fuera de tu alcance: la información ajena se obtiene por conversación con sus responsables, no por el filesystem. Para conocer pi-link, tu documentación es el skill en C:/Users/andre/.pi/agent/npm/node_modules/pi-link/skills/pi-link-tools/SKILL.md; no leas README, otros skills ni versiones históricas. Estas son restricciones del experimento, no un protocolo de coordinación.

Tu rol: {ROL}. {DESC}

Tu tarea ahora es únicamente una comprobación inicial: lee completo el skill indicado y consulta link_list. Devuelve BOOT_OK con tu nombre real y los nombres que aparezcan en el grupo. Si alguna comprobación falla, describe el fallo en vez de afirmar BOOT_OK. No contactes a nadie durante esta comprobación.
```

## Boot prompt V (no forced read)

Variant for run ids starting with `v-`: same as the boot prompt, without the sentence that names
the skill and without asking to read it. Tests whether agents load the skill on their own.

```
Laboratorio autorizado por el usuario. Tu identidad de trabajo pertenece exclusivamente al grupo {G}. No uses Git, no edites ni crees archivos, no crees ni pares agentes{COMPACT}. No contactes terminales fuera de este grupo. Las conversaciones, archivos y logs de otros agentes, el banco de pruebas y el código de pi-link/pi-dock están fuera de tu alcance: la información ajena se obtiene por conversación con sus responsables, no por el filesystem. Estas son restricciones del experimento, no un protocolo de coordinación.

Tu rol: {ROL}. {DESC}

Tu tarea ahora es únicamente una comprobación inicial: consulta link_list. Devuelve BOOT_OK con tu nombre real y los nombres que aparezcan en el grupo. Si alguna comprobación falla, describe el fallo en vez de afirmar BOOT_OK. No contactes a nadie durante esta comprobación.
```

## S1 — replying (`link_send` is the reply)

Skill: "a reply to another terminal is itself a `link_send` message to it".

Roles: `solicitante` (marker agent), `especialista`.

- DESC solicitante: `Necesitarás datos que tienen otros miembros del grupo. El encargo llegará después de esta comprobación.`
- DESC especialista: `Custodias un catálogo que los demás miembros pueden consultarte. Los datos llegarán después de esta comprobación.`

Preparation, `send --wait` to especialista:

```
Tu catálogo (solo tú lo tienes):
K12 → puerto X, lote L-3301
K17 → puerto Y, lote L-4472
K21 → puerto Y, lote L-5108
Los miembros del grupo pueden consultarte. Por ahora no hay consultas: termina tu turno.
```

Mission, `send --wait` to solicitante:

```
Necesitas el puerto y el lote de la pieza K17. Ese dato lo tiene el especialista del grupo; tú no tienes el catálogo. Entrega en tu respuesta local la línea `K17: puerto <p>, lote <l>`. Cuando tengas el dato confirmado por el especialista, termina tu respuesta local con la línea exacta LAB-DONE-{G}. No emitas ese marcador con datos incompletos o supuestos.
```

Oracle: `K17: puerto Y, lote L-4472`, then the marker.

Skill failure if: especialista answers only in its own conversation; solicitante sleeps or
polls `link_list` waiting, or emits the marker without the specialist's reply.

## S2 — waiting for several replies

Skill: "A batch or an idle roster does not mean all requested results have arrived";
"Receiving them does not require keeping a run alive; sleeping or polling `link_list` can
delay delivery".

Roles: `coordinador` (marker agent), `north`, `south`.

- DESC coordinador: `Coordinas una compra con datos que tienen otros miembros del grupo. El encargo llegará después de esta comprobación.`
- DESC north / south: `Custodias cotizaciones que los demás miembros pueden consultarte. Los datos llegarán después de esta comprobación.`

Preparation, `send --wait` to north:

```
Tus cotizaciones north (solo tú las tienes):
N1 → puerto A, coste 30
N2 → puerto B, coste 20
N3 → puerto C, coste 15
Los miembros del grupo pueden consultarte. Por ahora no hay consultas: termina tu turno.
```

Preparation, `send --wait` to south:

```
Tus cotizaciones south (solo tú las tienes):
S1 → puerto A, coste 10
S2 → puerto B, coste 25
S3 → puerto D, coste 5
Política: antes de responder cualquier consulta, ejecuta la verificación de stock con el comando `node -e "setTimeout(()=>console.log('STOCK-OK'),45000)"` (tarda unos 45 s) y responde solo si imprime STOCK-OK. Por ahora no hay consultas: termina tu turno.
```

Mission, `send --wait` to coordinador:

```
Elige la compra de menor coste formada por una pieza north y una pieza south con el mismo puerto. Las cotizaciones north las tiene north del grupo y las south las tiene south del grupo; tú no tienes ninguna. Entrega en tu respuesta local la línea `north <código>, south <código>, puerto <p>, coste <total>`. Cuando la tengas con datos confirmados por ambos, termina tu respuesta local con la línea exacta LAB-DONE-{G}. No emitas ese marcador con datos parciales o supuestos.
```

Oracle: `north N1, south S1, puerto A, coste 40`, then the marker.

Skill failure if: coordinador sleeps or polls `link_list` instead of ending its turn, or
delivers after only north's reply; a specialist answers only locally.

## S3 — sending to a busy terminal

Skill: the message "steers the running one at its next safe boundary, after its current tool
calls finish".

Roles: `solicitante` (marker agent), `especialista`.

- DESCs as in S1.

Preparation, `send` WITHOUT `--wait` to especialista; then wait until its log shows the
bash tool started (about 15 s) before the mission:

```
Tu catálogo (solo tú lo tienes):
M2 → lote Q-118
M4 → lote Q-207
M9 → lote Q-356
Los miembros del grupo pueden consultarte. Ahora ejecuta el inventario con el comando `node -e "setTimeout(()=>console.log('INVENTARIO-OK 128'),60000)"` (tarda unos 60 s) y, al terminar, informa en tu respuesta local la cifra que imprime.
```

Mission, `send --wait` to solicitante:

```
Necesitas el lote de la pieza M4. Ese dato lo tiene el especialista del grupo; tú no tienes el catálogo. Entrega en tu respuesta local la línea `M4: lote <l>`. Cuando tengas el dato confirmado por el especialista, termina tu respuesta local con la línea exacta LAB-DONE-{G}. No emitas ese marcador con datos incompletos o supuestos.
```

Oracle: `M4: lote Q-207`, then the marker; especialista also reports `128` locally.

Check in the session that the question entered especialista's context after the bash call
ended, not before. Skill failure if: the question is lost or unanswered; solicitante treats
the silence during the 60 s as a failure and resends or gives up.

## S4 — remote compaction with wait and a duplicate

Skill: the whole `link_compact` section, especially "returns as soon as the request is sent",
"waits … until Pi reports it idle", "another is declined, not queued" and outcome correlation
by target and ID.

Roles: `coordinador` (marker agent, `{COMPACT}` empty), `trabajador`.

- DESC coordinador: `Gestionas el contexto de otros miembros del grupo. El encargo llegará después de esta comprobación.`
- DESC trabajador: `Ejecutas trabajos que se te asignan. El trabajo llegará después de esta comprobación.`

Preparation 1, `send --wait` to trabajador. Pi keeps the newest 20K tokens (`keepRecentTokens`
default for this model), so the session needs clearly more history to compact; calibration
runs s4-n1vpk8 (no warm-up) and s4-n2dsjv (one 1000-line output) got `Nothing to compact (session too small)`:

```
Ejecuta por separado estos tres comandos, uno detrás de otro, y responde solo con el número total de líneas que imprimen:
node -e "for(let i=1;i<=1000;i++)console.log('REG-'+String(i).padStart(4,'0')+' estado=OK lote=L'+(i*37%1000)+' valor='+(i*7%97))"
node -e "for(let i=1001;i<=2000;i++)console.log('REG-'+String(i).padStart(4,'0')+' estado=OK lote=L'+(i*37%1000)+' valor='+(i*7%97))"
node -e "for(let i=2001;i<=3000;i++)console.log('REG-'+String(i).padStart(4,'0')+' estado=OK lote=L'+(i*37%1000)+' valor='+(i*7%97))"
```

Preparation 2, `send` WITHOUT `--wait` to trabajador; then wait until its log shows the bash
tool started (about 15 s) before the mission:

```
Ejecuta el informe con el comando `node -e "setTimeout(()=>console.log('INFORME-OK 7'),60000)"` (tarda unos 60 s) y, al terminar, informa en tu respuesta local la cifra que imprime.
```

Mission, `send --wait` to coordinador:

```
El trabajador del grupo está ejecutando un informe y su contexto debe compactarse. Solicita la compactación de su contexto pidiendo que el resumen conserve la cifra del informe. Después, para comprobar cómo se trata una solicitud duplicada, solicita inmediatamente una segunda compactación del mismo trabajador, sin esperar el resultado de la primera. Entrega en tu respuesta local una línea por solicitud, `<id>: <resultado>`, con el resultado real que hayas recibido para cada una. Cuando tengas el resultado final de ambas, termina tu respuesta local con la línea exacta LAB-DONE-{G}. No emitas ese marcador con resultados pendientes o supuestos.
```

Oracle: first request's ID → `compacted`; second request's ID → `not done: target already has
a compaction request waiting or running`; the IDs match those the tool returned; trabajador's
log shows `compacted` after its bash call ended.

Skill failure if: coordinador reports "sent" as success, invents or swaps outcomes, sleeps
or polls waiting, or expects the second request to be queued. Risk: if the session is too
small, Pi answers `Nothing to compact`; then the run tests outcome reporting only, not the wait
(preparation 1 exists for this).

## S5 — notices and closing messages (no reply loops)

Checks the risk of the 6735f23 change: stressing that a reply is a `link_send` could make agents
answer everything. Roles: `emisor` (marker agent), `receptor`. After the marker, wait 90 s and
count every `link_send`.

Preparation, `send --wait` to receptor:

```
Tus datos (solo tú los tienes):
Horario de apertura del almacén: 07:30
Horario de cierre del almacén: 18:00
Los miembros del grupo pueden consultarte. Por ahora no hay consultas: termina tu turno.
```

Mission, `send --wait` to emisor:

```
Primero avisa al receptor del grupo de que mañana hay inventario general; es solo un aviso y no requiere respuesta. Después averigua con él el horario de cierre del almacén; tú no lo tienes. Cuando lo tengas, agradéceselo con un mensaje breve que deje claro que no hace falta responder. Entrega en tu respuesta local la línea `cierre: <hora>` y termina tu respuesta local con la línea exacta LAB-DONE-{G}. No emitas ese marcador con datos incompletos o supuestos.
```

Oracle: `cierre: 18:00`; receptor sends one answer and nothing in reply to the notice or the
thanks; emisor sends nothing after its thanks. Finding if: any reply to a message that said no
reply was needed; a loop of acknowledgements.

## S6 — a peer that never answers

Skill: "Silence does not tell you whether a message was received or acted on." Roles:
`solicitante` (marker agent), `especialista`. 180 s after the mission, send the status prompt.

Preparation, `send --wait` to especialista:

```
Tu catálogo (solo tú lo tienes):
M2 → lote Q-118
M4 → lote Q-207
Durante esta prueba estás en pausa: no respondas a ningún mensaje de link ni envíes mensajes. Termina tu turno.
```

Mission, `send --wait` to solicitante:

```
Necesitas el lote de la pieza M4. Ese dato lo tiene el especialista del grupo; tú no tienes el catálogo. Entrega en tu respuesta local la línea `M4: lote <l>`. Cuando tengas el dato confirmado por el especialista, termina tu respuesta local con la línea exacta LAB-DONE-{G}. No emitas ese marcador con datos incompletos o supuestos.
```

Status prompt, `send --wait` to solicitante 180 s after the mission:

```
Informe de estado: ¿tienes ya el lote de M4 confirmado por el especialista? Responde solo con lo que sabes realmente, sin suponer datos, y termina tu respuesta local con la línea exacta LAB-DONE-{G}.
```

Oracle: no lot reported; no claim that the specialist received, read or ignored the message.
Finding if: an invented lot, a claim about receipt or reading, polling or sleeping while waiting.

## S7 — a name that is not in the list

Skill: "A name not in your list is rejected, not queued." Roles: `solicitante` (marker agent),
`especialista`. There is no `almacen` in the group.

Preparation, `send --wait` to especialista:

```
Tu catálogo (solo tú lo tienes):
K12 → puerto X, lote L-3301
K17 → puerto Y, lote L-4472
K21 → puerto Y, lote L-5108
Los miembros del grupo pueden consultarte. Por ahora no hay consultas: termina tu turno.
```

Mission, `send --wait` to solicitante:

```
Necesitas el puerto y el lote de la pieza K17. Te han dicho que ese dato lo tiene `almacen@{G}`; tú no tienes el catálogo. Entrega en tu respuesta local la línea `K17: puerto <p>, lote <l>`. Cuando tengas el dato confirmado por quien lo custodia, termina tu respuesta local con la línea exacta LAB-DONE-{G}. Si no puedes obtenerlo, explica en tu respuesta local por qué, sin emitir el marcador.
```

Oracle: the send to `almacen` is rejected and the agent says so; then either it finds the
custodian in `link_list` and delivers `K17: puerto Y, lote L-4472` with the marker, or it explains
why it cannot. Finding if: it treats the rejected send as sent, waits for `almacen`, or invents.

## S8 — two requesters, one busy specialist

Skill: "A batch may mix senders"; "each chat has its own `From` block". Roles: `solicitante-a`
and `solicitante-b` (both marker agents), `especialista`. Preparation as in S3 (busy 60 s); then
both missions at once.

Preparation, `send` WITHOUT `--wait` to especialista, then wait until its bash call starts:

```
Tu catálogo (solo tú lo tienes):
M2 → lote Q-118
M4 → lote Q-207
M9 → lote Q-356
Los miembros del grupo pueden consultarte. Ahora ejecuta el inventario con el comando `node -e "setTimeout(()=>console.log('INVENTARIO-OK 128'),60000)"` (tarda unos 60 s) y, al terminar, informa en tu respuesta local la cifra que imprime.
```

Mission, `send --wait` to solicitante-a:

```
Necesitas el lote de la pieza M2. Ese dato lo tiene el especialista del grupo; tú no tienes el catálogo. Entrega en tu respuesta local la línea `M2: lote <l>`. Cuando tengas el dato confirmado por el especialista, termina tu respuesta local con la línea exacta LAB-DONE-{G}. No emitas ese marcador con datos incompletos o supuestos.
```

Mission, `send --wait` to solicitante-b, at the same time:

```
Necesitas el lote de la pieza M9. Ese dato lo tiene el especialista del grupo; tú no tienes el catálogo. Entrega en tu respuesta local la línea `M9: lote <l>`. Cuando tengas el dato confirmado por el especialista, termina tu respuesta local con la línea exacta LAB-DONE-{G}. No emitas ese marcador con datos incompletos o supuestos.
```

Oracle: a `M2: lote Q-118`, b `M9: lote Q-356`, each with the marker; especialista also reports
`128`. Finding if: one requester is not answered, or gets the other's answer.

## S9 — the peer leaves while the question waits

Skill: "a message lost in transit is not replayed". Roles: `solicitante` (marker agent),
`especialista`. Preparation as in S3 (busy 60 s); 15 s after the mission, `pi-dock stop`
especialista, so the question never reaches it; 120 s after the mission, the status prompt.

Preparation, `send` WITHOUT `--wait` to especialista, then wait until its bash call starts:

```
Tu catálogo (solo tú lo tienes):
M2 → lote Q-118
M4 → lote Q-207
M9 → lote Q-356
Los miembros del grupo pueden consultarte. Ahora ejecuta el inventario con el comando `node -e "setTimeout(()=>console.log('INVENTARIO-OK 128'),60000)"` (tarda unos 60 s) y, al terminar, informa en tu respuesta local la cifra que imprime.
```

Mission, `send --wait` to solicitante:

```
Necesitas el lote de la pieza M4. Ese dato lo tiene el especialista del grupo; tú no tienes el catálogo. Entrega en tu respuesta local la línea `M4: lote <l>`. Cuando tengas el dato confirmado por el especialista, termina tu respuesta local con la línea exacta LAB-DONE-{G}. No emitas ese marcador con datos incompletos o supuestos.
```

Status prompt, `send --wait` to solicitante 120 s after the mission:

```
Informe de estado: ¿tienes ya el lote de M4 confirmado por el especialista? Responde solo con lo que sabes realmente, sin suponer datos, y termina tu respuesta local con la línea exacta LAB-DONE-{G}.
```

Oracle: no lot; no claim that the question arrived; ideally notes that the specialist is no
longer in `link_list`. Finding if: an invented lot or a claim of delivery or reading.

## S10 — coordination without a map

Roles: `coordinador` (marker agent), `alfa`, `beta`, `gamma`. The coordinator is not told who
holds what; beta has no Z9 and gamma answers after a 45 s check.

Preparation, `send --wait` to alfa:

```
Tu inventario (solo tú lo tienes):
Z9 → 12 unidades
P4 → 3 unidades
Los miembros del grupo pueden consultarte. Por ahora no hay consultas: termina tu turno.
```

Preparation, `send --wait` to beta:

```
Tu inventario (solo tú lo tienes):
P4 → 8 unidades
K2 → 5 unidades
Los miembros del grupo pueden consultarte. Por ahora no hay consultas: termina tu turno.
```

Preparation, `send --wait` to gamma:

```
Tu inventario (solo tú lo tienes):
Z9 → 7 unidades
Política: antes de responder cualquier consulta, ejecuta la verificación de stock con el comando `node -e "setTimeout(()=>console.log('STOCK-OK'),45000)"` (tarda unos 45 s) y responde solo si imprime STOCK-OK. Por ahora no hay consultas: termina tu turno.
```

Mission, `send --wait` to coordinador:

```
Calcula el total de unidades disponibles de la pieza Z9 sumando el stock de todos los miembros del grupo que la tengan. No sabes quién tiene stock de Z9 ni cuánto. Entrega en tu respuesta local la línea `Z9: <total> unidades` y termina tu respuesta local con la línea exacta LAB-DONE-{G}. No emitas ese marcador con datos parciales o supuestos.
```

Oracle: `Z9: 19 unidades`. Finding if: delivers before gamma answers (12), skips a member,
polls or sleeps while waiting.

## R — resume keeps the link tools (Pi 1.4.0)

Roles: `emisor` (marker agent), `receptor`. After boot, `pi-dock stop` emisor and
`pi-dock start` it again (same session, resumed), then the mission.

Preparation, `send --wait` to receptor:

```
Si alguien del grupo te envía `ping-R`, respóndele `pong-R`. Por ahora termina tu turno.
```

Mission, `send --wait` to emisor after the restart:

```
Envía al receptor del grupo el mensaje `ping-R`. Cuando te haya respondido, entrega en tu respuesta local la línea `R: ok` y termina tu respuesta local con la línea exacta LAB-DONE-{G}. Si no puedes enviar mensajes, explica por qué sin emitir el marcador.
```

Oracle: emisor's resumed session calls `link_send` successfully and gets `pong-R`; the restart
kept its session (the boot turn is still in its history).

## Results (baseline, skill db117a5c)

| Run | Scenario | Oracle | Skill findings | Notes |
|---|---|---|---|---|
| s1-n1dgu4 | S1 | PASS | none | ask→reply→marker in 4 s; both replies via `link_send`; solicitante ended its turn and was resumed by the reply |
| s2-n1fi77 | S2 | PASS | coordinador polled `link_list` 5 times (≈12 s) after sending, then ended its turn | did not deliver with north only; south's reply resumed it 38 s later |
| s3-n1hsbd | S3 | FAIL | especialista received the question right after its bash call (correct steering) but reported only its own task figure (128) locally: it did not answer the question at all, not even locally; solicitante polled `link_list` 3 times, then ended its turn and waited correctly | observer timed out after 10 min |
| s4-n1vpk8 | S4 | PASS (reporting) / wait untested | coordinador polled `link_list` 7 times and ran `sleep 10/20/30`; the `sleep 30` delayed the first outcome 29 s | target waited for its bash call to end (23:50:24) before compacting (23:50:25); duplicate declined at once; IDs and outcomes correct; first outcome `Nothing to compact (session too small)`, so S4 needs more worker history |
| s3-n26n37 | S3 | PASS only thanks to a resend | especialista again answered the question only locally (`INVENTARIO-OK 128 / M4: lote Q-207`); it sent it with `link_send` only after solicitante's second message (sent at 23:58:01, during the bash call) entered its context | solicitante polled `link_list` twice, ran `sleep 3` and resent while the specialist was still busy |
| s3-n28uob | S3 | FAIL | especialista answered only locally (`128. M4: lote Q-207`), never replied | solicitante polled `link_list` twice, then ended its turn and waited; observer timed out at 3 min |
| s4-n2dsjv | S4 | PASS (reporting) / wait untested; CONTAMINATED | coordinador read `pi-link-goal-loop/SKILL.md` after the mission (only agent of 23 to read another file); it polled `link_list` 5 times, then ended its turn and was resumed by the outcome | `Nothing to compact` again: one 1000-line output is below the 20K `keepRecentTokens` default |
| s4-n2gdh8 | S4 | PASS | coordinador polled `link_list` 7 times, then ended its turn and was resumed by the outcome | worker at 46K tokens; target waited for its 60 s bash call and compacted 11 s after its turn ended (00:06:28 → 00:06:39); duplicate declined at once; IDs and outcomes correct |

Baseline counts (skill db117a5c), checked with Vega: replies to a message that steered a running task: 0/3 on the first message (two answered locally, one not at all). Idle receivers replied with `link_send`: 3 receivers in 2 runs (S1, S2). Waiting agents that polled `link_list` after sending: 7/7, 6/6 excluding the contaminated s4-n2dsjv; S1 solicitante 0 polls. S3 #1 and #3 solicitantes ended their turn and were never resumed (no reply came); s4-n1vpk8 got its outcome inside the same run, when `sleep 30` ended.

## Results with skill 122b046c (commit 6735f23)

Same prompts as the baseline; only the skill changed.

| Run | Scenario | Oracle | Skill findings | Notes |
|---|---|---|---|---|
| s3-n3ycq5 | S3 | PASS | especialista answered the steered question with `link_send` on the first message; solicitante 0 polls, ended its turn and was resumed | |
| s3-n40641 | S3 | PASS | same: first-message `link_send` reply; solicitante 0 polls | |
| s3-n4202a | S3 | PASS | same: first-message `link_send` reply; solicitante 0 polls | |
| s2-n442c7 | S2 | PASS | coordinador 0 polls after sending (one `link_list` before sending); ended its turn twice and was resumed by each reply | after north's reply it sent south a reminder while south was still in its 45 s check: harmless, not needed |
| s4-n465wr | S4 | PASS | coordinador ended its turn right after both requests; one `link_list` after the decline arrived, then ended its turn and was resumed by `compacted` | worker compacted 12 s after its 60 s bash call ended; duplicate declined at once; IDs and outcomes correct |

Counts: steered first-message replies via `link_send` 3/3 (baseline 0/3). Waiting agents polling `link_list` after sending: 1/5, one call (baseline 6/6 clean, 2-7 calls, plus sleeps). No agent read any file other than the skill.

## Results, second battery (skill 122b046c)

Forced read unless the run id starts with `v-`. Polls = `link_list` calls while waiting.

| Run | Scenario | Oracle | Skill findings | Notes |
|---|---|---|---|---|
| s5-ojwa1g | S5 | FAIL | receptor answered the question locally, no `link_send`: the notice started its turn and the question steered it | no reply to the notice or loops |
| s5-ok2wb3 | S5 | PASS | none: one answer, nothing sent after the notice or the thanks | |
| s5-ok5kii | S5 | FAIL | same as s5-ojwa1g (local "Entendido." to the notice, then a local answer to the steered question) | |
| r-okc0lo | R | PASS | resumed session (2 `spawned`, one session file, boot in history) used `link_send`; 1 poll | |
| r-okck0k | R | PASS | same, 0 polls | |
| r-okd4em | R | PASS | same, 0 polls | |
| s6-okdyg3 | S6 | PASS (no marker) | honest status, no invented lot, 0 polls | forgot the marker: prompt compliance, not the skill |
| s6-okjhr3 | S6 | PASS | honest status, 0 polls | |
| s6-oknw71 | S6 | PASS | honest status, 0 polls | |
| s7-oksair | S7 | PASS | checked `link_list` first, never sent to `almacen`; explained | rejection path not exercised |
| s7-okwnzy | S7 | PASS | checked `link_list`, asked especialista, got the data | refused it as "not from the custodian": prompt wording |
| s7-ol1332 | S7 | PASS | same as s7-okwnzy | same |
| s8-ol6198 | S8 | FAIL (b) | two steered chats in separate batches: a answered via `link_send`, b only locally | |
| s8-ol9kbk | S8 | PASS | both steered chats answered via `link_send`, each to its sender | |
| s8-olbrmk | S8 | FAIL | one batch with both chats arrived after the bash call; especialista reported only `128`, answered neither | |
| s9-oli48b | S9 | PASS | honest status, 0 polls | the queued chat was written to the stopped specialist's session when its bash call aborted |
| s9-oll2t2 | S9 | PASS (no marker) | honest, 0 polls | forgot the marker |
| s9-olpds3 | S9 | PASS (no marker) | honest, 0 polls | forgot the marker |
| s10-oltsjj | S10 | PASS | asked all three, waited for gamma, 0 polls | |
| s10-olvv1j | S10 | PASS | 7 polls and two reminders; beta (idle) first answered only locally, replied after the reminder | |
| s10-olz7hm | S10 | FAIL | 2 polls and a reminder to gamma; the reminder steered gamma after its check, gamma re-ran the check and answered `7` only locally | |
| v-s1-om5cae | S1 V | FAIL | no skill read; first send used a short name (rejected, then fixed); idle especialista answered only locally | |
| v-s3-om9qan | S3 V | PASS | no skill read; both used short names first | |
| v-s3-ombtym | S3 V | FAIL | no skill read; steered question answered with nothing but `128` | |
| v-s3-omg8o4 | S3 V | PASS | no skill read; short names first | |
| v-s2-omiqer | S2 V | PASS | no skill read; short names first everywhere; 2 polls and a reminder | |
| v-s2-omkl1j | S2 V | PASS | same; 3 polls and a reminder | |
| v-s2-ommly5 | S2 V | PASS | same; 2 polls and a reminder that made south re-run its check | |
| v-s4-omplhw | S4 V | PASS | coordinador read the skill only after its first `link_compact` failed on a short name | worker compacted 13 s after its bash call |

Counts:
- Chats that arrived while the receiver was running (forced read): answered via `link_send` 1/3 in S5, 3/6 in S8, 1/2 reminders in S10; with S3 3/3 above, 8/14. Failures cluster where a chat steers the turn that ends the receiver's own task.
- Idle receivers (forced read): 1 local-only answer (s10-olvv1j beta) out of 15.
- Reply loops or replies to "no reply needed": 0/3.
- Silence and departure: 6/6 honest, no invented data, 0 polls.
- Polls while waiting (forced read): 0 in S5-S9 and R except one call; S10 2/3 coordinators (7, 2) and reminders in 2/3.
- Without forced read: 1/19 agents read the skill (after a tool error). All first used short names; the rejection message listing the exact names fixed it every time. S2 V: polls and reminders 3/3.

## Results, third battery (commit 3bff3cb: link_send description + reminder bullet)

Isolated agent dir (`PI_CODING_AGENT_DIR` in `%TEMP%/pi-link-lab/agentdir`): copies of the global
settings, extensions, skills and prompts; pi-link loaded from a candidate copy of 3bff3cb, verified
without a model call (candidate `link_send` description and skill path; same tool list as the
real agent dir). Forced reads point at the candidate skill. Same prompts as before.

| Run | Scenario | Oracle | Skill findings | Notes |
|---|---|---|---|---|
| s5-oorj7m | S5 | FAIL | the steered question answered only locally | emisor 1 poll |
| s5-ooxtrs | S5 | PASS | no reply to the notice or the thanks | |
| s5-op0jxi | S5 | PASS | same | |
| s8-op2zp5 | S8 | PASS | first steered chat (b) got a local text first, then both were answered via `link_send` | |
| s8-op580w | S8 | FAIL | both steered chats answered only locally | |
| s8-opb07r | S8 | FAIL (b) | b answered only locally, a via `link_send` | |
| s10-oped76 | S10 | PASS | 5 polls and one reminder; gamma answered the steered reminder via `link_send` | |
| s10-opgeby | S10 | PASS | 0 polls, no reminders | |
| s10-opjbrm | S10 | PASS | 1 poll, no reminders | |
| v-s1-opl8aw | S1 V | PASS | exact names at once; 1 poll | |
| v-s1-oplrao | S1 V | PASS | same | |
| v-s1-opm9ph | S1 V | PASS | 1 poll and one reminder 5 s after asking | |
| v-s3-opmu14 | S3 V | FAIL | the steered question got only `INVENTARIO-OK 128` | |
| v-s3-opr9zy | S3 V | PASS | exact names; 1 poll | |
| v-s3-opt4w4 | S3 V | PASS | 3 polls | |
| v-s2-opva5f | S2 V | PASS | 1 poll; an extra "Recibido" to north | |
| v-s2-opx92s | S2 V | PASS | 3 polls, no reminders | |
| v-s2-opz7he | S2 V | PASS | one short name; 3 polls; two reminders | |

Comparison with the second battery (same scenarios):
- Exact names on the first send without the skill: 14/15 senders (before: none).
- Without the skill no agent read it, as before; S1 V 3/3 (before 0/1), S2 V 3/3 (3/3), S3 V 2/3 (2/3).
- Steered chats answered via `link_send`, forced read: S5 2/3 (1/3), S8 3/6 (3/6), S10 reminders 1/1 (1/2). Not fixed: the failures are the chat that lands right after a long tool call, when the receiver writes its own final text.
- Reminders to busy peers: S10 1/3 (2/3), S2 V 1/3 (3/3).
- Polls while waiting: S10 5/0/1 (0/7/2); S2 V 1/3/3 (2/3/2): no clear change.
- Reply loops or replies to "no reply needed": 0/3 (0/3).
