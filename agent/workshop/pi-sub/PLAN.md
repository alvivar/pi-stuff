# pi-sub — Visor mínimo de cuotas, desde primeros principios

Estado: plan aprobado; implementación pendiente.
Directorio de trabajo: `C:\Users\andre\.pi\agent\workshop\pi-sub`
Referencia funcional auditada: `@bacnh85/pi-sub@0.1.46`, commit `b1111d2f67f998fb0b79c3b7b9552d234fc5cf67`.
Objetivo inicial de compatibilidad: Pi 0.87.0; comprobar la versión instalada al comenzar.

## 1. Enfoque

Crear una implementación nueva desde cero. El original es una fuente de conocimiento sobre endpoints, autenticación y formatos, no una arquitectura que debamos conservar.

No importar el proyecto completo para después recortarlo. Recuperar únicamente conocimiento y, cuando se justifique, pequeños parsers o fragmentos revisados. Conservar licencia y atribuciones aplicables al código reutilizado. Registrar la referencia upstream sin confundir coincidencia con upstream con garantía de corrección.

Principios:

- Código simple, eficiente, legible e idiomático.
- Cada línea debe justificar su costo de mantenimiento.
- Abstracciones solo ante una necesidad concreta; ninguna infraestructura para proveedores futuros.
- Validar datos en las fronteras y trabajar con tipos fiables internamente.
- Defensas ante riesgos concretos, no comprobaciones especulativas repetidas.
- Pruebas de comportamientos fundamentales, no de cada función auxiliar.
- No conservar patrones, configuración, compatibilidad heredada ni APIs del original salvo que aporten al objetivo.

## 2. Producto

Mostrar **cuota restante y tiempo hasta reinicio** del proveedor activo, únicamente para:

| ID exacto del proveedor de Pi | Ventanas conocidas de la versión auditada |
| --- | --- |
| `openai-codex` | 5 horas y semanal |
| `opencode-go` | Rolling, semanal y mensual |

Mostrar solo ventanas utilizables que entregue la API. Una ventana ausente no significa cuota disponible. No inventar datos para completar la presentación.

Interfaz:

- Segmento compacto en el footer mediante `ctx.ui.setStatus`, preservando el footer nativo de Pi: proveedor, cuotas y reinicios. No reemplazar el footer completo.
- `/sub`: detalle transitorio local mediante una notificación TUI usando el último resultado, sin consultar la red ni crear componentes personalizados.
- `/sub refresh`: actualización manual, con límite de frecuencia.
- Otros proveedores: sin footer ni peticiones; `/sub` solo informa localmente que no hay soporte.
- Solo TUI en la primera versión. En otros modos, no iniciar consultas ni usar mensajes de contexto como alternativa.

## 3. Lo que no construiremos

- Otros proveedores, routers, proxies o alias implícitos.
- Saldos, planes, costos de sesión, tokens por segundo o analítica por modelo/herramienta.
- Configuración de endpoints, lectura de `.env` o mutación de `process.env`.
- Login, renovación OAuth propia o almacén de credenciales.
- Email, etiquetas personales, identificadores de cuenta o huellas de claves en la interfaz.
- Estadísticas en contexto del modelo o historial persistente.
- Refrescos disparados por respuestas del modelo.
- Telemetría, comandos externos, herramientas para el modelo o actualizador propio.
- Framework de adaptadores, clases de transporte, colas, cachés multicuentas o vigilancia de archivos.

## 4. Conocimiento útil del original

### Codex

- Endpoint: `https://chatgpt.com/backend-api/wham/usage`.
- Autenticación: access token de `openai-codex` y encabezado `ChatGPT-Account-Id`.
- Account ID desde la credencial; si se necesita, recuperar únicamente ese campo de los claims del token siguiendo la lógica auditada. No extraer email ni plan; decodificar claims no equivale a verificar el token.
- Respuesta conocida: `rate_limit.primary_window` y `secondary_window`, con `used_percent` y `reset_at` en segundos Unix.

### OpenCode Go

- Endpoint: `https://opencode.ai/zen/go/v1/usage`.
- Autenticación: API key de `opencode-go` como Bearer.
- Respuesta conocida: `usage.rolling`, `weekly` y `monthly`, con `percent` usado y `resetsAt` como fecha ISO.
- Un account ID sin API key no basta para consultar cuotas.

Usar APIs soportadas de Pi para acceder a las credenciales y respetar su directorio configurado. No copiar secretos a archivos propios ni depender de tipos internos no públicos sin revisar alternativas.

Estas formas son referencias, no garantías permanentes: confirmar su interpretación mediante pruebas y, opcionalmente, consultas reales autorizadas.

## 5. Diseño mínimo

Piezas conceptuales, no una cuota obligatoria de archivos:

1. Integración con Pi, estado activo y ciclo de vida.
2. Consulta y parser de Codex.
3. Consulta y parser de OpenCode Go.
4. Un helper HTTP compartido para GET autenticado, timeout y límites.
5. Presentación local y tipos normalizados de cuotas.

Separar módulos cuando facilite leer y mantener el código. Un contrato pequeño de ventana —tipo, porcentaje restante y timestamp de reinicio— es suficiente. No añadir interfaces de transporte, registros de plugins ni jerarquías de excepciones.

Estado limitado a la sesión/proveedor activos: último resultado, momento de consulta, error, temporizador, solicitud activa y próximo intento permitido. Añadir otros campos solo si una necesidad concreta lo requiere.

Una única identidad de solicitud, por ejemplo su AbortController, permite cancelar y comprobar que el resultado sigue siendo actual. No duplicar esa protección con contadores de generaciones salvo que se demuestre necesario.

## 6. Refresco y estado

- Consultar al iniciar sesión en un proveedor soportado y al cambiar a otro proveedor soportado.
- Cadencia normal: 60 segundos, sin hooks de mensajes ni respuestas del modelo.
- Cambiar entre modelos del mismo proveedor no obliga a consultar otra vez.
- Como máximo una solicitud activa; reutilizarla o ignorar un disparo redundante. Sin colas ni mapas de promesas.
- `/sub` solo presenta estado. `/sub refresh` respeta un mínimo de 10 segundos entre intentos de la misma identidad.
- Ante fallos transitorios, esperar al siguiente intento periódico; sin backoff exponencial ni reintentos inmediatos.
- Ante rate limit, respetar un `Retry-After` válido; ni el refresco manual lo omite. Si falta o es inválido, esperar al menos el intervalo normal.
- Timeout de 7 segundos.
- Cancelar petición y temporizador al salir, recargar o cambiar de sesión/proveedor. Ignorar resultados que ya no correspondan a la solicitud activa.
- Leer credenciales antes de consultar. Si cambia la identidad relevante, descartar datos anteriores; no construir un sistema de fingerprints o multicuentas.
- No vigilar cambios externos en `auth.json`: se detectarán en el siguiente intento. Una rotación del token no implica necesariamente una cuenta distinta; usar account ID de Codex cuando esté disponible.
- Conservar el último dato válido de la misma identidad ante errores transitorios, claramente marcado como desactualizado y con su antigüedad.
- Reiniciar el estado al reemplazar sesión; no mantener históricos.
- Recalcular countdown al actualizar la presentación, sin otro temporizador dedicado a animarlo.

## 7. Defensas que sí justifican su costo

- **Destinos fijos HTTPS y redirecciones rechazadas:** evitar enviar credenciales a otro servidor. Sin validadores genéricos de URLs configurables porque no habrá URLs configurables.
- **Timeout y límite de respuesta:** acotar tiempo y memoria. Implementación pequeña compartida, no un framework de streaming.
- **Cancelación y comprobación de solicitud actual:** evitar que una respuesta tardía contamine otra sesión.
- **Validación de frontera:** números finitos, porcentajes y fechas. Rechazar ventanas no utilizables; tolerar ventanas parciales. Después, confiar en los tipos normalizados.
- **Presentación controlada:** etiquetas locales y valores normalizados, no texto arbitrario del servidor. Fechas inválidas se muestran como reinicio desconocido.
- **Credenciales privadas:** no mostrar, registrar o persistir secretos, account IDs o respuestas completas.
- **UI fuera del contexto:** no usar `pi.sendMessage()` ni entradas de conversación para mostrar estadísticas. La vista detallada no se persiste.
- **Ciclo de vida explícito:** nuestro código no inicia I/O ni temporizadores al importar; trabajo solo en sesiones TUI.
- **Errores contenidos:** capturar fallos de consultas y callbacks diferidos para que el visor no bloquee ni cierre Pi. No silenciar errores de programación indiscriminadamente.

Mensajes de error locales y breves: falta login, acceso rechazado, espera por límite o consulta fallida. No reproducir mensajes remotos ni crear jerarquías complejas de errores.

Las consultas autenticadas revelan al proveedor credenciales correspondientes, IP y metadatos normales de conexión. Nunca incluyen prompts o archivos del proyecto. Documentar esta distinción.

## 8. Pruebas fundamentales

### A. Interpretación de cuotas

Para cada proveedor: una respuesta representativa completa, ventanas parciales y campos numéricos/fechas inválidos. Verificar porcentajes restantes y unidades de tiempo.

### B. Credenciales y red

Con credenciales ficticias y fetch simulado: destino y encabezados correctos, ausencia de peticiones si falta autenticación, redirecciones rechazadas, timeout y límite de tamaño efectivo.

### C. Ciclo de vida

Con reloj y promesas controladas: sin consultas duplicadas, cadencia/límite manual, respeto de rate limit, cancelación y descarte de resultados después de cambiar de sesión/proveedor. Verificar que un cambio de identidad no reutilice cuotas anteriores.

### D. Privacidad y alcance

Sin tráfico para proveedores no soportados o modos no TUI. `/sub` no consulta ni agrega mensajes al contexto/historial. El contenido mostrado no contiene credenciales ni identificadores personales.

Mantener un doble mínimo de la API de Pi; no reproducir el host entero. Usar herramientas de prueba estándar/existentes cuando basten. No buscar un porcentaje de cobertura ni probar cada helper de formato. Revisar la presentación manualmente en Pi.

## 9. Contrato de ejecución

### Repositorio y autorización

- Repositorio existente: `C:\Users\andre\.pi`; no crear otro repositorio.
- Rama/HEAD observados al autorizar: `master` / `b415bc887d05410a032882dc3ec4502abcb90829`. El implementador debe verificarlos antes de editar; una diferencia bloquea hasta explicarla.
- Raíz exclusiva del producto: `agent/workshop/pi-sub/`. No modificar ni incluir en commits nada fuera de ella.
- `PLAN.md` forma parte del primer commit. El ledger temporal `LEDGER-PLAN.md` nunca se stagea ni se commitea y se elimina al terminar el run.
- El usuario autorizó modalidad **run-through**. Cada tarea sigue implementación → evidencia requerida → revisión independiente → commit antes de iniciar la siguiente.
- No modificar la instalación activa ni settings de Pi. Las pruebas usan dobles y credenciales ficticias.
- Techo operativo saludable: 200k tokens por terminal; compactar preventivamente solo en límites seguros y nunca a participantes de una tarea abierta antes de su commit.

### Tarea 1 — Base nueva y parsers

Rutas autorizadas: `PLAN.md`, `.gitignore`, `LICENSE`, `README.md`, `package.json`, `package-lock.json`, `tsconfig.json`, `src/quota.ts`, `src/codex.ts`, `src/opencode-go.ts`, `tests/parsers.test.ts`, todas bajo la raíz del producto. Se permite crear el lockfile en esta tarea; no se permiten dependencias de runtime. El tooling de desarrollo queda limitado a TypeScript/tipos necesarios, usando el runner de tests de Node. Declarar Pi como peer según su documentación.

Trabajo:

- Crear estructura mínima dentro del monorepo, sin importar el proyecto upstream.
- Registrar origen del conocimiento y licencia/atribución aplicable.
- Definir tipos mínimos y parsers puros para respuestas completas, parciales e inválidas.

Evidencia requerida:

1. Baseline previo a editar: rama/HEAD esperados, cero cambios staged, cero cambios tracked y únicamente `PLAN.md` más el ledger como dirt esperado dentro de la raíz; Pi `0.87.0`.
2. Instalación reproducible desde el manifest y lockfile nuevos.
3. `npm test`, cubriendo el grupo A de §8.
4. `npm run typecheck`.

No hay prueba real de red ni revisión visual en esta tarea.

### Tarea 2 — Transporte y consultas

Rutas autorizadas: `src/http.ts`, `src/codex.ts`, `src/opencode-go.ts`, `tests/http.test.ts`, `tests/providers.test.ts`. Cambios a manifest o lockfile quedan prohibidos salvo enmienda registrada; no añadir dependencias.

Trabajo:

- Implementar un helper HTTP pequeño y dos consultas con destinos fijos.
- Resolver credenciales mediante API pública soportada de Pi 0.87, sin almacén propio.
- Implementar timeout, límite de respuesta, rechazo de redirecciones y errores locales mínimos.

Evidencia requerida:

1. `npm test`, incluyendo destino/headers, falta de credencial, redirección, timeout, tamaño y parsers existentes.
2. `npm run typecheck` contra las APIs declaradas de Pi 0.87.
3. Inspección de fuente declarada por el implementador que confirme los únicos dos literales de destino y ausencia de `.env`, `process.env`, logs de respuestas/secretos y renovación/login propio. Esta evidencia es estática y se reporta como tal.

No se autorizan consultas reales.

### Tarea 3 — Ciclo de vida y UI local

Rutas autorizadas: `extensions/index.ts`, `src/runtime.ts`, `src/presentation.ts`, `tests/runtime.test.ts`, `tests/presentation.test.ts`. Pueden ajustarse archivos de Tarea 2 solo cuando resulte directamente necesario para conectarlos, declarándolo materialmente. Sin cambios de dependencias o lockfile.

Trabajo:

- Conectar `session_start`, `session_shutdown` y `model_select` para TUI.
- Implementar estado, cadencia, límite manual, rate limit, deduplicación y cancelación mínimos.
- Registrar `/sub`; presentar con `setStatus` y notificaciones TUI, nunca mensajes/entradas persistentes.

Evidencia requerida:

1. `npm test`, incluyendo grupos C y D además de las pruebas previas.
2. `npm run typecheck`.
3. Prueba de carga sin red: importar/registrar la extensión no inicia I/O o temporizadores; un contexto no TUI y proveedores no soportados no consultan ni dejan status.
4. Inspección de fuente declarada que confirme ausencia de hooks de mensajes/respuestas, `sendMessage`, `sendUserMessage`, `appendEntry`, reemplazo completo del footer y persistencia de estadísticas.

La revisión visual interactiva en Pi es opcional si el trabajador no controla una TUI real; no se reportará como PASS si no se ejecuta.

### Tarea 4 — Documentación y validación final

Rutas autorizadas inicialmente: `README.md`. Correcciones pequeñas y directamente necesarias en archivos ya creados se registran como enmienda antes de editarlas; no se permiten nuevas funciones, dependencias, versiones o lockfiles.

Trabajo:

- Documentar instalación propuesta, comandos, endpoints, privacidad, límites conocidos y reversión, sin activar el paquete.
- Revisar simplicidad y eliminar únicamente código muerto o duplicación evidente vinculados al alcance.

Evidencia requerida:

1. `npm test` y `npm run typecheck` completos.
2. `npm pack --dry-run`, verificando que solo se distribuya lo intencional.
3. Auditoría estática final de rutas y búsquedas de superficies prohibidas del §3.
4. Confirmación de que Git solo contiene commits/rutas bajo `agent/workshop/pi-sub/` para este run y que la instalación/settings activos no cambiaron.

Evidencia opcional, nunca requisito ni sustituto de lo anterior: inspección visual con `pi -e` y una consulta real autorizada posteriormente. No usar credenciales reales en tests automatizados.

## 10. Definición de terminado

- Cuotas y reinicios de Codex y OpenCode Go funcionan en TUI; otros proveedores permanecen inactivos.
- Únicamente dos destinos de red fijos, sin redirecciones autenticadas ni lectura de `.env`.
- UI sin datos personales y sin incorporar estadísticas al modelo/historial.
- Sin funciones accesorias, compatibilidad heredada o infraestructura para futuros proveedores.
- Estado y concurrencia comprensibles localmente, sin mecanismos duplicados.
- Fallos de red o cambios de formato dejan un estado claro y no interrumpen Pi.
- Las pruebas fundamentales y la integración pasan.
- La instalación activa permanece intacta hasta aprobar la migración.

La estabilidad de endpoints externos no puede garantizarse. El compromiso es interpretar correctamente las respuestas conocidas y fallar de forma controlada cuando cambien.
