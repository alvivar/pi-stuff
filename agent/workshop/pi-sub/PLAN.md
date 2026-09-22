# pi-sub — Cuotas verificadas y presentación compacta

Estado: pendiente de ejecución. Este plan reemplaza al anterior.
Fuente canónica: `agent/workshop/pi-sub/`.
Copia de prueba: `agent/extensions/pi-sub/`; mantenerla sincronizada después de validar.

## 1. Verificar Codex

- Realizar un diagnóstico puntual autenticado mediante las APIs públicas de Pi y el endpoint de cuota existente.
- Inspeccionar únicamente campos de límites: presencia de ventanas, duración, porcentajes y reinicios. No volcar la respuesta completa, cabeceras, tokens ni identidad; no persistir datos reales ni incorporarlos al contexto del modelo.
- Aclarar el caso observado: `5h` con reinicio en varios días. Actualmente el parser etiqueta por posición; no asumir que la primaria siempre es de cinco horas.
- Identificar ventanas por duración explícita cuando exista; usar etiquetas neutrales si no puede determinarse. No deducir duración del tiempo restante hasta reinicio.
- Comprobar si se informa cuota semanal y si existen otros límites relevantes. Mostrar estos últimos por separado solo cuando su semántica esté verificada.

## 2. Información completa

- Conservar todas las ventanas utilizables de Codex y OpenCode Go, con su reinicio individual; no presentar un supuesto reinicio general.
- `/sub`: porcentaje restante y usado, duración cuando esté informada, fecha/hora local exacta del reinicio, tiempo restante y antigüedad de la lectura.
- Distinguir datos ausentes o inválidos de cuota disponible: «no informado por el proveedor» o «dato inválido», según corresponda. Nunca completar con 100 % ni inferir ausencia de límites.
- `/sub` continúa siendo local, sin nueva consulta ni persistencia; conservar `/sub refresh` y las reglas actuales de actualización y stale.

## 3. Footer compacto

Mantener `setStatus`, sin widget ni reemplazo del footer. Formato ilustrativo:

```text
· go | R 99% 1h11m | W 100% 5d | M 100% 20d
· codex | 5h 82% 2h10m | W 65% 5d11h
```

- Separador inicial `·`; nombres `go` y `codex`; quitar `sub`, `in` y el símbolo de reinicio.
- Go: `R/W/M` para rolling/semanal/mensual. Codex: etiquetas según ventanas verificadas.
- Porcentajes restantes y duraciones compactas, sin espacios internos ni pérdida innecesaria de precisión.
- Aplicar `theme.fg("dim", ...)`, como el footer nativo, respetando el tema activo.
- Mantener visibles los estados de carga, error y stale. Pi puede seguir recortando la línea compartida; `/sub` ofrece el detalle completo.

## 4. Validación y entrega

- Añadir solo pruebas fundamentales: ventanas Codex por duración y no posición, datos parciales/inválidos, formato compacto y detalle completo. Usar fixtures sintéticos, nunca respuestas privadas.
- Ejecutar `npm test`, `npm run typecheck` y `npm pack --dry-run`; actualizar README.
- Tras validar, sincronizar los archivos necesarios con la copia de prueba, preservando su wrapper de carga; no modificar settings ni activar la versión anterior.
- Verificar manualmente tras `/reload`: ambos proveedores, convivencia con pi-link, color gris, terminal estrecha, `/sub` y `/sub refresh`. No declarar éxito visual o de red sin evidencia.

## Límites

Solo cuotas y reinicios de Codex y OpenCode Go. Sin costos, datos de cuenta, telemetría, estadísticas en contexto/historial ni nuevas dependencias innecesarias. Preservar autenticación gestionada por Pi, destinos fijos, límites de red, cancelación y privacidad existentes. Implementación simple e idiomática; sin infraestructura de diagnóstico permanente ni orquestación en este paso de planificación.
