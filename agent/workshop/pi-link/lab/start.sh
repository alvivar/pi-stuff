# source start.sh : watchdog + spawn + boot for the current run
G=$(cat "$TEMP/pi-link-lab/current"); RUN="$TEMP/pi-link-lab/$G"; W=$(cygpath -w "$RUN")
D="node C:/Users/andre/.pi/agent/npm/node_modules/pi-dock/bin/pi-dock.mjs"
DL=$(node -e 'console.log(new Date(Date.now()+15*60e3).toISOString())')
powershell -NoProfile -Command "Start-Process node -WindowStyle Hidden -WorkingDirectory '$W' -ArgumentList 'C:/Users/andre/.pi/agent/workshop/pi-link/lab/watchdog.mjs','$DL','roster.txt'"
sleep 2; cat "$RUN/watchdog.log"
ROLES=$(sed "s/^$G-//" "$RUN/roster.txt")
for r in $ROLES; do (cd "$RUN/$r" && $D spawn --name $G-$r --model openai-codex/gpt-6-luna --thinking medium --x link --x link-name=$r@$G); done
for r in $ROLES; do $D send $G-$r --wait --file "$(cygpath -w $RUN/prompts/boot-$r.txt)" 2>/dev/null | sed "s/^/[$r] /" & done; wait
