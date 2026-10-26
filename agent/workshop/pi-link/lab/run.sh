# source run.sh from lab/, then e.g. `run_s5` or `run_s3 v`; one run each, sequential
P() { cygpath -w "$RUN/prompts/$1.txt"; }
sendw() { $D send $G-$1 --wait --file "$(P $2)" 2>/dev/null | tr '\n' ' ' | cut -c1-160 | sed "s/^/[$1] /"; echo; }
sendbg() { $D send $G-$1 --file "$(P $2)" >/dev/null; for i in $(seq 1 20); do sleep 3; node inspect.mjs $G-$1 | tail -1 | grep -q "CALL bash" && break; done; }
obs() { timeout ${2:-240} node observe.mjs $G-$1 LAB-DONE-$G >/dev/null; echo "[$1] marker exit $?"; }
fin() { sleep ${1:-5}; node summary.mjs $(cat $RUN/roster.txt) > $RUN/summary.txt; cat $RUN/summary.txt; $D stop $(cat $RUN/roster.txt) >/dev/null; }
begin() { node setup.mjs "$@" >/dev/null && source start.sh > $TEMP/pi-link-lab/boot.out; echo "=== $G boot: $(grep -c BOOT_OK $TEMP/pi-link-lab/boot.out)/$(wc -l < $RUN/roster.txt) BOOT_OK"; }
run_s1() { begin s1 $1; sendw especialista prep-especialista; sendw solicitante mission-solicitante; obs solicitante 180; fin; }
run_s2() { begin s2 $1; sendw north prep-north; sendw south prep-south; sendw coordinador mission-coordinador; obs coordinador 240; fin; }
run_s3() { begin s3 $1; sendbg especialista prep-especialista; sendw solicitante mission-solicitante; obs solicitante 180; fin; }
run_s4() { begin s4 $1; sendw trabajador prep-trabajador-historial; sendbg trabajador prep-trabajador; sendw coordinador mission-coordinador; obs coordinador 300; fin; }
run_s5() { begin s5; sendw receptor prep-receptor; sendw emisor mission-emisor; obs emisor 180; fin 90; }
run_s6() { begin s6; sendw especialista prep-especialista; sendw solicitante mission-solicitante; sleep 175; sendw solicitante status-solicitante; obs solicitante 60; fin; }
run_s7() { begin s7; sendw especialista prep-especialista; sendw solicitante mission-solicitante; obs solicitante 180; fin; }
run_s8() { begin s8; sendbg especialista prep-especialista; sendw solicitante-a mission-solicitante-a & sendw solicitante-b mission-solicitante-b & wait; obs solicitante-a 180; obs solicitante-b 60; fin; }
run_s9() { begin s9; sendbg especialista prep-especialista; sendw solicitante mission-solicitante; sleep 10; $D stop $G-especialista; sleep 100; sendw solicitante status-solicitante; obs solicitante 60; fin; }
run_s10() { begin s10; sendw alfa prep-alfa; sendw beta prep-beta; sendw gamma prep-gamma; sendw coordinador mission-coordinador; obs coordinador 240; fin; }
run_r() { begin r; sendw receptor prep-receptor; $D stop $G-emisor; $D start $G-emisor; sendw emisor mission-emisor; obs emisor 120; fin; }
