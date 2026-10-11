# Indirect Code — Auditoria Empírica de Bugs

**Status: CONCLUÍDA** (2026-10-11). 68 entradas testadas: **52 bugs reais confirmados**
(33 com reprodução empírica via probe, 19 por leitura bilateral conclusiva),
**9 refutados** pelo teste (o probe prova o contrário), 7 notas/menores.
Plus ~30 hipóteses restantes em §5 (cada uma com file:line + teste sugerido).
Suites verdes antes e depois: `go test ./...` ✓, `go test -race` ✓, `bun test`
517/517 ✓, `bun run typecheck` ✓ — todos os bugs estão fora da cobertura.

Objetivo: encontrar bugs e comportamentos errados no Indirect Code via análise +
validação empírica (rodar de verdade, reproduzir, medir). **Não é um passo de fix.**
Cada achado recebe: descrição, evidência (arquivo:linha / saída real), severidade
estimada e o passo de reprodução/verificação.

Convenção de severidade:
- **alta** — perda/dano de dados, crash, estado inconsistente visível ao usuário.
- **média** — comportamento errado em cenário real, mas com escape ou impacto limitado.
- **baixa** — edge case estreito, incosmetico, ou exige condição rara.

Status: `[ ]` hipótese · `[~]` em validação · `[x]` validado (com evidência) · `[!]` bug confirmado · `[-]` descartado (sem bug)

---

## 1. Overview do projeto (base empírica)

Dois subsistemas no repo `llm-gateway`:

**A. Gateway Bun (`server/`, `web/`)**
- `server/index.ts`: `/v1/*` proxy LLM, `/api/*` dashboard+relay, `/*` SPA.
- `server/routes/relay.ts` (360 linhas): tubo de fan-out daemon↔clientes, sem
  regra de domínio. Seleção de daemon por `hostId`.
- Frontend Indirect Code: `web/src/indirect-code/` (SolidJS + Tailwind v4).
  Espelho SignalDB em `store/sessions.ts` + `hooks/useMirror.ts`, um store por
  hostId, persistido em IndexedDB. Mutações = comandos ao daemon; snapshots
  inteiros via pull. Transcript streaming é event-driven, fora do mirror.

**B. Daemon Go (`indirect-code-daemon/`, Go 1.26)**
- Multi-call binary: boot (default) → checkup/migrate/verify + self-spawn worker;
  `--worker`, `--update-start`, `--update-end`, `--slot`, `--runner`.
- 1 `sessionActor`/sessão (inbox + `control` prioritário), supervisado por
  `root` → `sessionSup`/`bgSup`/`ws`/`projects`. `epoch`/`gen` rejeitam msgs
  velhas de worker; `cancelRounds` pode quarentenar.
- Runner: cada bash/python roda num `--runner` autocopiado; log em
  `runners/out/<sessionId>__<jobId>__<startedAt>.log`; `runners/<job>.state.json`
  é o contrato de recuperação; `.disposition` ∈ {background, inline, suppressed}.
- Persistência: WAL por sessão (`store_wal.go`), assemble/dedup em
  `store_sessions.go`, migração V1→V2 manual.

**Baseline (rodado nesta máquina, hoje):**
| Gate | Resultado |
|---|---|
| `go test ./...` | ✅ ok (102s) |
| `bun test` | ✅ 517 pass / 0 fail (24 arquivos, 42.9s) |
| `bun run typecheck` (tsc) | ✅ limpo (5.2s) |
| `go test -race ./...` | rodando (ver §Race) |

> Suites verdes ≠ sem bugs; a suite cobre os caminhos que os autores lembraram.
> A auditoria abaixo mira o que a suite **não** exercita.

---

## 2. Checklist de validação empírica (o que preciso verificar)

### A. Concorrência / atores (daemon)
- [x] A3 Cancelamento: corrida resposta vs timeout 15min — correto (correlação por id, `enterAwait`/`onStateTimeout`/`clearPending`, timer único; verificado por leitura).
- [x] **Cancel por watchdog** — **Achou Bug 17** (drop silencioso em control lane cheio).
- [x] **Quarentena + cancel** — **Achou Bug 16** (wedge "cancelling").
- [x] **finishTurn ordering** — **Achou Bug 18** (queue promote antes do resend stash).
- [ ] A1 Mailbox: drop sob lotação, contadores — hipótese (INV#3, issue 6 do scout). (pendente)
- [ ] A2 `epoch`/`gen`: bg mail sem gen-stamp (issue 9) — hipótese. (pendente)
- [ ] A4 Watchdog/liveness — hipótese (issue 17: falso-positivo por mail de zumbi). (pendente)
- [ ] A5 Passivate/respawn. (pendente)
- [ ] A6 Corridas no overlay `live`/`pendingBalloon`/`liveIncoming`. (pendente)

### C. Persistência / WAL / store
- [x] C1 Append/replay/truncate WAL; escrita parcial — probe 3 casos (torn tail, corrupção interior, evento órfão). ✓
- [x] C2 Assemble/dedup de linhas de turno — fingerprint correto para cópias byte-idênticas (o caso-alvo do fix); `sliceTurnMessages` tem Bug 2. **Achou Bugs 9** (janela de commit duplica) **e 15** (prune overcount).
- [x] C3 Cascade `purgeSession` — fence + shutdown do actor consistente por leitura. (ressurreição pendente)
- [x] C4 Migração V1→V2; handoff; save de config — **Achou Bugs 11** (baseline stamp) **e 13** (`setAutoUpdate` + race de config).
- [x] C5 Layout/GC de arquivos — **Achou Bug 14** (boot não respawna exit limpo). tmp-sweep em §5.

### B. Runner / background
- [x] B1 Identidade do log = nome do arquivo; GC-exempt; cópia para `brain/` só em transição terminal — `runner/spec.go:75-85`, `repairTerminalCopy`. ✓
- [x] B3 `AutoBackgroundAfter` (10s): placeholder + nome do log; notice de conclusão SEM texto de resultado — `bash.go:287-301`, `bg_supervisor.go:540-560`. ✓
- [x] B5 Dedupe `background_delivery`; retenção de notices terminais até fold durável — `noticeDelivered`/`bgAckMsg`/`noticePath`/`flushNotices`. ✓
- [x] B7 Deleção de sessão derruba notices pendentes — `purgeSession`/`dropNoticesFor`/fence `deleted[id]`. ✓ (ressurreição por entrega tardia em §5)
- [x] B2 Recuperação só via `state.json`; adoção de runners vivos no boot; matar órfãos — **Achou Bug 24** (notice rasgado apagado no boot) + família de cortes por bytes (Bug 23); adoção frozen-vs-fused e orphan kill-then-remove em §5.
- [x] B4 Semântica de cancel: `bg_cancel` silencioso vs notice do dashboard Stop — asymmetry `disposition` (§5); dashboard `bg_cancel` sem checagem de dono (§5).
- [x] B6 Reap da árvore de processos (KillTree/setsid/pgid); UTF-8 no delivery path — **Achou Bug 23** (label/reason cortes por bytes); UTF-8 splits em `TailLog`/`tailAdoptedOutput` (§5); `ownCommand` pin kill no bootstrap PID (§5).

### C. Persistência / WAL / store
- [x] C1 Append/replay/truncate WAL; escrita parcial — probe 3 casos (torn tail, corrupção interior, evento órfão). ✓
- [x] C2 Assemble/dedup de linhas de turno — fingerprint correto para cópias byte-idênticas (o caso-alvo do fix); `sliceTurnMessages` tem Bug 2. **Achou Bug 9** (janela de commit duplica).
- [x] C3 Cascade `purgeSession` — fence + shutdown do actor consistente por leitura. (ressurreição pendente)
- [x] C4 Migração V1→V2; handoff; save de config — **Achou Bugs 11** (baseline stamp) **e 13** (`setAutoUpdate` + race de config).
- [ ] C5 Layout/GC de arquivos; naming de log GC-exempt. (parcial: naming verificado; tmp-sweep em §5)

### D. Frontend (mirror/transcript/UI)
- [x] D2 `srcIdx` → mapeamento de tool results para carrier — probe 9 casos, incluindo semântica real de `detached`/fold. ✓
- [x] D4 Colapso do composer — esconde input+toolbar+footer+task plan, indisponível em draftMode/blocked. Divergência transitória do predicado (issue #7 do scout UI) em §5.
- [x] D5 (parcial) `composerTokens` — probe 8 casos. `settingsValidation` ✓ por leitura.
- [x] **Envelope de tool results** — **Achou Bugs 7 e 8** (`bodyWithoutFooter`, `stripToolEnvelopeDetailed`).
- [x] D1 Pull/debounce (300ms) de ping `change`; snapshot merge/normalize — **Achou Bugs 29-31** (linhas otimistas, tool results órfãos, srcIdx null) **e 34-35** (correlação de pull, churn de Date.now). Snapshot sem cursor = Bug 26.
- [x] D3 SolidJS: memos eager/TDZ — verificado: sem instância ativa (toolUnitModel.ts:23-27 ordena `name` antes de `hasContent` explicitamente). Running-tail staleness e visibleRuns merge em §5.
- [x] D6 `data-usal` nunca em Modal/toasts; entrance `backwards` não `both` — `style.tailwindcss.css:785-792` usa `backwards` em todos `anim-*`; `data-usal` só em `motion.ts`. ✓
- [x] **Parsers de tool** (`toolEdits`/`toolTrees`) — **Achou Bugs 38-39** (depth de inspect, glob com `(`); phantom section refutado (Bug 40).
- [x] **Mirror/wire** — **Achou Bugs 32-35** (reconnect death, queue edit apaga anexos, correlação de pull, churn de Date.now).

### E. Gateway relay / hosts / push / update
- [x] E1 Fan-out daemon→clientes e cliente→daemon por hostId — probe gateway real + sockets. **Achou Bug 3** (kill frame no re-pair); refutou hipótese #2 do scout.
- [x] E3 (parcial) update flow — **Achou Bug 13**. Push: Bug 5 (hipótese).
- [ ] E2 Auth dos frames de relay; multiplexing de hostId. (pendente — em §5)

### F. Transversal
- [ ] F1 Contratos de teste que só pinam comportamento incidental. (pendente)
- [x] F2 Docs: `docs/runner-protocol.md` / `runner-plan.md` citados no AGENTS.md não existem. `[!]`

---

## 3. Achados

### F2 — Docs de protocolo ausentes (já anotado) `[!]`
`AGENTS.md` manda consultar `docs/runner-protocol.md` e `docs/runner-plan.md`,
mas nenhum dos dois existe no repo (`find` não localiza; `docs/` nem existe).
Severidade: **baixa** (documental), mas quebra a instrução de handoff.
Evidência: comando `find . -name 'runner-protocol.md' -o -name 'runner-plan.md'` → vazio.

### Baseline de suíte `[x]`
Ver tabela §1. Rodado em 2026-10-11, esta máquina (linux 6.8, x64).

### Race detector `[x]`
`go test -race ./...` ✅ ok (107s, 2026-10-11). Sem corridas detectadas na suíte
existente — as corridas que existirem estão fora dos cenários cobertos.

---

### Bug 1 — `bgBuffer.append` perde a invariante de fronteira de linha e infla `DroppedLines` `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/bg_task.go:28-56` (`bgBuffer.append`),
consumido por `applyBgChunk` (bg_task.go:159) e exibido por `bgReadPage` (bg_task.go:216).

**Invariante declarado no código:** *"drop whole lines only, so the retained tail
always starts at a line boundary."* Isso é falso quando um chunk termina numa
linha parcial e o chunk-cabeça é removido pelo trim: o fragmento parcial é
descartado junto, mas continua no chunk seguinte — o tail retido passa a começar
no MEIO de uma linha.

**Evidência empírica** (probe temporário `zz_audit_probe_test.go`, `go test -run
TestAuditBgBufferDroppedLines -v`, depois removido):

```
append1 droppedBytes=0 droppedLines=0 retained="l1\nparcial"
append2 droppedBytes=0 droppedLines=0 retained="l1\nparcialcompleta\n"
trim-case: droppedBytes=10 droppedLines=2 retained="completa\n"
BUG: droppedLines=2 but only 1 full line ("l1") was dropped;
     the partial "parcial" continues into the retained tail
```

Entrada real: `l1\n` + `parcial` + `completa\n` = **2 linhas** (`l1`,
`parcialcompleta`). Com cap apertado, o trim descarta o chunk-cabeça
`l1\nparcial` e conta `countLines("l1\nparcial") = 2` linhas dropadas. Mas só
`l1` foi dropada por inteiro; `parcial` é a cabeça da linha 2, cuja cauda
(`completa`) ficou retida. Correto seria **1**.

**Inconsistência entre caminhos (mesmo conteúdo, dois números):**
- `bgBuffer.append` (live chunks) → `DroppedLines = 2`.
- `restoreRunnerOutput` (bg_recovery.go:160) usa `DroppedLines = totalLines -
  countLines(content)` → daria `2 - 1 = 1` para o mesmo conteúdo.
- `bgReadPage` deriva `firstRetained = total - len(lines) + 1`, assumindo que
  `content` começa em fronteira de linha — violado aqui.

**Impacto usuário:** `bg_check` mostra "lines X–Y of N, Z dropped above" com **Z
inflado** e a primeira linha retida exibida como se fosse completa, sendo um
fragmento cortado no meio. Após crash/restart os números mudam (o caminho de
recovery conta diferente) — o mesmo log apresenta contagens distintas antes e
depois de um reload.

**Severidade: média** (informação errada ao usuário + inconsistência entre
estados; sem perda de dado do log completo, que continua no arquivo em disco).

**Reprodução:** (1) rodar background task com saída grande > 100KB (`bgLiveCap`)
com chunks cortando linhas no meio (é o caso normal: o pump entrega janelas de
bytes); (2) chamar `bg_check`; comparar "dropped" com as linhas realmente
perdidas no tail; (3) reiniciar o daemon e chamar `bg_check` de novo — o número
muda.

---

### Bug 2 — `sliceTurnMessages` perde mensagens com turn index repetido não-adjacente `[!]` (robustez)
**Arquivo:** `indirect-code-daemon/cmd/daemon/store_wal.go:675` (`sliceTurnMessages`),
chamado por `commitWAL` (store_wal.go:557) para escolher as mensagens da turn line.

**Comportamento:** itera `turnGroups(msgs)` e retorna o **primeiro** grupo cujo
`turn == turnIdx` (`return` na primeira batida). Se o mesmo turn index aparece
em duas execuções não-adjacentes (ex.: `T1, T2, T1`), o segundo run de T1 é
silenciosamente omitido do commit — **perda de mensagem no disco**.

**Evidência empírica** (probe temporário, depois removido):
```
turn1 slice: 1 msgs   (input tinha 2 mensagens de turn 1)
BUG: sliceTurnMessages(turn=1) returned 1 msgs, want 2
```
O teste zero-index (invariante "uma mensagem, uma linha") passa.

**Alcance real:** os caminhos vivos mantêm adjacência — `discardAndResend`
(store_sessions/session_actor.go:1106) corta o boundary turn **e tudo abaixo**
antes de re-inserir, então não gera runs descontínuos. O estado só aparece em
dados legacy/carregados de fora (handoff/import) ou corrompidos. Quando aparece,
a perda é silenciosa (o WAL commit escreve só o primeiro run).

**Severidade: baixa/média** — perda de dado, mas exige transcript fora do
invariante normal. Ainda assim o `turnGroups` documenta que "zero-index
messages never appear in two groups" e o código assume unicidade sem checar.

**Correção sugerida:** concatenar todos os grupos com `turn == turnIdx`, não só o
primeiro (ou falhar ruidosamente).

### Bug 3 — Re-pair (`--connect`) dispara remote-kill no daemon vivo, e o boot **não se recupera** `[!]`
**Enquadramento (crash-only):** kill/crash é entrada **esperada** do design — o
protocolo de update faz SIGKILL de propósito ("the updater kills us brutally —
crash recovery resumes the turns from WALs"). O problema NÃO é o processo cair;
é o sistema **não estar preparado para esse kill** (sem retomada automática).
E este caso é pior que um SIGKILL: o daemon cai **limpo**, por cima de um
processo que estava saudável e servindo.

**Arquivo:** `server/routes/indirect-code.ts:170` → `server/routes/relay.ts:14-27`
(`closeDaemonSocket`) → daemon `ws_server.go:334-341`
(`case "shutdown", "disconnected"` → `onRemoteKill`) → `root.go:92`
(`onRemoteKill = r.shutdown`) → `main.go:524-538` (`os.Exit(0)`).

**Caminho:** `indirect-code --connect <url>` chama `performPairing`
(main.go:165-171) **sem checar se já há daemon rodando** (sem lock/pidfile check).
`connect/:token` rotaciona o token da mesma host row (`reused: true`) e chama
`closeDaemonSocket(existing.id)`, que envia `{type:"shutdown"}` +
`{type:"disconnected"}`. O daemon trata os dois frames como **remote kill (host
deletado)** e faz shutdown gracioso (commits, exit 0). O comentário dele ("any
redial would 401 anyway") está errado: o repair justamente rotaciona o token
para o daemon **continuar**.

**Evidência empírica** (probe `test/zz-audit-relay-probe.test.ts`, gateway real
+ socket daemon fake, depois removido):
```
#1 daemon frames after re-pair: [ "shutdown", "disconnected" ]
Received: { type: "shutdown", hostId: "host_3e02eda72fb930ccbb262827" }
```

**Por que a recuperação não está preparada (o cerne):**
`execDaemon` (exec.go:69-75) retorna `(0, nil)` para um exit 0; o boot loop
(boot.go:168-170) faz `if err == nil { os.Exit(code) }` → **exit limpo encerra o
boot permanentemente**. O respawn com backoff ("Unexpected exits restart with
backoff a few times (crash resilience), then give up", boot.go:149-151, 180-187)
só dispara para exit ≠ 0. Ou seja:
- SIGKILL (update brutal / watchdog) → exit ≠ 0 → **respawn funciona** ✓
  (WAL resume os turnos — o design crash-only entrega o que promete aqui).
- Remote-kill do re-pair → `os.Exit(0)` → **boot morre junto, nada respawna** ✗.
  O `stop.req` (boot.go:171-176) é criado só pelo `--stop` explícito, então nem
  essa é a intenção de "parar de propósito".

**Impacto usuário:** rodar o comando de instalação/conexão de novo numa máquina
com daemon ativo (cenário exato que o "não duplica a host list" promete cobrir)
derruba o daemon e ele **nunca volta sozinho**: turnos em andamento ficam
suspensos até alguém rodar o binário de novo; bg jobs podem virar órfãos. O
usuário só percebe que a máquina "ficou offline".

**Severidade: ALTA pela recuperação ausente** (o crash em si seria aceitável num
crash-only; o problema é o exit limpo escapar do contrato de respawn + a
semântica errada de "host deletado" num repair).

**Correção sugerida:** (a) `closeDaemonSocket` só para deleção real de host —
repair deve derrubar o socket sem frames de kill (o reconnect loop do daemon
assume com o token novo); (b) independentemente, o boot não deve tratar exit 0
do worker como "encerrar para sempre" a menos que `stop.req`/`--update-handoff`
estejam presentes — exit limpo inesperado também deve entrar no respawn/backoff
(crash-only de verdade: qualquer saída não solicitada = retomar).

### Bug 4 (refutado) — Stale close envenenando status do daemon substituto `[-]`
Hipótese do scout (reporte do relay #2): um `close` velho do daemon A gravaria
`status='offline'` e faria broadcast enquanto B serve. **Refutado empiricamente.**
`relay.ts:239-258` só faz delete do map + escrita DB + broadcast DENTRO do guard
`if (daemons.get(hostId) === ws)`. Probe com dois sockets daemon (A → B substitui;
fecha A): `#2 host status after stale-A close: online`, `#2 client offline
broadcasts: 0`. Nenhum envenenamento. Código correto.

### Bug 5 — Fan-out de push: `sessionId` ausente em `session_data` degrada título do push
**Arquivo:** `server/routes/relay.ts:288-303` (`maybePushTurnEnd`) lê
`parsed.sessionId` **antes** do branch `session_data`; mas os frames realtime de
`session_data` do daemon (`session_actor.go:403,864`, `turn_worker.go:155`) não
carregam `sessionId` no topo (só `hostId` + `session`). Resultado: o early-return
em `:290-291` mata o preenchimento do cache de título; o push de turn-end com
abas fechadas cai sempre no fallback `sessionId.slice(0,12)`.
**Severidade: média-baixa** (texto de push degradado, não perda funcional).
**Verificação:** capturar payload de Web Push após um turno com 0 abas abertas e
checar `title` = `<12 chars de id>` em vez do título da sessão. Não testado
empiricamente aqui (exige VAPID + service worker); marcado como hipótese
sustentada por leitura de código (os dois lados são observáveis e consistentes).

### Bug 6 — `FindCutPointMsgs` faz panic com `keepRecent <= 0` `[!]` (robustez)
**Arquivo:** `indirect-code-daemon/packages/core/compaction.go:461-500`.

Com `keepRecent <= 0` o walk-back `for idx > 0 && acc < keepRecent` não executa,
deixando `idx == len(msgs)`. O clamp `if idx >= len(msgs) { idx = len(msgs)-1 }`
vem **depois** do loop `for idx > 0 && isToolResultHead(msgs[idx]) …`, que indexa
`msgs[len(msgs)]` → **panic: index out of range**.

**Evidência empírica** (probe temporário em `packages/core`, depois removido):
```
PANIC in FindCutPointMsgs(msgs, 0): runtime error: index out of range [2] with length 2
```

**Alcance real:** o caminho de produção usa `hybridKeepFloor` (compact.go:417),
que retorna `max(CompactionKeepRecentTokens=20k, 30% do transcript)` — nunca ≤0.
`keepTail > 0` não passa por aqui. Logo o panic só é alcançável pela API
exportada do pacote (`FindCutPoint`, `FindCutPointMsgs`) com chamador externo.
**Severidade: baixa** (API exportada que faz panic; contrato implícito não
documentado).

**Correção sugerida:** clamp `idx` para `len(msgs)-1` **antes** dos loops de tool,
ou rejeitar `keepRecent <= 0` com erro.

### Bug 7 — `bodyWithoutFooter` remove linhas legítimas e deixa `\n` órfão `[!]`
**Arquivo:** `web/src/indirect-code/utils/envelope.ts:151-158`, consumido por
`components/tool/toolUnitModel.ts:60` (todo corpo de tool result exibido).

O alternativa `[\d.\-–/]+` do `fact` regex casa qualquer linha colchetada
puramente numérica — **que é saída legítima de tool** (`[42]`, `[1.5]`,
`[12-13]`, `[2024]`). Dois defeitos observados:

**Evidência empírica** (probe `test/zz-audit-envelope-probe.test.ts`, depois removido):
```
bodyWithoutFooter("output\n[42]")           → "output\n"   (deveria preservar "[42]")
bodyWithoutFooter("output\n[1.5]")          → "output\n"
bodyWithoutFooter("output\n[12-13]")        → "output\n"
bodyWithoutFooter("output\n[No output yet.]") → "output\n" (deveria ser "output")
```
1. **Falso positivo**: o comentário do próprio código diz "a legitimate last
   output line like `[done]` must survive" — mas `[42]`/`[1.5]`/`[12-13]`
   (apenas dígitos/pontuação) não sobrevivem. Qualquer tool cuja última linha é
   um número entre colchetes (contagens, saída de `wc`, ids, versões) perde essa
   linha na exibição.
2. **Newline órfão**: quando a linha de fato é um footer e é removida, o
   corte `text.slice(0, m.index + (m.index > 0 ? 1 : 0))` preserva o `\n`
   anterior (esperado `"output"`, obtido `"output\n"`).

**Severidade: média** (perda de linha de saída real + whitespace estranho no
render de todo tool result; dados persistidos intactos).

**Correção sugerida:** restrinja `[\d.\-–/]+` a formatos de página reais
(ex.: `\d+/\d+ truncated`) e remova também o `\n` final no corte.

### Bug 8 — `stripToolEnvelopeDetailed` apaga o corpo após marcador escapado no formato real do daemon `[!]`
**Arquivo:** `web/src/indirect-code/utils/envelope.ts:113-123` (primeiro
`replace` "defense in depth"), vs daemon `packages/core/envelope.go:122-126`
(`escapeEnvelopeBody`).

**Formato real de escape do daemon:** no corpo de um tool result, as substrings
literais `<tool_result` e `</tool_result` são escapadas para `&lt;tool_result` /
`&lt;/tool_result` — **o `>` seguinte NÃO é escapado** (só o prefixo). Exemplo
real de wire: saída `use <tool_result> to wrap` chega como
`<tool_result type="ok">use &lt;tool_result> to wrap</tool_result>`.

O regex defensivo do frontend casa `&lt;tool_result([\s\S]*?)(?:&lt;\/tool_result&gt;|$)`
e, no callback, exige `inner.indexOf("&gt;") >= 0` — condição que o formato real
do daemon **nunca satisfaz** (não há `&gt;` no inner). Retorna `""` para o
`matched`, que graças ao alternativa `$` se estende **até o fim do texto**:
apaga o marcador escapado, o fechamento real `</tool_result>` e TODO o conteúdo
posterior.

**Evidência empírica** (probe `test/zz-audit-escape-probe.test.ts`, formato de
escape exato do daemon, depois removido):
```
<tool_result type="ok">use &lt;tool_result> to wrap</tool_result>
  → body: "use "           (esperado: "use <tool_result> to wrap")
<tool_result type="ok">head &lt;tool_result mid &lt;/tool_result tail</tool_result>
  → body: "head "          (esperado: "head <tool_result mid </tool_result tail")
<tool_result type="ok">a &lt;/tool_result> b</tool_result>
  → body: "a </tool_result> b"   (este caso passa: o regex exige "&lt;tool_result" sem barra)
```
`parseToolEnvelope` isolado preserva o corpo corretamente ("x <tool_result y") —
o dano é introduzido pelo replace "defensivo" antes do parse.

**Impacto usuário:** toda vez que a saída de uma tool contém a substring literal
`<tool_result` (ex.: grep/leitura de arquivos que contenham esse XML, como este
próprio código-fonte do daemon), o frontend **trunca a exibição do resultado**
naquele ponto. Dados persistidos no daemon continuam íntegros (o unescape dele
está correto) — é perda de exibição, mas silenciosa e determinística.

**Severidade: média-alta** (perda visível de saída de tool result em cenário
plausível — auditar/buscar o próprio vocabulário de tool results).

**Correção sugerida:** fazer o replace defensivo espelhar exatamente
`UnescapeEnvelopeBody` do daemon (substituir `&lt;tool_result` → `<tool_result`
e `&lt;/tool_result` → `</tool_result`, sem exigir `&gt;`), ou remover o branch
"defense in depth" e confiar no `parseToolEnvelope` + `unescapeBody` (que já
estão corretos).

### Bug 9 — Crash na janela de commit duplica a transcrição inteira no load `[!]` — ALTA
**Arquivo:** `indirect-code-daemon/cmd/daemon/store_wal.go:532-622` (`commitWAL`) +
`store.go:79-100` (`loadSessionFused`) + `store_wal.go:381-390` (`applyWALEvent`
`walTypeMsg` faz append cego — sem dedup por identidade no caminho de replay).

**Janela:** `commitWAL` escreve a turn line + meta no `<id>.jsonl` e DEPOIS
`os.Remove(walPath)` (store_wal.go:615-619). Um crash entre esses dois passos
deixa **ambas** as cópias: a turn line commitada E o WAL ainda com os mesmos
`msg` events. No próximo `loadSessionFused`, o assemble do JSON congelado já tem
as mensagens, e o replay do WAL **anexa as mesmas de novo** — o dedup por
identidade existe só no `assembleRecord` (linhas duplicadas em disco,
store_sessions.go:344-415), nunca no replay do WAL.

**Evidência empírica** (probe temporário, depois removido; estado exato pós-commit
com `Turn.Status="completed"` + WAL vivo com os mesmos 2 msg events):
```
fused: 4 messages, header turn=1 (json has 2 + wal replay adds them again)
  [0] id=u1 turn=1 "do it"
  [1] id=a1 turn=1 "done"
  [2] id=u1 turn=1 "do it"    ← duplicata
  [3] id=a1 turn=1 "done"     ← duplicata
COMMIT-WINDOW DUP: got 4 messages, want 2
turnResumeCandidate correctly drops the WAL (no zombie resume)
```
Bom: `turnResumeCandidate` enxerga `Turn.Status="completed"` e **remove o WAL**
(sem resume zumbi — o scout previu resume duplo, isso está errado). Mas o
**record RAM fica com 4 mensagens** e é servido assim por `readReqMsg`
(session_data/history), snapshots do espelho e `loadSessionFused` de qualquer
leitor, até o próximo commit reescrever. O usuário vê a conversa **duplicada**
na UI após um crash nessa janela.

**Atigibilidade em produção:** o protocolo de update do daemon é **brutal por
design** (AGENTS.md: "the updater kills us brutally (SIGKILL — crash recovery
resumes the turns from WALs)"; `handoff.go:23-31`). SIGKILL durante um turno que
termina na hora = janela de commit atingível com o fluxo oficial de update.
Também via kill -9/watchdog.

**Severidade: ALTA** (transcrição duplicada visível ao usuário; dados íntegros
no disco, mas todo load os duplica até o próximo commit).

**Correção sugerida:** dedup por `provider.Message.ID` no `applyWALEvent`
`walTypeMsg` (ignorar msg cujo ID já existe no record — é o mesmo par ID/ID que
`assembleRecord` usa) OU fazer `commitWAL` remover o WAL **antes** de considerar
o turno commitado (ordem inversa, com risco oposto de perder o tail — o dedup no
replay é a opção segura).

### Bug 10 — Turno que FALHOU iniciar é resumido como crash (turno zumbi) `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/store_wal.go:155-186` (`openWAL`) +
`supervisor.go:726-763` (`turnResumeCandidate`) + `session_actor.go:680-695`
(`startTurnWithMeta`).

**Caminho:** em `openWAL`, o caminho de erro do `f.Sync()` (linha 180-186) fecha
o arquivo mas **não o remove** — ao contrário dos dois caminhos de erro
anteriores (171-180), que fazem `os.Remove(p)`. `startTurnWithMeta` então reverte
o record e reporta "Could not save session" ao usuário — mas o **WAL fica**, com
`header.turnIndex=N` e `Prompt` = o texto que falhou.

No próximo `route` da sessão, `turnResumeCandidate` (supervisor.go:726) enxerga
o WAL: `rec.TurnSeq != header.TurnIndex` (o start foi revertido) então o check
de completed/cancelled é pulado; `hasMessages` é false mas `header.Prompt != ""`
→ **resume o prompt que FALHOU como se tivesse crashado no meio do turno**. O
usuário recebeu "falhou" e depois o texto dele roda do mesmo jeito (turno
zumbi). Até esse route acontecer, o próximo `startTurn` falha com
`openWAL: file exists` (O_EXCL) — sessão travada.

**Evidência empírica** (probe simulando o estado pós-falha, depois removido):
```
ZOMBIE: turnResumeCandidate RESUMES the failed prompt "FAILED PROMPT" as turn 2
  record.TurnSeq=1 (reverted), header.TurnIndex=2 — mismatch lets it through
BUG: a turn that FAILED to start is resumed as if it crashed mid-turn
```

**Severidade: média** (exige falha de fsync para criar o estado; mas o sintoma —
prompt roda depois de "falhou" — é confuso e o lockout O_EXCL é real).

**Correção sugerida:** no caminho de erro do `f.Sync()` em `openWAL`, fazer
`os.Remove(p)` como nos outros erros; isso elimina o artefato órfão e o resume
zumbi de uma vez.

### Bug 11 — Migração trata slot legado v1 (sem version file) como fresco e pula v2-v4 `[!]`
**Arquivo:** `indirect-code-daemon/internal/migrations/migrations.go:127-133`.

O comentário de `Migrate` promete: "A fresh slot dir (**no version file, no
sessions**) is stamped at CurrentVersion with no conversions: baseline, not a
migration." Mas o código só checa `stored == 0` (arquivo de versão ausente) —
**não checa se há sessões**. Um slot real v1-era (sessions presentes,
`storage_version.json` ausente — exatamente o caso do upgrade v1→v2, cuja
migração é "manual" segundo o AGENTS.md) cai nesse branch: estampa v=4 e
retorna, **sem rodar `applyV2`** (sweep de lixo bg/runner), **`applyV3`**
(wrapping de tool_result) **`applyV4`** (rename de vocabulário de tools).

**Evidência empírica** (probe temporário com slot contendo `sessions/s1.jsonl`
v1 + `runners/out/old.log`, sem version file; depois removido):
```
applied versions: [4]
stored version after Migrate: 4 (CurrentVersion=4)
BUG: legacy slot with sessions but no version file was treated as FRESH —
applyV2/3/4 skipped entirely (legacy tool vocabulary survives)
```

**Impacto:** histórico legado mantém nomes de tools v1 (ex.: `Bash`, `Read`),
mas o runtime v2 **não tem aliases** (comentário do header de
`v4_tool_vocabulary.go`: "no legacy aliases... at runtime") — o modelo vê
histórico com vocabulário que as tools ativas não reconhecem. Lixo de bg/runners
v1 nunca é varrido.

**Severidade: média** (exige slot pré-versionamento; o contrato documentado é
violar explicitamente, então qualquer script de upgrade que confie nele erra).

**Correção sugerida:** checar também `len(sessions) > 0` (ou a presença de
artefatos v1) antes do branch de baseline; se houver dados, rodar a cadeia a
partir da v1 assumida em vez de estampar como fresco.

### Bug 12 — WALs velhos/corrompidos nunca são limpos: reads re-playam eventos mortos + sessão presa em "running" `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/supervisor.go:726-763`
(`turnResumeCandidate`) + `supervisor.go:185-215` (boot).

`turnResumeCandidate` retorna `nil` **sem remover o WAL** em dois ramos:
(a) `header.TurnIndex < rec.TurnSeq` (WAL de turno já commitado) e
(b) `openWALAppend` falha (corrupção interior, que é fail-closed por design —
verificado no Bug/C1). O WAL fica em disco para sempre.

**Invariant violado** (comentário de `store_wal.go:24-25`): "With Status=idle,
the truth is the JSON alone (**no WAL file exists**)".

**Evidência empírica** (probe temporário, depois removido):
```
BUG: stale WAL (header.TurnIndex < rec.TurnSeq) survives on disk —
violates the 'idle = JSON alone' invariant; every loadSessionFused replays
dead events into read snapshots
BUG: corrupt WAL survives turnResumeCandidate; boot skips WAL sessions for
the running->idle flip → session stuck 'running' forever with no resume
```

**Dois sintomas:**
1. **WAL velho**: cada `loadSessionFused` (todo read de snapshot, espelho,
   history) **re-playa os eventos mortos do WAL sobre o JSON congelado** — a
   mesma classe de duplicação do Bug 9, mas permanente (não é janela de crash:
   acontece em todo load enquanto o arquivo existir). Se o WAL velho contiver
   mensagens já commitadas em outra turn line, o leitor as vê duplicadas.
2. **WAL corrompido**: o boot pula o flip running→idle para sessões com WAL
   (supervisor.go:185-215), e sem resume possível a sessão fica com spinner
   **"running" para sempre**, sem recover.

**Severidade: média-alta** (o sintoma 1 amplifica a duplicação de transcript em
todo read; o sintoma 2 é estado travado visível).

**Correção sugerida:** em `turnResumeCandidate`, os ramos que retornam `nil`
devem também `os.Remove(walPath(id))` (é exatamente o que o ramo de
turno-completed já faz em supervisor.go:736-743).

### Bug 13 — `setAutoUpdate` publica RAM antes do disco e ignora erro de write `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/update_host.go:100-110` vs
`ws_server.go:1627-1635` (contrato).

`onUpdateConfig` tem o comentário explícito:
> "Disk is the durable source of truth. Publish the new pointer only after the
> atomic save succeeds, so a failed write cannot leave RAM ahead of the next
> daemon restart."

Mas `setAutoUpdate` faz exatamente o oposto:
```go
next.AutoUpdate = &enabled
d.cell.store(&next)              // RAM publicado ANTES do save
_ = saveDaemonConfig(...)        // erro IGNORADO
```
Se o save falhar, a RAM fica com `AutoUpdate` novo e o disco com o antigo —
o próximo restart do daemon ressuscita o valor antigo sem aviso.

**Race correlato (mesma classe, verificado por leitura):** `onUpdateConfig` e
`rememberSelection` (ws_server.go:1639-1659) fazem ambos
load → modify copy → `saveDaemonConfig` → `cfg.store` **sem serialização entre
si** (`saveDaemonConfig` não tem lock). Dois writes concorrentes (ex.:
`update_config` + `configure_session` ao mesmo tempo) podem se sobrescrever
silenciosamente, apagando settings ou `lastSelection` um do outro — o protocolo
`expectedRevision` de `onUpdateConfig` não protege contra isso (só contra
updates do MESMO writer).

**Severidade: média** (estado config divergente RAM/disco após falha de I/O;
race perde escrita concorrente — requere concorrência real para disparar).

**Correção sugerida:** inverter a ordem em `setAutoUpdate` (save → store, com
retorno de erro) e serializar os três writers de config sob um mutex (ou rotear
todos pelo actor do supervisor).

### Bug 14 — Boot trata exit limpo do worker como "encerrar para sempre" (crash-only incompleto) `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/boot.go:149-190` + `exec.go:69-75`.

O contrato do launcher é "unexpected exits restart with backoff a few times (crash
resilience), then give up" (boot.go:149-151). Mas o loop só respawna quando
`err != nil`:
```go
code, err := execDaemon(...)
if err == nil { os.Exit(code) }   // exit limpo = boot permanente, sem respawn
```
`execDaemon` retorna `(0, nil)` para qualquer exit 0 do worker. Os únicos
caminhos de "parar de propósito" reconhecidos são `errUpdateHandoff` (update)
e `stop.req` (`--stop`). Qualquer outro exit 0 **não solicitado** — hoje o
`os.Exit(0)` do `r.shutdown()` disparado por remote-kill (Bug 3), ou qualquer
futuro caminho que encerre limpo — derruba o boot junto, para sempre.

Em crash-only design isso é a lacuna central: **toda saída que não foi um
pedido explícito de parada deveria entrar no respawn/backoff**, fosse exit 0 ou
não. Hoje a resiliência só cobre exits com erro (SIGKILL, panic, etc.).

**Severidade: média-alta** (amplifica o Bug 3; qualquer saída limpa inesperada
= máquina offline sem retomada).

**Correção sugerida:** diferenciar exit 0 "solicitado" (stop.req presente /
update handoff) de exit 0 inesperado; o inesperado deve consumir tentativa de
respawn como qualquer crash.

### Bug 15 — `PruneOldToolResults` conta a mensagem inteira por bloco: estoura o budget de proteção `[!]`
**Arquivo:** `indirect-code-daemon/packages/core/prune.go:64-67`.

Dentro do loop por `ToolResultBlock`, o código calcula
`estimatedTokens := provider.ContextTokens("", nil, []provider.Message{m})` — o
custo da mensagem **inteira** `m` (todos os blocos) — e soma
`recentToolTokens += estimatedTokens` **uma vez por bloco**. Uma tool message
com *k* blocos é contada *k* vezes, exaurindo o budget de 40k ~*k*x mais rápido
que o documentado ("up to PruneProtectTokens of recent tool outputs").

**Evidência empírica** (probe temporário, depois removido): 1 tool message com
3 blocos de ~10k tokens cada (total 30k ≤ 40k — deveria ficar **inteira**):
```
block c1: intact (len=40000)
block c2: intact (len=40000)
block c3: TRUNCATED (len=2012)          ← truncado indevidamente
BUG: budget counted per MESSAGE inside the per-block loop: 2/3 blocks intact, want 3
```
O terceiro bloco é truncado para 2000 chars + `[truncated]` embora o total esteja
dentro do budget. Com *k* blocos grandes, o budget real vira ~40k/*k*.

**Impacto:** output de tools recentes é truncado/lixeirado cedo demais quando
uma tool message carrega vários resultados (comum: uma mensagem `tool` por
resultado em PersistentTurns, mas blocos múltiplos existem no formato Anthropic
e em replays). O modelo perde contexto recente que a proteção promete preservar.

**Severidade: média** (perda de contexto, não de dado persistido; só afeta o
que vai para o modelo).

**Correção sugerida:** contar `estimatedTokens` **por bloco**
(`ContextTokens("", nil, []provider.Message{{Content: []provider.Content{trb}}})`)
ou calcular a soma dos blocos uma vez fora do loop.

### Bug 16 — Cancel após quarentena deixa a sessão presa em "cancelling" para sempre `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/session_actor.go:893-943`
(`doCancel`) vs `2225-2249` (`quarantine`).

`quarantine()` faz `a.cancel = nil`, mas **mantém `a.workerDone` não-nil** (o
canal do worker antigo, já encerrado) e põe o estado em `stateOrphaned`.
`doCancel` só tem guard para `stateIdle`/`statePersist`: num cancel em
`stateOrphaned`, `a.cancel == nil` e `a.workerDone != nil` → cai em
`setState(stateCancel)` e **retorna sem finalizar**. O `workerFinishedMsg` do
worker antigo é descartado pelo gate de `gen` (quarantine incrementa `gen`),
então **nunca** chega um `finishTurn` — a sessão fica em "cancelling" para
sempre.

O caminho é atingível: o handler `cancel` do ws (ws_server.go:357-370) roteia
para **qualquer** sessão sem checar estado, e o `route()` só recusa `orphaned`
para `forRead=false` em spawns novos — um actor residente órfão ainda recebe o
cancel.

**Evidência empírica** (probe com `quarantine()` real + `doCancel("user")`,
depois removido):
```
BUG: cancel after quarantine wedges the session in 'cancelling' (state=cancelling)
— no worker exists to call finishTurn, and the old workerFinishedMsg is gen-dropped
```
(Aguardou 2s; o estado nunca sai de `cancelling`.)

**Severidade: média-alta** (sessão travada em estado visível "cancelling" até
um novo prompt/respawn; contradiz INV#2 "watchdog kill is a crash: recover from
disk/WAL, not partial memory state").

**Correção sugerida:** em `doCancel`, tratar `stateOrphaned` explicitamente
(finalizar para idle/erro sem passar por `stateCancel`) OU fazer `quarantine()`
zerar `a.workerDone` junto com `a.cancel`.

### Bug 17 — Watchdog **descarta silenciosamente** o cancel quando o control lane está cheio `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/supervisor.go:679-682` (escada F3
do watchdog) vs `ws_server.go:366-369` (path do usuário).

O watchdog envia `cancelTurnMsg` com
`select { case ent.handle.control <- msg: default: }` — se o control lane
(cap 8, `tuning.go:14`) estiver momentaneamente cheio (watchdogPing/passivate/
shutdown acumulados), o cancel é **descartado sem counter, sem trace e sem
retry**, enquanto `staleRounds` **já foi incrementado** (supervisor.go:659-661)
— a escada avança para quarentena fingindo progresso.

Contraste: o `cancel` do ws **espera** por espaço e responde "Session busy" em
timeout — comentário em ws_server.go:363-365: "an admitted cancel is NEVER
silently dropped (V2-006)". O path do watchdog viola esse mesmo contrato
(AGENTS.md INV#4: "never silently lose an accepted cancellation").

**Evidência empírica** (probe com o padrão exato do send, canal cap 8 cheio,
depois removido):
```
cancel DROPPED (silent)
BUG: watchdog cancel is silently dropped when the control lane is full —
no retry, no counter, no trace (INV#4 violated: an accepted cancellation is lost)
ws cancel: caller gets an explicit busy/error after 50ms (visible)   ← path do ws, para contraste
```
**Ressalva de reachability:** exige o control lane cheio no momento exato do
round do watchdog (janela estreita, mas real sob pressão — vários pings/shutdowns
enfileirados num actor lento). A violação de contrato está no código,
independente da frequência.

**Severidade: média** (perda de cancelamento aceito numa janela estreita; o
próximo round do watchdog re-tenta, mitigando, mas a escada mente sobre
progresso e pode disparar quarentena sem ter cancelado nada).

**Correção sugerida:** usar o mesmo padrão do ws (blocking send com timeout e
counter/trace no fallback), ou re-enfileirar o cancel no próximo round quando o
send falhar (e não incrementar `staleRounds` sem confirmar a entrega).

### Bug 18 — `finishTurn` promove o head da queue ANTES de aplicar o resend stashado → corte destrutivo + edit perdido `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/session_actor.go:868-889`.

O finalizador roda o bloco de **promoção de queue** (868-876) **antes** do bloco
de `pendingResend` (882-889). Cenário: `queue_send_now` num item (flag `sendNow`)
e depois `discard_and_resend` chega durante o turno rodando (stashado em
`pendingResend`, `doCancel` dispara — session_actor.go:1094-1097). Quando o turno
termina (`ok=false` mas `sendNow=true`):

1. `finishTurn` **promove o head da queue** → `startTurn(...)` → estado volta a
   `running` (com um turno novo, recém-iniciado).
2. **Depois** aplica o stash: `applyDiscardAndResend` faz o **corte destrutivo**
   (`a.rec.Messages = Messages[:idx]`) e `persistEdited` **commita** isso em
   disco, contra o turno recém-promovido.
3. `startSeededTurn` falha com "session is busy" (o promote acabou de ocupar a
   sessão) — mas o dano já está persistido.

**Evidência empírica** (probe com actor real + stash, depois removido):
```
resend result: {Error:"Message saved, but the turn did not start: session is busy or cannot persist" ...}
messages before=4 after=3, queue=0, state=running
BUG: discard&resend stash applied a DESTRUCTIVE cut (4→3 msgs) and then failed
"..." because the queue promotion already started a turn — the edit is lost and
the transcript is truncated
```
Resultado concreto: **transcript truncado e persistido** (4→3 mensagens), o
**item da queue foi consumido** (`queue=0` — o prompt promovido não volta para a
queue no caminho de erro do `startTurn`? ele é recolocado, mas o teste mostrou 0
porque o `applyDiscardAndResend` roda depois e o snapshot é tomado após), e o
**texto editado não inicia turno** — o contrato atômico de `discardAndResend`
("ONE durable commit… a failed turn start can never lose the message") é
quebrado: a mensagem é salva como row, mas o turno nunca roda e o resto do
transcript foi cortado.

**Severidade: média-alta** (perda de trecho de transcript persistido + edit sem
efeito em corrida `send_now` × `discard_and_resend`; o contrato atômico do
primitive é violado no finalizer).

**Correção sugerida:** inverter a ordem no `finishTurn` — aplicar `pendingResend`
**antes** de promover a queue (o resend é a intenção do usuário mais recente e
deve decidir o próximo turno; a queue só promove se não houver stash), ou
fazer `applyDiscardAndResend` recusar quando `startSeededTurn` falhar **sem**
persistir o corte antes (hoje persiste antes de tentar iniciar).

### Bug 19 — `queue_add` descarta o flag `yolo` no wire: item enfileirado perde o grant de acesso `[!]` (leitura bilateral)
**Arquivo:** `web/src/indirect-code/daemon-protocol.ts:38` +
`hooks/useQueue.ts:57` (enviam `yolo: boolean`) vs
`indirect-code-daemon/cmd/daemon/ws_server.go:540-548` (o struct de request
**não tem campo YOLO**) → `queueOpMsg.YOLO` (protocol.go:33-42) fica sempre
`false` para itens vindos do wire.

O caminho direto de `prompt` (ws_server.go:351) carrega `req.YOLO` corretamente; o
`queue_add`/`queue_update` perdem o flag no parse. Consequência: um item de
queue marcado "full access" (yolo) **perde esse grant** no promote
(`onQueueOp` em session_actor.go:588 usa `m.YOLO`, sempre falso) — o turno roda
com o Access padrão da sessão (ask) e pede aprovação, quando o usuário pediu
para rodar direto.

**Evidência:** divergência de schema observável nos dois lados (o frontend
declara e envia `yolo`; o daemon não o parseia). `queueOpMsg` tem o campo
`YOLO` consumido pelo actor — só o wire o corta. Não testado com probe
end-to-end (leitura bilateral conclusiva), mas o campo que some é observável.

**Severidade: média** (comportamento errado: item promovido pede aprovação em
vez de rodar com acesso pleno, sem aviso).

**Correção sugerida:** adicionar `YOLO bool \`json:"yolo"\`` ao struct de
request do `queue_add`/`queue_update` e passá-lo adiante.

### Bug 20 — `purge` de sessão vaza bookkeeping de background (`bg/<job>.pid.json` / `.notice.json`) `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/supervisor.go:846-897` (`purge`)
remove `sessions/<id>.jsonl`, `sessions/<id>.json`, `<id>.wal.jsonl`, dir da
sessão e `brain/<id>` — mas **não** os arquivos de bookkeeping de background
em `bg/` (`<job>.pid.json`, `<job>.notice.json`) dos jobs daquela sessão.

**Evidência empírica** (probe com `sup.purge()` + `bg.retainNotice`, depois
removido):
```
BUG: bg pid file for the purged session survives purge (supervisor.purge does not clean bg/<job>.pid.json)
BUG: bg notice file for the purged session survives purge (supervisor.purge does not clean bg/<job>.notice.json)
```

**Consequência real (verificado):** a **ressurreição da sessão está bloqueada** —
`route()` de um id deletado falha em `open …sessions/<id>.jsonl: no such file or
directory` e **não recria** o arquivo (probe complementar passou). O problema é
outro: os arquivos `bg/` ficam órfãos para sempre (nunca mais referenciados,
nunca limpos por GC — `gcRunners` só mexe em `runners/`), e
`loadNotices()`/`readopt()` no próximo boot podem re-entregar uma notice para um
id que não existe mais (o que hoje só gera erro, mas é ruído e lixo).

**Severidade: baixa-média** (lixo órfão + re-entrega inútil de notices; sem
corrupção de dado, sem ressurreição).

**Correção sugerida:** em `supervisor.purge`, varrer `bg/` por
`<job>.pid.json`/`<job>.notice.json` cujo sessionID bata com o id purgado e
removê-los (mesmo tratamento de `dropNoticesFor`, mas também para pidfiles).

### Bug 21 — `bgTaskPayloads` corta por bytes e pode enviar UTF-8 inválido ao cliente `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/turn_live.go:220-227`.

```go
content = content[len(content)-20*1024:]   // byte cut
if i := indexByte(content, '\n'); i >= 0 {
    content = content[i+1:]                // realinha só se houver \n na janela
}
```
O corte é **por bytes** e só realinha para fronteira de **linha** se houver um
`\n` na janela — nunca para fronteira de **rune**. Uma linha única > 20KB sem
newline (ex.: saída minificada, base64, JSON compacto, tabela wide) começa no
meio de um rune multibyte → `content` contém bytes UTF-8 inválidos.

**Evidência empírica** (probe temporário, depois removido): linha única de
30KB de runas `…` (3 bytes cada):
```
content len=20480 bytes, validUTF8=false, contentFrom=1
BUG: bgTaskPayloads ships invalid UTF-8 (byte-cut split a multibyte rune)
— content["\x80\xa6………\xe2"...]
```
(2-bytes runes passavam por sorte: offset par; 3-bytes expõe o split. O caso
com `\n` na janela está correto — realinha.)

**Impacto:** o payload `bgTasks` de `session_data`/`session_content` chega ao
frontend com bytes inválidos; o JS exibe caracteres corrompidos (`�`) no card
de background, e `contentFrom` (contagem de linhas sobre o content cortado)
fica inconsistente. O log completo no disco não é afetado.

**Severidade: média** (corrupção de exibição em saída sem newline longa; sem
perda de dado durável).

**Correção sugerida:** realinhar o corte para fronteira de rune depois do slice
(`for !utf8.RuneStart(content[0]) { content = content[1:] }` ou equivalente),
antes de procurar o `\n`. (O frontend já tem esse padrão em
`useBackground.ts` para os segs — falta no daemon.)

### Bug 22 (refutado) — Boundary de `dropBalloonsAbove` no editApply `[-]`
Hipótese do scout (issue 12): balloon em `MessageIndex == m.Index+1` sobreviveria
ao truncate mostrando file changes velhos. **Refutado empiricamente** (probe com
`onEditApply` real, depois removido):
- Balloon do turno cortado (MessageIndex=4, edit em index 2 → keep=3): removido ✓
- Boundary (balloon MessageIndex=3, edit em index 1 → keep=2): removido ✓
  (`balloons=0` — o `dropBalloonsAbove(keep)` derruba `> keep`, e o caso
  `== keep` descreve um turno cujas mensagens sobrevivem inteiras ao corte,
  logo o balloon continua preciso).
Não consegui construir o caso de balloon velho que o scout descreveu. Código
correto na geometria natural.

### Bug 23 — Cortes por bytes em label/reason de background quebram runes multibyte `[!]` (família do Bug 21)
**Arquivo:** `bg_task.go:116` (`listBgTaskIDs`: `label[:60]`) +
`packages/agent/tools/bgawait.go:82-83` (`reason[:100]`).

Ambos cortam **por bytes**, não por runes. `noticePreview` (session_actor.go:2322)
usa `[]rune` corretamente — a inconsistência interna confirma que os outros dois
são lapsos.

**Evidência empírica** (probe temporário, depois removido):
```
listBgTaskIDs label tail: invalid UTF-8 — byte-cut label[:60] tail="aaaa\xc3"
bgawait reason[:100] validUTF8=false tail="xxxx\xc3"
```
Label com byte 60 no meio de `ééé` → `\xc3` órfão na lista de jobs que o
**modelo** recebe (`listBgTaskIDs`) e no hint de UI do `bg_await` (`reason` vai
para o `summary` do tool result). Mesma classe do Bug 21 (`bgTaskPayloads`),
outros três pontos do caminho de exibição.

**Severidade: baixa-média** (U+FFFD em labels/hints; sem perda de dado).

**Correção sugerida:** truncar por `[]rune` como `noticePreview` já faz.

### Bug 24 — `loadNotices` **apaga** notice.json rasgado: notice de conclusão perdida sem rastro `[!]`
**Arquivo:** `bg_supervisor.go:579-589` (`retainNotice` escreve com
`os.WriteFile` **não-atômico**) + `bg_supervisor.go:710-732` (`loadNotices`).

Crash no meio do `WriteFile` deixa `bg/<job>.notice.json` truncado. No boot,
`loadNotices` faz `json.Unmarshal` → falha → **`os.Remove` do arquivo** (a linha
`if json.Unmarshal(raw, &n) != nil || n.JobID == ""` remove). O comentário do
design diz que records inválidos "remain on disk" para state files — para
notices o comportamento é o **oposto**: deletar.

**Evidência empírica** (probe com notice.json truncado + `loadNotices`,
depois removido):
```
BUG: torn notice.json is DELETED by loadNotices — the completion notice is
lost with no trace (retainNotice writes non-atomically, so a crash mid-write
loses the notice forever)
```

**Impacto:** a notice de conclusão do background task **some permanentemente**
(crash na janela de escrita + boot seguinte). O job até existe no transcript
como placeholder, mas o wake-up de conclusão nunca chega — o modelo não é
acordado. O `bg/` também fica sem o arquivo (já era: Bug 20 mostra que purge
não limpa esses arquivos quando existem).

**Severidade: média** (perda de notificação de conclusão; exige crash na
janela estreita de escrita, mas o resultado é silencioso e total).

**Correção sugerida:** `retainNotice` deve escrever atomicamente
(`durable.Write`/tmp+rename, como o resto do store) E `loadNotices` deve
manter arquivo inválido para inspeção em vez de deletar.

### Bug 25 — `ParseOutName` não round-tripa jobs com `__` no id: identidade fallback perdida `[!]`
**Arquivo:** `indirect-code-daemon/packages/runner/spec.go:75-88`.

`OutName` formata `<sessionId>__<jobId>__<startedAt>.log` mas `ParseOutName`
usa `SplitN(base, "__", 3)` — se o jobId (ou sessionId) contiver `__` (o
`sanitize` permite), o parse desloca e falha. O doc diz que o filename é "the
fallback identity when state is gone" — exatamente quando a identidade importa
mais, ela fica inparseável.

**Evidência empírica** (probe temporário, depois removido):
```
OutName = "sess1__job__with__dunders__1760000000000.log"
ParseOutName = ("", "", 0, ok=false)
BUG: ParseOutName cannot round-trip an id containing '__'
```
(`sanitize` também não troca `:` no POSIX, ao contrário do `sanitizeID` do
daemon — inconsistência menor de nomenclatura cross-plataforma.)

**Severidade: baixa** (exige id com `__` **e** perda do state file; hoje os ids
do daemon são hex sem `__`, então é latente — mas o contrato do filename como
fallback identity está quebrado).

**Correção sugerida:** `SplitN` a partir do fim (`LastIndex` do `__` + parse do
timestamp, depois o primeiro `__` separa sessionId de jobId), ou proibir `__`
em `sanitize`.

### Bug 26 — `transcriptOrder.snapshot` descarta snapshot sem cursor **sem pedir resync** (contrato frágil) `[~]`
**Arquivo:** `web/src/indirect-code/transcript/order.ts:45` +
`hooks/useTranscript.ts:556-557`.

```js
snapshot(cursor) {
  if (!cursor) return stream ? null : [];   // ← null SEM request()
  ...
}
```
Os outros ramos que retornam `null` (seq gap) chamam `request()` antes de
retornar — este não. O chamador (`useTranscript.ts:557`) faz
`if (orderedReplay === null) { pendingSnapshot = null; return; }` → **descarta o
snapshot inteiro** (nem `setMessages(tail)` roda) e não agenda resync.

**Estado atual (verificado):** os caminhos ativos de snapshot **carregam cursor**:
- `sessionActor.emit` estampa `transcript` sempre (session_actor.go:503 →
  `prepareTranscriptEvent`, transcript_identity.go:75).
- o reply de `get_session` (ws_server.go:162-167) injeta o overlay
  (`clientOverlay()` → `transcriptOverlay()` → `{transcript: cursor}`) no payload.
- `ws_server.go:413` (historyBlock page) é `page: true`, tratado por
  `noteHistoryPage` — não passa por `snapshot()`.

**A fragilidade:** o contrato depende de **100%** dos emissores de snapshot
estamparem cursor. Um emissor novo que esqueça → o cliente ignora o snapshot e
fica defasado **silenciosamente**, sem retry (diferente de um seq gap, que
dispara resync). É o tipo de bug que só aparece quando alguém adiciona um
emissor.

**Severidade: baixa-média hoje (latente)** — sem repro ativo nos caminhos
atuais; é um risco de manutenção concreto.

**Correção sugerida:** no ramo `!cursor`, chamar `request()` antes de retornar
`null` quando `stream` já está ativo (mesmo tratamento dos outros ramos), ou
tratar snapshot sem cursor como "aplica + reseta o stream" em vez de descartar.

### Bug 27 (verificado sem perda) — `keepIndex: idx - 1` no `session_truncated` `[-]`
Hipótese do scout (frontend): `keepIndex` emitido como `idx - 1` (session_actor.go:1166,
`applyDiscardAndResend`) poderia cortar a nova user row (srcIdx=idx). **Verificado:**
o corte do frontend (`handleTruncated`, useTranscript.ts:1012-1018) remove
`srcIdx > keep`, e logo em seguida o `tailContentEvent` (session_actor.go:1166,
emitido em seguida) repinta a tail com a nova row. Resultado: um piscar
(drop→repaint), **sem perda de mensagem**. Comportamento aceitável (o repaint
é imediato no mesmo batch de eventos). Só há **um** emit de `session_truncated`
no daemon — não há ambiguidade entre dois sites.

### Bug 28 — `repairTerminalCopy` copia o log mas **nunca cura `OutputReady`** → run recuperado é `unknownExecution` para sempre `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/runner_adopt.go:34-45`
(`repairTerminalCopy`) vs `packages/runner/run.go:323` (único ponto que seta
`st.OutputReady = true`) e `tool_receipt.go:148` (o consumidor).

**Caminho:** o runner grava o estado terminal em **dois** passos: (1)
`status=done` e (2) `OutputReady=true` após a cópia para `brain/`. Um runner que
crasha entre os dois (janela real: `run.go:315-323`) deixa
`Terminal() && !OutputReady`. No boot, `repairTerminalCopy` **re-copia** o brain
log a partir do out log (que é a fonte de verdade) — mas **nunca** seta
`OutputReady = true`, embora a cópia tenha exatamente o efeito que a flag
descreve. `tool_receipt.go:148` então trata o run como
`unknownExecution` **para sempre** (o estado nunca é reescrito: `gcRunners` só
remove o arquivo depois de 1h, e nada mais toca a flag).

**Evidência empírica** (probe temporário com estado `done` sem `OutputReady` +
`repairTerminalCopy`, depois removido):
```
BUG: repairTerminalCopy re-copies the brain log but NEVER sets OutputReady=true
(only run.go:323 does) — tool_receipt.go:148 then reports unknownExecution for
this recovered run forever
tool_receipt.resolve sees: Terminal=true OutputReady=false → unknownExecution
```

**Impacto:** após um crash na janela entre os dois writes do runner, o resultado
daquele comando é reportado como "desfecho desconhecido" pelo `tool_receipt` (e
potencialmente pelo `bg_check`/retry de tool) embora o comando **tenha rodado e
seu output esteja completo** no brain log. Silencioso e permanente.

**Severidade: média-alta** (desfecho real tratado como desconhecido após crash;
o dado está íntegro, só a semântica é corrompida).

**Correção sugerida:** em `repairTerminalCopy`, após `durable.Copy` bem-sucedido,
setar `st.OutputReady = true` e persistir o state (é exatamente o que o run.go
fazia no passo 2 — o repair assume essa responsabilidade no recovery).

### Bug 29 — `mergeTranscriptTail` **apaga linhas otimistas** do usuário (`srcIdx==null`) a cada snapshot paginado `[!]`
**Arquivo:** `web/src/indirect-code/transcript/updaters.ts:371-373` +
`hooks/useTranscript.ts:1253-1255` (`pushUserMessage`).

```js
return [...prev.filter(m => m.srcIdx != null && m.srcIdx < firstIndex && !ids.has(m.id)), ...tail];
```
O filtro mantém só `srcIdx != null`. Uma bolha otimista de eco do composer
(`pushUserMessage` insere `srcIdx` indefinido até o evento `user_message`
estampar) é **descartada** quando um `session_content` paginado chega — a
mensagem do usuário pisca e some até o próximo evento reinseri-la.

**Evidência empírica** (probe, depois removido):
```
merged: [ { id: "msg_5", srcIdx: 5 } ]     ← "optimistic_1" sumiu
1 pass 3 fail (expect: a bolha otimista sobrevive)
```

**Severidade: média** (mensagem do usuário some visualmente; o dado não é
perdido — o `user_message` do daemon re-insere — mas o piscar é visível e
confuso, pior em sessão paginada).

**Correção sugerida:** preservar `m.srcIdx == null` no filter (linhas otimistas
não são "tail antigo" — são intenção do usuário pendente de confirmação).

### Bug 30 — `cutTail` mantém tool results içados num carrier anterior quando o envelope raw é cortado `[!]`
**Arquivo:** `web/src/indirect-code/transcript/updaters.ts:321-323` (`cutTail`).

```js
const cut = prev.findIndex((m) => (m.srcIdx ?? -1) > keep);
return cut < 0 ? prev : prev.slice(0, cut);
```
O corte é **por posição do carrier**, não por srcIdx do envelope. Um tool
result içado para um carrier em `srcIdx=5` cujo **envelope raw está em
`srcIdx=12`** sobrevive a um corte com `keep=10` — o carrier (≤10) fica, e o
resultado dele continua renderizado, embora a mensagem raw que o originou tenha
sido cortada (edit/regenerate).

**Evidência empírica** (probe, depois removido):
```
cut: [ { id: "msg_5", srcIdx: 5, blocks: 2 } ]
expect(c.blocks.some(tool_result)).toBe(false) → Received: true   ← resultado órfão sobrevive
```

**Severidade: média** (resultado de tool que o usuário regenerou/editsou
continua visível sob a bolha re-renderizada; confuso num regenerate).

**Correção sugerida:** `cutTail` deve também podar blocos `tool_result` cujo
srcIdx de envelope exceda `keep`, ou o corte deve ser set-based por srcIdx do
envelope (não por posição do carrier).

### Bug 31 — linhas com `srcIdx==null` sobrevivem a **qualquer** truncation no `cutTail` `[!]`
**Arquivo:** `web/src/indirect-code/transcript/updaters.ts:321-323`.

`(m.srcIdx ?? -1) > keep` → `null` compara como `-1`, que **nunca** excede
`keep` (>= 0) → a linha nunca é cortada. Uma bolha otimista velha/órfã (eco de
composer não confirmado) sobrevive a todo `cutTail` de edit/regenerate. O
`handleTruncated` (useTranscript.ts:1013) trata `keep === -1` como "limpa tudo"
(`return []`), mascarando o caso extremo — mas para `keep >= 0` a linha fica.

**Evidência empírica** (probe, depois removido):
```
null-srcIdx cut: 1      (keep=-1 via cutTail direto: deveria ser 0)
```

**Severidade: baixa-média** (linhas órfãs de eco do composer acumulam após
múltiplos edits/regenerates; sem perda de dado).

**Correção sugerida:** em `cutTail`, tratar `srcIdx == null` explicitamente
(cortar junto com o tail, ou preservar apenas se for o último eco pendente).

### Bug 32 — Reconexão do relay **morre para sempre** se o refresh de auth falhar uma vez `[!]` — ALTA
**Arquivo:** `web/src/indirect-code/hooks/useRelay.ts:94-105` +
`IndirectCodePage.tsx:245` (`ensureAuth: () => hosts.loadHosts()`).

```js
socket.onclose = () => {
  ...
  reconnectTimer = setTimeout(async () => {
    await opts.ensureAuth();          // ← fetch que PODE rejeitar
    if (!disposed && opts.isActiveHost(hostId)) connect(hostId);
  }, delay);
};
```
Se `ensureAuth()` (= `hosts.loadHosts()`, um fetch) rejeitar num blip de rede,
o callback async lança uma rejeição **não tratada** e o `connect()` **nunca
roda**. Esse era o ÚNICO timer de reconexão — nenhum outro é agendado. O relay
fica em "disconnected" **para sempre** até o usuário recarregar a página. O
backoff exponencial (linha 99) só ajuda enquanto cada tentativa sobrevive até
agendar a próxima.

**Evidência:** leitura bilateral conclusiva (o `await` sem try/catch no timer
callback + `connect` como última ação; `loadHosts` é um fetch comum que rejeita
em falha de rede). Não rodado como probe (o padrão é inegável: uma rejeição mata
o fluxo restante do callback).

**Impacto usuário:** blip de rede durante a tentativa de reconexão → app perde a
conexão com o host **permanentemente** (só reload resolve). Num app que depende
do WS para tudo, é caixa-preta: parece "o host caiu" mas é o cliente que desistiu.

**Severidade: ALTA** (perda de conexão permanente por falha transitória).

**Correção sugerida:** try/catch em torno do `ensureAuth` dentro do callback
(falha de auth não deve abortar o reconnect — tenta `connect` mesmo assim, ou
reagenda o timer).

### Bug 33 — Edit de item da queue **apaga todos os anexos** não presentes no draft `[!]`
**Arquivo:** `web/src/indirect-code/hooks/useQueue.ts:63` (`updateQueued` sempre
envia `attachmentIds` como array) + `session_actor.go:592-605` (daemon: array
não-nil = **replace total**).

Dois defeitos encadeados:
1. `beginEdit` (useQueue.ts:95-105) pré-carrega só os anexos presentes em
   `review.noteSessionFiles` — qualquer anexo da queue item **ausente** dessa
   lista (ex.: upload de outro device, limpeza de cache) cai do draft.
2. `saveEdit` envia a lista **curta** via `updateQueued`; o daemon, recebendo
   `AttachmentIDs != nil`, faz **replace total** do item (session_actor.go:594:
   "Full-item update") → os anexos ausentes do draft são **apagados
   silenciosamente** do item enfileirado.

Além disso, o web **nunca** usa o caminho parcial do daemon
(`m.AttachmentIDs == nil` = "sem mudança", session_actor.go:606-609) porque o
tipo do protocolo declara `attachmentIds: string[]` (sempre array).

**Evidência:** leitura bilateral conclusiva (web sempre envia array; daemon
substitui quando array ≠ nil; o `validateAttachmentIDs` ainda pode falhar se um
id do draft ficou velho → edição inteira rejeitada).

**Impacto usuário:** editar o **texto** de um item da queue que tem anexos pode
apagar anexos sem aviso (se o draft não os carregou todos).

**Severidade: média** (perda de referência de anexo em edição; o arquivo em si
não é deletado, mas some do item).

**Correção sugerida:** o web deve preservar `attachmentIds` não tocados
(mandar `undefined` para "sem mudança" quando o usuário não mexeu nos anexos),
ou o `beginEdit` deve garantir que todos os `item.attachmentIds` entram no draft.

### Bug 34 — Correlação de pull-response **ignora `collection`** `[!]` (robustez)
**Arquivo:** `web/src/indirect-code/store/sessions.ts:289-308`.

A correlação casa só por `id` numérico + `hostId` — **não** por `collection`,
embora o daemon ecoe `collection` no `pull-response` (ws_server.go:978). Se uma
resposta velha (pós-timeout de 12s, id reciclado) ou um id colidido (dois tabs,
`nextReqId` é `randomUint32*1e6` + incremento — probabilisticamente único, não
garantido) chegar, uma resposta de `projects` pode resolver um pull de
`sessions` → itens normalizados com o schema errado. O caminho de erro também
confia em `pull.replyTo === 'pull'` (linha 302) — que o daemon **nunca** seta
(`s.error()` emite só type/hostId/sessionId/requestId/message).

**Severidade: baixa-média** (requer colisão de id ou resposta stale; mas a
corrupção é silenciosa — o schema errado entra no store).

**Correção sugerida:** checar `pull.collection === request.collection` antes de
resolver; usar um id de página mais forte (UUID) ou incluir o collection na
chave de correlação.

### Bug 35 — `normalizeSession` usa `Date.now()` como fallback → churn a cada pull `[!]`
**Arquivo:** `web/src/indirect-code/store/sessions.ts:136-137`.

`createdAt`/`updatedAt` ausentes/zero viram `Date.now()` — **um valor novo a
cada pull**. O memo do `useMirror` (useMirror.ts:25-28) compara
`JSON.stringify(a) === JSON.stringify(b)` para suprimir updates — então qualquer
sessão com timestamp corrompido/ausente **nunca** casa igualdade entre pulls →
o sidebar re-renderiza à toa e consumidores keyed em `updatedAt` veem mudanças
fantasma. O comentário (134-135) diz que o fallback é para corrupção — deveria
ser estável por item.

**Severidade: baixa-média** (re-render churn, sem perda de dado; mas quebra o
mecanismo de supressão do memo).

**Correção sugerida:** fallback estável (ex.: 0 ou hash do id), não relógio.

### Bugs 36-37 (refutados pelo probe) — bg output duplicado (H4) e rope cap (L11) `[-]`
Hipóteses do scout `FrontendMirrorWire`, **refutadas por probe** (depois removido):
- **H4** (`output()` duplica replay de chunk): o probe mostrou `"a\n"` **uma vez**
  após replay de mesmo seq — o fallback `(numbered && !accepted) ? cur.text :
  cur.text + text` (useBackground.ts:174) **não** appenda quando o chunk já foi
  aceito por seq. Comportamento correto.
- **L11** (rope de 64KB pendurado): o probe disparou o cap de 64KB **4 vezes**
  durante os deltas — o cap roda a cada `push`, então o rope nunca cresce além
  de 64KB sem um push de delta que o dispare. A hipótese do scout (check lê o
  campo da mensagem de entrada) é real no código, mas **inofensiva**: o rope é
  mantido ≤64KB continuamente.

### Bug 38 — `parseInspectTree` perde o aninhamento de linhas indentadas sem flag `[!]`
**Arquivo:** `web/src/indirect-code/utils/toolTrees.ts:117` (cálculo de `depth`).

```js
const depth = forceDepthZero ? 0 : hasFlag ? Math.floor(leading / 2) : Math.max(0, Math.floor((leading - 4) / 2));
```
Para linhas **sem** flag (sem bloco `[flag]`), o parser assume uma coluna fixa de
4 espaços e faz `(leading-4)/2` — subtraindo 4 da indentação mesmo quando não há
coluna de flag. Linhas indentadas aninhadas são achatadas para `depth=0`.
Também a forma single-file exige `size` definido senão retorna `null` (linha
válida sem meta é descartada inteira).

**Evidência empírica** (probe, depois removido):
```
tree: [ {depth:0}, {depth:0}, {depth:0}, {depth:0} ]   ← esperado [0,1,1,2]
single: null                                          ← "file.txt" sem meta descartado
```

**Severidade: média** (a árvore de inspect do `renderToolSegs` exibe tudo no
mesmo nível — a hierarquia de pastas sumiu; e um resultado single-file simples
não renderiza).

**Correção sugerida:** só subtrair 4 quando `hasFlag` for verdade; e aceitar
linha single-file sem `size`.

### Bug 39 — `parseGlobList` recusa arquivo começando com `(` `[!]`
**Arquivo:** `web/src/indirect-code/utils/toolTrees.ts:197`.

```js
files.some(f => f.includes("\n") || f.startsWith("("))  // → null
```
Qualquer arquivo legítimo cujo nome comece com `(` (ex.: `(weird)name.ts`,
comum em outputs de build/test) faz o parser retornar `null` (não-parseável →
fallback de texto cru) — a lista de glob inteira deixa de renderizar como lista.

**Evidência empírica** (probe, depois removido):
```
glob: null     (esperado files: ["(weird)name.ts", "foo.ts"])
```

**Severidade: baixa** (nome de arquivo com `(` no início; UI degrada para texto).

**Correção sugerida:** detectar o marcador de truncation por conteúdo/formato
exato (ex.: a linha literal de truncation), não por `startsWith("(")`.

### Bug 40 (refutado) — Phantom section em `parseEditResults` `[-]`
Hipótese do scout (#4): linha de diff começando com `✓`/`○`/`✗` viraria seção
fantasma. **Refutado pelo probe**: linhas de diff **unificado** são prefixadas
com `+`/`-`/` ` (espaço) — nunca começam com a marca na coluna 0, então
`^([✓○✗])` não casa no corpo do diff. Meu corpo ` ✓ foo bar` (com espaço, como
diff real) manteve a seção intacta. A regex é solta, mas o caso descrito não
ocorre no formato real de diff.

### Bug 41 (refutado) — Notice acked antes do prompt durável (runner issue 1) `[-]`
Hipótese do `RunnerBackground` (issue 1, classificado H): `onBgNotice` faz
`ackNotice` logo após `startTurnWithMeta` (session_actor.go:2118-2119), antes da
user row com `background_delivery` ser escrita pelo worker → crash na janela
perderia a notice (retirada + runner identity GC'd).

**Refutado empiricamente** (probe simulando o estado pós-crash: WAL header com
`Prompt` + `PromptMeta{background_delivery}` e **sem** rows de mensagem; depois
removido):
```
resume candidate: turn=2 prompt="[Background bash task j1] finished. Read with bg_check."
meta=map[background_delivery:j1]
```
O WAL header persiste `Prompt` + `PromptMeta` **antes** do ack
(session_actor.go:689: `walHeader{..., PromptMeta: meta}` + openWAL), e
`turnResumeCandidate` retoma turnos com `header.Prompt != ""` sem mensagens.
O comentário do código confirma o design (session_actor.go:692-693: "Crash
before the opening message must retain enough to resume once"). O wake-up turn
**é retomado** pelo resume; a notice não é perdida. A ordem do ack continua
tecnicamente antes da row durar, mas o WAL cobre o gap — não é bug.

O mesmo raciocínio aplica ao issue 2 do scout (orphan kill-then-remove): o
próprio código **já** espera a morte do pid antes de remover o state
(runner_adopt.go:99-104, com o comentário "Wait for death BEFORE cleaning: the
dying runner rewrites its own state... must not resurrect a cleaned record") —
a preocupação é tratada; o residual é a janela de pid-recycle, que o loop de
`processutil.Matches` cobre.

### Bug 42 — `onQueueSendNow` perde a intenção `sendNow` quando `startTurn` falha `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/turn_attachments.go:228-233`.

No ramo idle, o item é movido para o head e `startTurn` é tentado; em erro o item
volta para a queue — mas `sendNow` **não** é setado (só o ramo running o faz,
linha 240). Uma falha transitória de start (ex.: `persistErr` momentâneo)
**rebaixa** o item para ordem FIFO comum: quando a sessão se recupera e o turno
termina, o item é promovido na vez certa da queue em vez de dirigir o próximo
passo como o usuário pediu.

**Evidência empírica** (probe temporário, depois removido):
```
sendNow=false queue=1
BUG: onQueueSendNow idle-branch loses the sendNow intent on startTurn failure
— the item is demoted back to plain queue order
```

**Severidade: baixa-média** (intenção do usuário perdida em falha transitória;
o item não se perde, só a prioridade).

**Correção sugerida:** setar `a.sendNow = true` também no caminho de erro do
ramo idle (antes do `return`), para que o próximo finishTurn o promova primeiro.

### Bug 43 — `truncateAndRun` (fork-with-edit) é **não-atômico**: truncamento persistido + texto do edit perdido em falha da 2ª perna `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/ws_server.go:1303-1336`.

```go
// leg 1: editRegenerateMsg (truncamento destrutivo, persistido)
res.Inbox <- Envelope{Payload: editRegenerateMsg{Keep: index, ...}}
...
// leg 2: o texto do edit via userPromptMsg
res.Inbox <- Envelope{Payload: userPromptMsg{Text: text, ...}}
```
Duas mensagens **separadas** ao actor: a primeira faz o truncate destrutivo
(`editRegenerateMsg` → `onEditRegenerate`, persistido via `truncateTail`), e a
segunda traz o texto do edit. Se a 2ª perna falhar (timeout de `replyTimeout`,
`persistErr` injetado entre as pernas, actor ocupado), **o truncamento já está
commitado e o texto do edit vive só na variável do caller** — perdido quando o
handler retorna. É exatamente o caso de perda de dado que o primitive atômico
`discardAndResend` ("ONE durable commit… a failed turn start can never lose the
message") foi construído para evitar — mas o caminho `fork_session` com
`editText` (ws_server.go:1078-1080) **ainda usa o two-step deprecated**.

**Evidência:** leitura bilateral conclusiva (as duas mensagens são enviadas em
`select` separados com `replyTimeout` independente; não há rollback do leg 1
quando o leg 2 falha — o `s.error()` apenas reporta). O probe de reprodução
completa exige orquestração de falha entre as pernas (o actor com `persistErr`
bloqueia o teardown), mas o fluxo de código não tem caminho de recuperação:
`editRegenerateMsg` não tem `Reply` com rollback, e o texto só existe no stack
do `truncateAndRun`.

**Impacto:** `fork_session` com texto de edit (fork-and-edit do usuário) pode
perder o texto e deixar o fork truncado se a sessão ficar ocupada/indisponível
entre as duas mensagens. Janela pequena, mas sem rede de segurança — o contrato
atômico do produto é violado neste caminho.

**Severidade: média** (perda de texto do usuário em janela de falha; o caminho
principal `discardAnd_resend` é atômico e cobre a maioria dos usos).

**Correção sugerida:** rotear `fork_session`+`editText` pelo primitive atômico
(`forkAndResendMsg`, que já persiste a row do fork antes de iniciar o turno), ou
adicionar rollback do `editRegenerateMsg` quando o `userPromptMsg` falhar.

### Bug 44 — `onEditRegenerate` (deprecated) persiste truncamento sem os repairs que `onEditApply` faz `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/session_actor.go:1525-1548` vs
`turn_attachments.go:278-281`.

`onEditApply` (o caminho edit-sem-regen) faz três repairs após truncar:
```go
a.rec.FileBalloons = dropBalloonsAbove(a.rec.FileBalloons, m.Index+1)
a.rec.Messages = provider.RepairOrphanedToolResults(a.rec.Messages)
pruneOrphanAttachments(a.rec, nil)
```
`onEditRegenerate` (o caminho edit-com-regen, ainda usado por
`truncateAndRun`/`fork_session` com editText — ver Bug 43) faz
`a.rec.Messages = Messages[:keep]` + `truncateTail` e **retorna** — sem nenhum
dos três. Consequência: balloons de file-changes acima do corte ficam órfãos
(mostrando mudanças de turnos que não existem mais), tool_calls órfãos sem
`tool_result` são persistidos (o `repairToolUseResultPairs` do contexto conserta
no request, mas o record fica não-pareado), e attachments órfãos não são podados.

**Evidência:** leitura bilateral conclusiva — comparação lado a lado dos dois
handlers; `onEditRegenerate` tem literalmente os `truncateTail`/`pingChange`/
`Reply` sem as três linhas de repair.

**Severidade: baixa-média** (record com estado inconsistente após
edit-com-regen; o próximo request é reparado em memória, mas o disco e os
snapshots do espelho mostram balloons/tool_calls órfãos).

**Correção sugerida:** aplicar os mesmos três repairs em `onEditRegenerate`
(mesmo trecho de `onEditApply`), ou rotear o caminho todo pelo
`discardAndResend` atômico.

### Bug 45 (verificado, baixo) — `sliceHistoryBlock` entrega até ~2x o cap documentado `[~]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/turn_history.go:85-87`.

O check `if i < len(groups)-1 && held >= historyBlockMaxMessages` roda **antes**
de adicionar o grupo `i`, então o grupo que cruza os 200 ainda entra (round-up,
**documentado** no comentário). Mas a margem prática: com dois grupos de 199
mensagens (ambos < 200 no check), a página entrega **398 mensagens** — quase 2x
o cap.

**Evidência empírica** (probe temporário, depois removido):
```
block size: 398 messages (cap = 200)
```
O round-up de um turno é documentado; a **soma de dois grupos quase-cheios** é
a margem não óbvia. O frontend não deve assumir bound rígido de 200.

**Severidade: baixa** (comportamento documentado; risco de payload maior que o
esperado num frontend que assuma 200 rígido — hoje o `mergeTranscriptTail` lida
com qualquer tamanho).

### Bug 46 — Evento sem cursor é descartado sem resync após init do stream `[!]`
**Arquivo:** `web/src/indirect-code/transcript/order.ts:30`.

```js
if (!cursor) { if (!stream) apply(); return; }
```
Uma vez que o stream foi inicializado (qualquer evento cursored), um evento
**sem** cursor chega: `apply` **não** é chamado e `request()` **não** é
disparado — o evento (`text_delta`, `tool_result`, etc.) é perdido
silenciosamente até o próximo snapshot.

**Evidência empírica** (probe, depois removido):
```
applied: 1 resyncs: 0    ← evento cursor-less: não aplicado, sem resync
```
(Para comparação: um seq gap dispara `request()` — o ramo sem cursor não.)

**Reachability:** o daemon atual **sempre** estampa `transcript`
(`sessionActor.emit` → `prepareTranscriptEvent`, transcript_identity.go:75). O
gap só é atingível por emissor legado/relay drop — mesma classe do Bug 26
(snapshot sem cursor). Contrato frágil: um emissor novo que esqueça o cursor
perde eventos sem recovery.

**Severidade: baixa-média** (latente; atingível por daemon legado ou frame
corrompido no relay).

**Correção sugerida:** no ramo sem cursor, disparar `request()` quando `stream`
já existe (mesmo tratamento do seq gap), ou aplicar o evento como "fora de
banda" em vez de descartar.

### Bug 47 — Troca de stream descarta eventos bufferizados do stream antigo `[~]`
**Arquivo:** `web/src/indirect-code/transcript/order.ts:16-21` (`change()`).

Quando um evento/snapshot com **novo** stream chega, `change()` limpa
`events`/`waiting` — eventos bufferizados do stream anterior (aguardando um
gap fechar) são **descartados sem aplicação**.

**Evidência empírica** (probe, depois removido):
```
applied: ["s1-1", "s2-1"]     ← s1-5 (bufferizado, gap) nunca aplicado
resyncs after gap: 1
```
**Interpretação:** o design trata um novo stream como nova identidade de
transcript (ex.: pós-truncate/restart do daemon) — eventos do stream aposentado
(`retired`) são obsoletos por definição. O `request()` do gap foi disparado, mas
a resposta do resync para o stream antigo chega com cursor `retired` →
descartada pelo próprio `snapshot()`. Então o recovery depende de um snapshot do
stream **novo**.

**Severidade: baixa** (comportamento defensável por design; o risco é o intervalo
entre a troca de stream e o próximo snapshot — eventos do stream antigo nesse
intervalo são perdidos, mas o stream novo já era a verdade).

**Correção sugerida:** documentar explicitamente que `change()` invalida o
buffer; ou manter o buffer do stream antigo até um snapshot do novo stream
ancorar.

### Bug 48 (refutado) — Cap de 512 evicção de gap events `[-]`
Hipótese do scout (issue #4): flood de >512 eventos entre snapshots derrubaria
gap events não aplicados via FIFO `shift()`. **Refutado**: o snapshot
autoritativo cobre tudo até `cursor.seq` — eventos bufferizados com
`seq <= snapshot.seq` são descartados **porque o snapshot já os contém** (é um
snapshot completo, não uma janela). A evicção não causa perda: o snapshot re-ancora
o estado completo. (Meu primeiro probe não criou gap real — seq consecutivo é
aplicado imediatamente; o caso de gap real é coberto pelo snapshot seguinte.)

### Bug 49 — Dashboard `bg_cancel` cancela job de **qualquer** sessão sem checagem de dono `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/ws_server.go:721-731` vs
`bg_supervisor.go:494+` (`cancelJob`) e `bgcancel.go:46` (contrato do modelo).

O `bg_cancel` do **dashboard** envia `bgCancelMsg{JobID, By:"user"}` para o
`jobID` que o cliente nomear — **sem `sessionID`** na mensagem. `onCancel(jobID,
by)` não verifica dono: qualquer job rodando é cancelado. O caminho do
**modelo** (`cancelJob(callerSessionID, jobID)`) **sim** checa
`owner == callerSessionID` antes — o contrato do tool
("Unknown or foreign ids are refused", `bgcancel.go:46`) vale só para o modelo.

**Evidência:** leitura bilateral conclusiva (o struct de request do ws não tem
`sessionId`; `onCancel` não recebe nem compara dono; `cancelJob` compara).

**Impacto:** num host com duas sessões abertas, o `bg_cancel` do dashboard da
sessão A cancela um job da sessão B se o usuário (ou um frame corrompido/malicioso)
nomear o jobID certo. Em single-tenant é raro, mas o contrato do produto
("foreign ids are refused") é violado no caminho do dashboard.

**Severidade: baixa-média** (requer multi-sessão + jobID conhecido; mas é
divergência de segurança/contrato).

**Correção sugerida:** incluir `sessionId` no request do `bg_cancel` do dashboard
e aplicar o mesmo `owner == caller` do `cancelJob` antes de cancelar.

### Bug 50 — `FindCutPointMsgs` clamp para `Index: 0` faz Compact no-opar em transcript oversized `[!]`
**Arquivo:** `indirect-code-daemon/packages/core/compaction.go:486-512` +
`compact.go:65-73`.

Quando o walk-back esgota (transcript todo abaixo do keep floor) e **não há
user boundary** no transcript, `snapCutToUserBoundary` retorna 0 →
`CutPoint{Index: 0}` → o caminho auto do `Compact` trata `keepFrom <= 0` como
"nothing to compact" e **retorna sem resumir**, embora o transcript seja
oversized.

**Evidência empírica** (probe temporário com transcript só de tool results,
depois removido):
```
cut point: {Index:0 SplitTurn:false TurnStartIndex:-1}
BUG: FindCutPointMsgs clamps to Index 0 for a boundary-less transcript —
Compact no-ops on an oversized transcript instead of summarizing
```

**Reachability:** exige transcript sem **nenhum** user message visível (só
tool results/notices ocultas). Em uso real os turnos sempre começam com user
rows; mas transcripts importados/legacy ou corrompidos podem cair aqui — e aí
o auto-compact nunca dispara, o contexto estoura e o provider falha.

**Severidade: baixa-média** (auto-compact silenciosamente ineficaz em um caso
específico; a falha real vira erro de contexto no provider).

**Correção sugerida:** quando não houver user boundary, usar o começo do
transcript (ou o grupo mais antigo) como cut point em vez de 0, para que o
resumo aconteça.

### Bug 51 — `replyTo` no contrato de erro do frontend é **código morto**; epoch-gate sem trace `[!]` (higiene/INV#5)
**Arquivo:** `web/src/indirect-code/daemon-protocol.ts:158` (`replyTo` no tipo
`error`) vs `indirect-code-daemon/cmd/daemon/ws_server.go` — grep em todo o Go:
`replyTo` aparece **apenas em comentário** (ws_server.go:885, "Removed: silent
no-op. Emitting a replyTo-less..."), nunca é emitido. Os branches do dispatcher
do frontend que checam `msg.replyTo === 'pull'`/`'create_session'` são código
morto — o fallback depende de `msg.type === 'error'` por acaso.

**Relacionado (INV#5):** o epoch gate (session_actor.go:243-245) faz `return`
silencioso no mismatch de epoch — sem `trace()` e sem counter, embora a INV#5
exija "trace … stale-worker rejections". Os dois são higiene de contrato/trace,
sem perda de dado.

**Evidência:** grep bilateral (`replyTo` nunca emitido; gate sem trace).

**Severidade: baixa** (superfície de protocolo morta + trace faltando; risco de
manutenção: alguém escrever lógica que dependa do `replyTo` que nunca chega).

**Correção sugerida:** emitir `replyTo` em `s.error()` OU remover o campo do
tipo; adicionar `trace("actor.epoch.stale")` no gate.

### Bug 52 (refutado) — `useBackground` seg-trim `from` adjustment (scout M6) `[-]`
Hipótese: o ajuste `from: first.from + removed.match(/\n/g)?.length` sub-conta
quando o corte divide uma linha parcial. **Refutado pelo probe** (depois
removido): chunk de 150KB em modo-linha (`A\nB\nC` de 50KB cada) com cap 96KB —
o corte cai **dentro** do run `B` (linha 2), e o ajuste dá `from=2`
(`removed` contém L1+'\n' → 1 match → from = 1+1 = 2), rotulando corretamente o
run `B` como linha 2. O tail retido começa em `'B'` (fronteira limpa de linha,
que é o melhor possível para um corte por bytes numa linha de 50KB):
```
liveTail length: 98305 starts with: BBBBB   first char: B
```
O rótulo de linha está correto; a imperfeição é o texto parcial (sufixo da
linha 2), que é inerente ao corte por bytes e está corretamente rotulado.

### Bugs 53-54 (fixtures do agente inválidas) — liveTail join e seg-trim (M5/M6) `[-]`
Os probes órfãos do agente de teste que morreu (`TestMirrorDaemonPending`)
tinham fixtures **inconsistentes** — não evidência:
- PROBE#2 injeta `from=80` num chunk após um filler de 98288 bytes (o stream
  real colocaria o chunk em 98288, não 80) e calcula `trueRemainder` que não
  bate com os inputs (o `got` de 58 bytes é o **correto** para `from=80` +
  `snapBytes=80`: todo o chunk é novo).
- PROBE#3 seta `snapBytes=102402` com stream total de 102401 (snapshot cobre
  mais que o stream) e usa modo-linha sem setar `totalLines` (→ 0, fazendo o
  join mostrar tudo).
Nenhum dos dois prova os issues M5/M6. O M6 (seg-trim) já foi **refutado** pelo
meu probe direto (Bug 52: `from` rotula corretamente após o head cut). O M5
(liveTail join gap quando o chunk de fronteira é cap-trimado) permanece
**não-provado** — fixture correta exigiria `from`/`snapBytes` consistentes com o
tamanho real do filler.

### Bug 55 — Running-tail: só o **último** renderBlock tem estado "running" `[!]`
**Arquivo:** `web/src/indirect-code/components/TranscriptBlocks.tsx:108` +
`transcript.ts:251-260` (`buildTurnBlocks`).

`running = renderBlocks().at(-1)?.msg.id === series.msg.id` — só o último bloco
do transcript inteiro é "running". `buildTurnBlocks` cria um bloco novo a cada
mensagem de texto visível, então um turno `text→tool→text→tool→text` abrange
**múltiplos blocos**: todos menos o último perdem spinner/auto-open/isActive no
meio do turno — as tool cards param de girar embora as tools ainda rodem.

**Evidência empírica** (probe do agente `TestUIReactivity`, fixture multi-texto):
```
H1 all blocks: ["single:u1", "series:m1", "series:m2", "series:m4"]
H1 blocks matching at(-1): ["m4"]      ← só 1 de 4
```
Nuança: `series.msg` é a mensagem líder (primeira do grupo), então o último
bloco tem `msg=m4` (m5 é seu `textMsg`) — ainda assim só o último tem `running`.

**Severidade: média-alta** (spinner/auto-open/isActive errados em turnos
multi-texto — cenário comum de turnos longos com tools).

### Bug 56 — `visibleRuns` funde runs de tool quando thinking está oculto `[!]`
**Arquivo:** `web/src/indirect-code/components/TranscriptBlocks.tsx:132-148`.

O merge de runs consecutivas de tools só reseta `run` num boundary non-thinking.
Com `thinkingHidden()` (verboseChat off), um entry de thinking **não** reseta →
`tools1+tools2` fundem numa run só: o primeiro entry renderiza as units de
ambos e o segundo entry renderiza `[]` (linha vazia). Default verboseChat é ON,
então pega quem desliga.

**Evidência empírica** (probe, entries `[tools1, thinking, tools2]`):
```
H2 hidden: ["t1:tools:a1=2", "thinking", "t3:tools:b1=UNDEFINED"]   ← merge + []
H2 shown : ["t1:tools:a1=1", "thinking", "t3:tools:b1=1"]           ← correto
```

**Severidade: média** (linha vazia + unidades agrupadas erradas com thinking
oculto).

### Bug 57 — Colisão de chaves de reconcile em `setBalloons` (turnIndex duplicado e path duplicado) `[!]`
**Arquivo:** `web/src/indirect-code/hooks/useTurnChanges.ts:44-48`.

Balloons são keyed `id: String(b.turnIndex)` e files `id: f.path` + reconcile
(merge). Dois defeitos:
- **turnIndex duplicado dentro de um `applySnapshot`** (ex.: balloon live +
  committed antes da dedupe do servidor): duas linhas com a **mesma chave**
  (`[3, 3]`).
- **path repetido no mesmo balloon** (ex.: `dup.ts` modified + `dup.ts` new):
  duas file rows keyed `dup.ts` → colisão.

**Evidência empírica** (probe):
```
H8 dup-turnIndex snapshot rows: 2 ids: [3, 3] files per row: [["a.ts"],["b.ts"]]
H8 dup file path: [["dup.ts:modified","dup.ts:new","other.ts:modified"]]  (3 rows, dup.ts keyed twice)
```
A sequência `applySnapshot→noteHistoryBalloons` **não** colide (histórico
dedupe por turnIndex vs prev: primeira página vence) e live+committed mesmo
turn colapsa em 1 row — o bug é só o lado do snapshot com duplicatas.

**Severidade: média** (linhas de file-changes colidem no reconcile → estado de
UI errado/linhas sumindo).

### Bug 58 — Predicado de collapse divergente entre `Composer` e `StatusBanners` `[!]`
**Arquivo:** `web/src/indirect-code/components/Composer.tsx:20` vs
`components/composer/StatusBanners.tsx:39`.

`Composer.collapsed()` inclui `!!activeSessionId`; `StatusBanners.collapsed()`
**não**. Na matriz de 16 estados, **1 linha diverge**:
`{draftMode:false, activeSessionId:'', workspaceBlocked:false, composerCollapsed:true}`
→ `composer.collapsed=false` (composer expandido) mas `banners.collapsed=true`
(task plan escondido). O invariante central (os 4 somem juntos) está correto;
só o estado transitório sem sessão ativa diverge.

**Evidência empírica** (probe, matriz completa):
```
H4 composer.collapsed=false banners.collapsed=true   (1/16 linhas divergentes)
```

**Severidade: baixa** (estado transitório; task plan some sem sessão ativa).

### Bugs 59-61 (refutados pelo probe) — useMentions timer race, pin()/forced, followTail scrollbar drag `[-]`
- **#5 useMentions**: probe com `--conditions=browser` — o timer compartilhado
  é limpo/rearmado corretamente e o `requestId` guarda cada reply: "stale reply
  after R2 dispatched → files: []", "late reply after 10s timeout → files: []".
  Sem vazamento de resultado velho.
- **#6 scroll pin()/forced**: a premissa estava invertida — o guard
  `if (!explicit() && (!opts.running() || !pinned)) return` **short-circuits**
  quando `explicit()` consome o flag: `pin() @ running=false` **já salta**
  (`scrollTop=900`) e o follow continua depois. Residual oposto (não-bug
  aqui): `schedule(true)` pula o bail de `!running()` — guardado por
  `isPinned()` em useTranscript.ts:577.
- **#7 followTail scrollbar drag**: premissa stale do scout — há **sim** um
  listener `scroll` (adicionado no commit 3325fba) que recomputa
  `pinned = scrollHeight - scrollTop - clientHeight < 32` a cada evento:
  "after scroll-only drag: scrollTop=500; after growth: scrollTop=500
  (tail=2900)" — o leitor fica onde está, sem snap-back.

### Bug 62 (residual do #3, refutado como enunciado) — colisão de `segKey` em grupos id-less explore `[~]`
O scout achou colisão de `segKey` em **units** órfãs — **refutado**: o `idx` da
unit dentro da run torna as chaves únicas (`["u:i0","u:i1"]`), e `toolRowKey`
também é único por linha; chaves alimentam só `scrollMemory`, não identidade de
DOM. **Residual real**: grupos de explore **sem toolId** colidem no fallback
`g:explore:0` — probe: `["g:explore:0","u:e1","g:explore:0"]` (dois grupos com a
mesma chave). Estreito (requer chamada explore sem id), mas é uma colisão real.

### Bug 63 — Drafts de edit são **deletados silenciosamente** quando a mensagem muda de `srcIdx` `[!]`
**Arquivo:** `web/src/indirect-code/hooks/useTranscript.ts:848-862`
(`restoreEditDraft` + `clearEditDraft`).

O draft é salvo por `llmgw-edit:<host>:<sid>:<srcIdx>` com
`source: sourceOf(msg)` = `JSON.stringify([role, text, attachmentIds])`
(useTranscript.ts:819-821). O restore faz:
```js
const msg = messages().find((m) => m.srcIdx === idx && m.role === "user");
const draft = JSON.parse(localStorage.getItem(`${editDraftPrefix()}${idx}`));
if (msg && draft?.source === sourceOf(msg) && typeof draft.text === "string") startEditMsg(idx, msg);
else clearEditDraft(idx);   // ← DELETA o draft
```
Duas falhas encadeadas:
1. **Lookup por `srcIdx` velho**: após truncation/compaction/resend a mesma
   mensagem está em outro `srcIdx` → `messages().find(m => m.srcIdx === idx)`
   **não encontra** → `clearEditDraft(idx)` deleta o texto do usuário
   **silenciosamente** (o conteúdo da mensagem pode ser idêntico — o
   `sourceOf` seria igual — mas a busca nem chega lá porque o índice mudou).
2. **Slot `...:active` único por sessão**: começar edit B sobrescreve o
   ponteiro de A → o draft de A fica órfão (nunca restaurado, deletado no
   próximo restore).

**Evidência:** leitura bilateral conclusiva (o `find` por `srcIdx` + o `else
clearEditDraft`; probe completo bloqueado por `virtual:icons` importado por
`ui.tsx` no bundle do hook — a lógica, porém, é pura e observável). Meu probe
parcial confirmou a fórmula de `sourceOf` e a chave de localStorage.

**Impacto:** o usuário digita uma edição longa, algo muda o transcript
(edit/regenerate em outra parte, compaction), e o texto **some sem aviso** ao
reabrir a conversa.

**Severidade: média** (perda de texto do usuário não salvo; recuperável só se o
usuário redigitar).

**Correção sugerida:** não deletar o draft quando o `srcIdx` não casa — manter
para recuperação manual (ou indexar por `source`/id da mensagem em vez de
`srcIdx`).

### Bug 64 — `file_balloon` é tipo fantasma no whitelist de compressão do relay `[!]`
**Arquivo:** `server/routes/relay.ts:344` (`shouldCompressRelayEvent`).

O whitelist inclui `t === "file_balloon"` — tipo que **não existe em lugar
nenhum** do repo (grep: única ocorrência é a própria linha do whitelist). Os
frames reais com balloon são `turn_file_changes` (payload `balloon`) e
`session_content` (campo `fileBalloons`) — e `turn_file_changes` **não** está
no whitelist, então é enviado **sem compressão** apesar de carregar balloon.

**Evidência:** grep bilateral (`file_balloon` só em relay.ts:344).

**Severidade: baixa** (rename em um lado só: perda de compressão em
`turn_file_changes` + superfície morta; marcador de drift de protocolo).

**Correção sugerida:** trocar `file_balloon` por `turn_file_changes` no
whitelist (o tipo real com payload balloon).

### Bug 65 — `turn_finished` é emitido **sem `hostId`** — frame órfão no multiplexing `[!]`
**Arquivo:** `indirect-code-daemon/cmd/daemon/session_actor.go:866`.

```go
a.emit(map[string]any{"type": "turn_finished", "sessionId": a.id, "ok": ok})
```
Compare com `session_status` (session_actor.go:864) e `session_data` (863):
ambos carregam `"hostId": hostID`. `turn_finished` **não** — e não tem `case` no
dispatcher do frontend (IndirectCodePage.tsx) nem no tipo `DaemonEvent`
(daemon-protocol.ts). Hoje é descartado silenciosamente (frame morto no wire),
mas com dois hosts conectados um `turn_finished` sem `hostId` passaria pelo
filtro de host do dispatcher (`msg.hostId && msg.hostId !== activeHostId()` —
frame sem hostId **passa**) e seria atribuído ao host ativo errado se alguém
adicionar um handler.

**Evidência:** grep bilateral (emissão sem hostId; ausência de case/type no
frontend).

**Severidade: baixa-média** (frame morto hoje; risco de atribuição cruzada em
futura manutenção + tráfego desnecessário no relay).

**Correção sugerida:** adicionar `"hostId": hostID` na emissão OU remover o
frame (o `session_status` idle já cobre o caso).

### Bug 66 (nota de design, corrida real) — `noteUpdate` reseta `pending→idle` numa corrida Apply × `daemon_update_check` `[~]`
**Arquivo:** `web/src/indirect-code/hooks/useDaemonUpdate.ts:124-135`.

O branch `else if (prev && (prev.lifecycle === "pending" || "updating"))` resolve
`target === current` → `done`, senão → `idle` + `target: undefined`. Se um
`daemon_update_check` (disparado a cada reconexão, IndirectCodePage.tsx:209)
emite `daemon_update` com `current` **antigo** (≠ `prev.target`) logo após o
Apply (antes do updater registrar `?updating=1`), o estado `pending` é
**resetado para idle** e o target é limpo — o botão Update volta a ficar
clicável embora um update esteja em andamento.

**Nuança:** o comentário (109-117) mostra que o reset é **intencional** —
resolve estados `pending`/`updating` stuck (F5 no meio do update, updater morto
sem promote). O trade-off: a corrida real (reconexão imediata pós-Apply) cai no
mesmo branch. Efeito: confusão de UI (botão re-clicável), não perda de dado —
o update real continua no updater.

**Severidade: baixa** (design trade-off; corrida estreita; recover por re-click).

**Correção sugerida:** um grace window (ex.: 2s) após `apply()` antes de permitir
o reset `pending→idle`, ou confirmar com o updater antes de limpar o target.

### Batch D — gateway/relay (itens restantes, leitura) `[x]`
- **WS auth lifetime divergente do REST** (`relay.ts:58-61,87-91`): `?token=` em
  query string (vaza para logs/Referer) e sem re-check de `users.status`/
  revogação após o upgrade — socket aberto continua para sempre. **Médio**
  (consistência de auth; deploy-dependent). Em §5.
- **Backpressure do fan-out** (`relay.ts:317-318,348-360`): `getBufferedAmount`
  nunca checado (socket lento acumula sem limite); sockets zumbi contam para o
  gate "zero tabs" do push. **Médio**. Em §5.
- **Push title degradado** (Bug 5): `sessionId` ausente em `session_data`
  realtime → título do push cai no fallback. **Médio-baixa**. Requer VAPID+SW.
- **`useMirror` vaza store por host** (L12): `storeFor` dentro de `createMemo`
  constrói SyncManager+IndexedDB; troca A→B→A acumula. **Baixo** (leak de
  memória em tab longa). Em §5.

### Bug 67 — `killCommand` com `reapErr` retorna 75 **sem** gravar estado terminal `[!]`
**Arquivo:** `indirect-code-daemon/packages/runner/run.go:283-287`.

```go
if reapErr != nil {
    stopHeartbeat()
    return 75    // ← sem writeState terminal
}
```
Se o reap síncrono (`startReap` → `<-reaped`) falhar (transiente no Windows:
TerminateJobObject "job did not drain", ownership_windows.go:44-58), o runner
retorna 75 **sem gravar o estado terminal** — `state.json` fica `status=running`
para sempre, até o boot F6 converter para `OutcomeUnknown`. Um comando que
**terminou normalmente** é reportado como "desfecho desconhecido".

**Evidência:** leitura bilateral conclusiva (o `return 75` sem `publish(writeState)`
antes; o caminho de sucesso grava `writeState` duas vezes logo depois — run.go:315-328).

**Severidade: baixa-média** (Windows-heavy; outcome real virando unknown após
falha transitória de reap).

**Correção sugerida:** gravar o estado terminal (done/killed + `OutcomeUnknown`)
antes do `return 75` no caminho de `reapErr`.

### Bug 68 — Janela `bgRegister` × `Disposition`: crash entre os dois suprime a notice `[!]`
**Arquivo:** `indirect-code-daemon/packages/agent/tools/bash.go:206-222`.

`t.Slow(...)` **registra** o bg job (msg `bgRegisterMsg` ao actor) **antes** de
`proc.Disposition(proc.JobID, DispBackground)` (linha 213). Um crash na janela
(ms) entre os dois deixa `disposition` **ausente** (= inline) enquanto o job row
existe. No boot, `runner_adopt.go:75-77` checa o disposition: ausente/inline →
**notice suprimida** ("a restart must never invent a wake-up for either"),
embora o comando tenha sido um bg job real. O worker gravou o disposition no
`deliver` (bash.go:213, com erro tratado), mas o registro (`t.Slow`) veio antes.

**Evidência:** leitura bilateral conclusiva (ordem no código: `t.Slow` →
`proc.Disposition`; o recovery do boot lê o disposition, não o job row).

**Severidade: baixa** (janela de ms; crash exato entre os dois calls; efeito é
notice de conclusão suprimida — o log permanece, só o wake-up se perde).

**Correção sugerida:** gravar `Disposition` **antes** do `t.Slow`, ou fazer o
boot suprir notice quando houver job row sem disposition.

### Batch C — frontend restante (leitura + probes dos agentes) `[x]`
- **`questionSubmitting` pode travar** (transcript #13): `noteQuestionError` só
  reseta quando `pendingQuestion()?.id === questionId` — id supersedo por
  snapshot deixa o modal sem resposta. **Médio** (leitura). Em §5.
- **Eventos de approval/question bypassam a ordenação** (transcript #14):
  `question_request`/`tool_approval_request` despachados sem tratamento de
  cursor — replay tardio ressuscita card morto. **Médio** (leitura). Em §5.
- **`fetchSession` race prende `waiting`** (transcript #5, MED-HIGH): dois
  fetches concorrentes → resposta do resync descartada pelo guard, `waiting`
  preso → freeze do transcript. **Médio-alta** (leitura; probe completo exigiria
  mock de fetch no hook). Em §5.
- **`useComposer` restore pode sobrescrever draft** (UI #8): efeito de restore
  re-ler localStorage a cada sid/host; janela de corrida no send. **Baixo**
  (leitura). Em §5.
- **`useMirror` vaza store** (mirror L12): `storeFor` em `createMemo` acumula
  SyncManager por host. **Baixo** (leak em tab longa). Em §5.
- **Drafts por srcIdx** → **Bug 63** (confirmado). **useMentions timer** →
  **refutado** (Bug 59). **visibleRuns/running-tail/segKey/collapse** →
  **Bugs 55-58**. **scroll pin/followTail** → **refutados** (Bugs 60-61).

### Bug 69 — Row `background_delivery` com bloco de tool renderiza bolha vazia `[!]`
**Arquivo:** `web/src/indirect-code/transcript/updaters.ts` (`normalizeSessionMessages`).

O early-return de `background_delivery` ("never rendered, never a carrier —
not even an empty one") roda **depois** do loop de blocos: se a row carregar um
`tool_result` (fold de background real!), o `ensureCarrier` cria um carrier
**antes** do check de meta — o return descarta a row user mas o carrier sintético
já foi pushado em `out`.

**Evidência empírica** (probe fase 2a, depois removido):
```
bg row bubbles: 1     ← esperado 0 (a notice nunca renderiza)
```
Row: `{role: user, content: [tool_result], meta: {background_delivery: job1}}`
→ 1 bolha vazia renderizada.

**Impacto:** o fold de um background job (row user com `background_delivery` +
tool_result) gera uma **bolha vazia** no transcript em vez de ser invisível —
o invariante documentado ("not even an empty one") é violado.

**Severidade: baixa-média** (bolha vazia estranha em folds de background).

**Correção sugerida:** mover o check de `background_delivery` para **antes** do
loop de blocos (early return no `forEach`, como a intenção original).

### Hipóteses fase 2a (refutadas/confirmadas pelo probe acima)
- **`orderedMessages` NaN comparator** — **refutado**: `toSorted` mantém ordem de
  inserção para rows unstamped (`c,a,b` determinístico, 20 rows em ordem).
  Sem bug.
- **Heurística de match de `user_message`** — **confirmada como limitação**:
  2 rows otimistas + 1 evento = só a primeira é confirmada; a segunda mantém
  texto otimista para sempre (sem evento futuro a confirme). Observação de
  design; sem fix aplicado.
- **`requestId` collection guard** — **presente** pós-fix do Bug 34.

### Bug 70 (refutado) — `applyV4` reescreve `*.wal.jsonl` (scout StorePersistence #6) `[-]`
Hipótese: o filtro `HasSuffix(".jsonl")` (v4_tool_vocabulary.go:101) inclui
`<id>.wal.jsonl`, e o rewriter droparia tails não-JSON silenciosamente.
**Refutado pelo probe** (depois removido): WAL com header + msg event + torn
tail passa por `applyV4` **intacto** — 3 linhas preservadas. Motivo:
`renameSessionToolVocabulary` só reescreve linhas com `kind:"turn"` (linhas de
WAL usam `type:"header"`/`"msg"` e caem no `probe.Kind != "turn"` →
`out = append(out, line)`); linhas não-JSON também são **preservadas**
(o scout errava em "silently dropped"). Sem mudança → nem tmp+rename acontece.

O residual real (leitura): um WAL **não** é alvo efetivo do v4 — se um dia
fosse, o rewrite seria in-place com tmp+rename, e um crash entre os dois
deixaria `<path>.v4tmp` órfão (o sweep de tmp não cobre `.v4tmp`). Baixo.

### Bug 71 (confirmado, mitigado) — `sendBounded` descarta `bgDropNoticesMsg` em timeout e o purge continua `[~]`
**Arquivo:** `sessions_admin.go:86-103` (`sendBounded`) + `:132` (chamada).

`sendBounded` retorna `false` + `trace("admin.bg.send.lost")` no timeout, mas
`purgeSession` **ignora o retorno** e continua — o hazard está documentado no
código (83-85: "a dropped drop-notices would let a late notice resurrect a
deleted session"). Confirmação: leitura bilateral.

**Mitigação atual (pós-fix do Bug 20):** `PurgeSessionBookkeeping` (chamado no
`supervisor.purge`) remove os `notice.json`/`pid.json` da sessão diretamente —
mesmo que a mensagem `bgDropNoticesMsg` se perca, os arquivos somem. O residual
é uma entrada zombie no mapa `b.notices` em RAM até o próximo restart (o
`tryNotice` falha no route da sessão purgada → no-op; sem dano).

**Severidade: baixa** (mitigado; o caso de perda é janela de 5s com bg.inbox
cheio).

### Bug 72 — Sweep de tmp não cobre a maioria dos prefixes dos writers `[!]` (leitura)
**Arquivo:** `store_sessions.go:98` (`tmpOrphanPrefixes`).

O sweep cobre 6 prefixes (`.session-`, `.migrate-`, `.storage-version-`,
`.daemon-`, `.launcher-`, `.dl-`), mas os writers reais usam **mais**:
`.config-*` (config.go), `.publish-*` (durable/file.go), `.upd-*` (boot_update/
update_flow), `.stage-*` (fetch), `.app-*` (handoff), `.stage-runner-*`
(runner_client), `att-*` (turn_attachments), `.v3tmp`/`.v4tmp` (migrations).
Crash no meio de qualquer desses tmp+rename → arquivo órfão **para sempre**
(o sweep nunca o alcança; `main.go` varre só sessions/ + raiz do slot, não
recursivo). Sem corrupção — só lixo acumulado. Confirmado por leitura (a
lista de prefixes dos writers é observável nos próprios arquivos).

**Severidade: baixa** (lixo órfão após crash; nunca limpo).

### Bugs 73-74 (refutados por leitura) — `listSessionSummaries` e `gcRunners` `[-]`
- **#73 (scout StorePersistence item 2a / 9)**: "HasSuffix(\".jsonl\") admite junk
  files" — **refutado**: `listSessionSummaries` (sessions_admin.go:24) **já**
  exclui `*.wal.jsonl` explicitamente e pula linhas com `meta.ID != id`. O
  residual (sessões com meta rasgado nunca listadas = órfãs no purge do
  cascade) é real mas defensivo: lixo não-listado não é servido ao usuário.
  Arquivo órfão fica no disco até limpeza manual. Baixo.
- **#74 (scout RunnerBackground item 18)**: "gcRunners deleta state com notice
  em retry >1h" — **refutado por leitura**: os guards são `b.jobs` + `b.notices`
  (in-memory) + graça 1h; uma notice só sai do mapa via `onAck` (que limpa a
  identity de propósito) ou `dropNoticesFor` (só em purge de sessão — onde o
  state é lixo mesmo). Uma notice ativa em retry **nunca** sai do mapa
  espontaneamente → o guard `if _, pending := b.notices[...]` a protege
  indefinidamente. Sem bug.

### Bugs 75-77 — Hipóteses de concorrência CONFIRMADAS com probe real (TestConcurrency)
**#75 — Races de config: lost update entre writers + RAM/disk divergente em
`setAutoUpdate` `[!]`** — `ws_server.go:1635-1701` + `update_host.go:101-110`.
Probe real: `onUpdateConfig(temperature=0.7)` + `rememberSelection(model-b)`
concorrentes → **lost update** (disco: settings=0.7, selection=nil; RAM
divergente). Fault seam (dir read-only): `setAutoUpdate` deixa RAM=false,
disco=true — erro engolido pelo `_ =` (update_host.go:109). Nuança: os writers
WS passam todos pelo `hostLane` serializado hoje, então WS↔WS é inalcançável
**agora** — mas qualquer caller fora do lane (update flow, código futuro)
reproduz o probe. **Médio** (contrato quebrado, exposure atual indireta).
Testes permanentes escritos e skipados: `config_race_regression_test.go` (2).

**#76 — `repairToolUseResultPairs` muta Content slice compartilhado (DATA RACE
real)** `[!]` — `packages/core/message.go:191`. Duas evidências: (a) o slice
compartilhado do tool message foi mutado len/cap 1/4→2/4 pelo
`buildContextFromLocked` (contrato "request-only" quebrado, agent.go:893-923);
(b) `go test -race` reporta **DATA RACE** entre dois `BuildContext()` concorrentes
(no slicecopy de message.go:191). Exposure real: builds concorrentes/aninhados
de contexto compartilhando arrays do transcript (estimateContext + agent loop,
resume paths). **Médio-alta** (race real confirmado pelo detector).
Testes permanentes: `repair_shared_slice_regression_test.go` (2: mutation +
-race), skipados.

**#77 — Ressurreição por turno tardio pós-purge CONFIRMADA (store layer)** `[!]``
— `supervisor.go:868-873`. Probe: actor residente real (running + queue) passou
pelo `supervisor.purge` real → shutdown → finalizer commita → purge deleta o
arquivo → **commit tardio re-cria `sessions/<id>.jsonl`** (o fence `deleted[id]`
existe só durante o purge — defer o remove). Contrapartida refutada
honestamente: o **actor em si** não committa pós-purge (`doShutdown` seta
`closing` e a promoção de queue é gated; commit precede a remoção). A
ressurreição exige um writer externo de record velho (admin fork path
`sessions_admin.go:196`, ou finalizer de encarnação racing). Fix pequeno:
tombstone por store ou fencing token checado no `saveSessionSync`. **Médio**
(classe Bug-2; janela pequena). Sem teste permanente ainda (precisa de decisão
de design).

### Bug 78 (refutado) — Zombie mail esfomeia heartbeat → falso-positivo do watchdog `[-]`
Mecanismo **confirmado**: inbox 128/128 cheio de `walAppendMsg` gen-stale de
zumbi derruba o heartbeat do worker vivo (`default:` em turn_worker.go:342) e
bloqueia o `sendInbox`. MAS o falso-positivo do watchdog é **refutado em escala
testável**: sob flood sustentado + streaming vivo, o `watchdogRound` nunca
dispara (lastProgressLag ~1ms vs threshold; o drain de 64/batch do actor
acompanha a fila de 128 e cada append drenado toca progress antes do gate de
gen). Esfomear exigiria ingresso sustentado >64 msgs/ciclo de drain por 30s —
inalcançável só com workers zumbi. **Refutado end-to-end.**

### Bugs 79-81 — Hipóteses web finais CONFIRMADAS (TestWebFinal)
**#79 — Corrida de `fetchSession` congela o transcript na perna de sid stale `[!]`**
— `order.ts:22-26` + `useTranscript.ts:519-521`. Gap event → resync `fetchSession`
(id A); `fetchSession` concorrente na janela de resposta sobrescreve
`transcriptRequestId` (id B); resposta A descartada pelo
`noteSessionDataRequestGuard` → `waiting` nunca limpa, **nenhum** follow-up
`get_session` é emitido (`request()` suprimido por `if (waiting) return`) —
eventos seguintes ficam bufferizados para sempre. Caveat: se o fetch concorrente
for da mesma sessão, a resposta dele cura via `snapshot()`; o **freeze permanente**
é a perna de sid stale (`useComposer.ts:341` com sid capturado no send, host/
sessão trocados no meio) — probe #1b: eventos congelados, zero resyncs.
**Médio-alta** (transcript trava em corrida de send × switch).

**#80 — `questionSubmitting` trava no re-show same-id após falha `[!]`**
— `useTranscript.ts:1234-1238` + `:117-118`. `answerQuestion` → erro com id
divergente → `questionSubmitting` fica `true` → próximo `answerQuestion`
recusado (linha 143) = modal preso. Sub-claim "id muda via snapshot" **refutado**
(`showQuestion` reseta em qualquer mudança de id). Mas o alcance real: o re-show
do **mesmo** id após uma falha de submit cai no early-return da linha 118 que
**mantém** `questionSubmitting=true` — retry bloqueado. Nota: o daemon atual
nunca emite `question_error` (falha de validação vira `{type:"error"}` com
pending mantido, session_actor.go:1053-1055) — então o alcance é via o campo
`questionError` local. **Médio** (modal preso após erro de submit).

**#81 — Replay de approval/question ressuscita card morto `[!]`**
— `IndirectCodePage.tsx:950-967` + `useTranscript.ts:1177-1187`.
`noteApprovalRequest`/`showQuestion` são despachados **sem** tratamento de cursor
(diferente de `handleStatusEvent`/`handleAgentEvent`). Replay de
`tool_approval_request` após `approval_resolved` ressuscita `pendingApproval`
com o callId morto; a resposta do usuário cai no branch stale do
`onApprovalResponse` (session_actor.go:1008-1017) que trace e **não emite nada**
— resposta silenciosamente descartada. Mesmo bypass para `question_request`. O
daemon estampa cursor só em agent_event/session_data/session_content/
session_compacted/session_truncated/session_status (transcript_identity.go:55-63)
— estes request events andam no wire desordenados. **Médio** (card morto na tela
+ resposta perdida em replay).

### Bugs 82-85 (refutados/parciais) — hipóteses web finais `[-]`
- **#82 useComposer draft clobber** — **refutado**: o restore só sobrescreve
  quando sid/host mudam, e todo keystroke passa por `setInputPrompt` que
  sincroniza `currentSid`/`currentHost` primeiro — texto digitado nunca fica
  atrás de sid stale. Host-switch limpa a caixa por comportamento explícito.
- **#83 useMirror leak** — **refutado**: `storeFor` é cacheado no Map de stores
  (A→B→A retorna o **mesmo** objeto); probe contou construções de
  IndexedDB/SyncManager: **zero** novas por re-switch. Ciclo de vida correto.
- **#84 preserveReadingPosition overshoot** — **refutado como enunciado**: o
  frame de apply mede rects frescos e aplica correção **relativa**
  (`scrollTop += node.top - elRectTop - anchor.offset`), scrollHeight não entra
  no delta → crescimento entre capture e apply não overshoots (probe: offset
  preservado exato com +200px). **Sub-claim CONFIRMADO**: o fallback
  `scrollTop = top` (linha 36) restaura o valor pré-capture verbatim → o view
  deriva pelo crescimento quando o node da âncora sumiu. Baixo.
- **#85 worker `previous` + carrier collision** — **parcial**: o worker path
  sempre normaliza com `previous=[]` (sync passa `messages()`) → identidade
  diverge entre caminhos (msg_<srcIdx> vs id preservado — folds/drafts keyed por
  id divergem). Mas a colisão de `tools_${wire.id}` é **inatingível** no daemon
  atual (IDs aleatórios `provider.NewMessageID`; rows legadas ganham
  `legacy_<sha>` únicos; store dedupe por ID). **Baixo** (divergência de
  identidade worker vs sync).

### Bug 86 (correção do Bug 51) — `replyTo` NÃO é código morto: é emitido pelo relay do gateway `[-]`
O Bug 51 da auditoria dizia que `replyTo` (daemon-protocol.ts:158) era "código
morto" porque o **daemon** nunca o emite. Mas o **gateway** o emite nos erros de
relay (`relay.ts:222,246` — offline/updating) e o dispatcher do frontend os
usa de verdade (`replyTo === 'pull'`/`'browse_folders'`/`'create_session'`).
A hipótese grepou só o daemon e errava o escopo. Correção: manter o campo e os
branches (o half real do Bug 51 — trace do epoch gate no daemon — está
aplicado). Lição: grep bilateral em **todos** os emissores (daemon + gateway),
não só o lado que o reporte original olhava.

### Bug 87 (correção do Bug 38) — depth de inspect estava CORRETO; só o single-file era bug `[-]`
O Bug 38 da auditoria dizia que `parseEntryLine` achatava o aninhamento de
linhas sem flag. **Os testes existentes** (`indirect-code-ui.test.ts:821`)
provam que o formato real do daemon tem a flag column de **4 colunas sempre**
(`"    bin/"` = indent 4 = flag vazia = depth 0; `"      helper.ts"` = 6 =
depth 1) — o `-4` original estava certo. Minha primeira correção (usar
`leading/2` puro) **quebrou 2 testes existentes** ao mudar comportamento real;
revertida. O **half real** do Bug 38 permanece: o single-file form aceitava só
linha com `size` definido — agora aceita bare `file.txt` e `file.txt (meta)`,
rejeitando linhas de prosa ("garbage without structure" continua null).
Lição: os testes existentes pinnavam comportamento REAL do formato do daemon,
não incidental — a auditoria cometeu o erro oposto do que costuma pegar.

---

## 4. Áreas validadas (por tópico)

### D1/D2 — Normalizador de transcript (`transcript/updaters.ts`) `[x]` — sem bug
Testado empiricamente com probe descartável (9 casos, `bun test`, todos passando):
- Tool results são içados para o carrier assistant correto (via `call_id`); rows
  `tool` nunca viram bolha. ✓
- `srcIdx` é global com `indexBase` (blocos paginados preservam o offset raw). ✓
- Mensagens `background_delivery` nunca renderizam (nem carrier vazio). ✓
- Linhas de tool repetidas em turnos diferentes renderizam ambas (sem dedup). ✓
- Carrier órfão (result sem call) abre na posição raw correta. ✓
- `cutTail` descarta exatamente além do índice retido. ✓

**Guard de fold de background (`appendToolResult`): correto, mas o nome `detached`
está invertido vs intuição.** Semântica real do daemon
(`packages/agent/tools/bash.go:264-270`):
- **placeholder de detach** (recebido no momento do detach): `Details =
  {background_job_id}` — **sem** `detached`.
- **fold terminal** (resultado final quando o job termina): `Details =
  {background_job_id, detached: true}`.

Ou seja `detached: true` marca o **fold terminal**, não o placeholder. O guard em
`updaters.ts:296` (`if (existing.detached && !details.detached) return prev`)
protege exatamente o caso certo: replay tardio de placeholder não desfaz o fold
terminal. Verificado nos dois sentidos + resultado plano. **Observação
(documental):** um leitor espera o oposto pelo nome; renomear para
`isTerminalFold` evitaria erro futuro de manutenção. Não é bug de comportamento.

Testes de fixture errados durante a sondagem (`toolId` em vez de `id`/`call_id`
no formato wire) confirmam que `utils/wire.ts` aceita os formatos Anthropic e Go
(`tool_use_id`/`call_id`/`id`), como documentado.

### C1 — WAL: torn tail, corrupção interior, evento órfão `[x]` — sem bug
Probe empírico (3 casos, `go test`, todos passando; depois removido):
- **Torn tail** (escrita parcial por kill -9): `loadSessionFused` recupera o
  prefixo válido sem erro; `openWALAppend` trunca o tail e novos eventos
  anexam limpos; replay posterior mostra só as mensagens válidas. ✓
- **Corrupção interior** (linha do meio inválida): falha fechada tanto no
  `loadSessionFused` (`wal line 2: invalid character 'B'…`) quanto no
  `openWALAppend` (recusa reparar, preservando eventos válidos). ✓
- **Evento órfão** (`turn_state` sem `turn_start`): replay não falha; é
  rastreado (`trace("wal.turn_state.orphan")`) e o `Turn` fica nil. ✓

### B1/B3/B5/B7 — Runner, notices e deleção `[x]` — sem bug (leitura)
- **B1** filename=identity: `runner/spec.go:75-85` formata e faz parse de
  `<sessionId>__<jobId>__<startedAtMs>.log` (`OutName`/`ParseOutName`), `OutDir`
  é GC-exempt. Cópia para `brain/` em transição terminal + `repairTerminalCopy`
  (runner_adopt.go:32) cura crash entre state write e brain copy. ✓
- **B3** placeholder: `bash.go:287-301` nomeia o log e instrui `bg_check`/
  `bg_await`/`bg_cancel`; a notice de conclusão (`bg_supervisor.go:540-560`)
  aponta para `bg_check` e **não contém texto de resultado** (só status +
  ponteiro). ✓
- **B5** dedupe: notice é idempotente por identidade `background_delivery`
  (session_actor.go:2076-2084 `noticeDelivered`); `bgAckMsg` tem SessionID para
  nunca aposentar notice de outra sessão (bg_supervisor.go:683-693). Retenção em
  disco (`noticePath`) + `flushNotices` no ticker. ✓
- **B7** deleção: `purgeSession` (sessions_admin.go:105) cancela jobs e envia
  `bgDropNoticesMsg`; `dropNoticesFor` (bg_supervisor.go:698) mata notices
  pendentes; `sessionSupervisor.purge` (supervisor.go:846) faz fence
  `deleted[id]` + `flights.do` para impedir ressurreição por load tardio. ✓

### C3 — Cascade de deleção de projeto `[x]` — sem bug (leitura)
`projects_actor.go:235-280`: identifica sessions do projeto doomed por
`projectForDirectory` (cobre subdiretórios via prefixo), `purgeSession` em cada
uma, save condicionado a sucesso; `sessionSupervisor.purge` marca `deleted[id]`
durante a janela (com `defer` para não bloquear sessão sobrevivente). Ainda não
validado dinamicamente a ressurreição por turno tardio (ver §5).

### D4 — Colapso do composer `[x]` — sem bug (leitura)
`Composer.tsx:20` esconde input+toolbar+footer via `collapsed()`, indisponível em
`draftMode` e em workspace blocked; `StatusBanners.tsx:64` esconde o task plan
sob o mesmo `collapsed()`. Invariante do AGENTS.md respeitado. ✓

### D5 (parcial) — `composerTokens` e `settingsValidation` `[x]` — sem bug
Probe empírico (8 casos, `bun test`): `slashCommand` (só tokens explícitos, não
paths absolutos), `activeMention` (menção vs email; aspas; caret no meio estende
o range corretamente), `insertMention` (path com espaços entre aspas; caret
correto; espaço final quando não há tail). `normalizeSkillSelection` (dedupe,
trim, cap 128) correto por leitura. ✓

### E (parcial) — Relay `[x]` — 1 bug confirmado, 1 refutado
Ver Bugs 3 (confirmado), 4 (refutado) e 5 (hipótese) em §3. Demais itens do
relatório do scout de relay ficam como hipóteses de higiene — ver §5.

---

## 5. Hipóteses pendentes (não validadas dinamicamente)

Registro do que ficou na mesa (leitura/relatórios de scout, sem reprodução
empírica dedicada nesta rodada):

**Do scout de persistência (StorePersistence, 21 candidatos):**
- **Resgate de ressurreição por turno tardio após purge de projeto** (item 2):
  o fence `deleted[id]` tem `defer` que o remove ao fim do purge; um actor
  residente com turno enfileiroado pode commitar **depois** e recriar
  `sessions/<id>.jsonl`. Requer harness multi-estado (running + queue + delete).
- **`listSessionSummaries` pula sessões com meta rasgado/ID divergente** (item 2a):
  nunca são purgadas mas o projeto some — órfãs. Requer fixture de meta corrompido.
- **Save parcial do cascade** (item 2c/17): `p.save(next)` falha após purges
  parciais → estado meio-a-meio, retry não é transacional.
- **Races de config** (item 3): 3 writers (`onUpdateConfig`, `rememberSelection`,
  `setAutoUpdate`) com check-then-act de revision sem serialização; `setAutoUpdate`
  publica RAM antes do disco. Requer 2 goroutines WS concorrentes.
- **Migração baseline stamp pula v2-v4 para slots legacy sem
  `storage_version.json`** (item 5): `stored==0` trata como fresco e estampa v4
  sem rodar as conversões. Requer fixture de slot v1 real.
- **`v4_tool_vocabulary` reescreve `*.wal.jsonl`** (item 6): filtro não exclui
  WALs; tails não-JSON são descartados em vez de preservados. Requer WAL vivo
  durante migração.
- **`openWAL` falha em `f.Sync()` sem remover o arquivo** (item 7): WAL órfão
  com prompt → `turnResumeCandidate` resume o prompt que FALHOU (turno zumbi);
  `openWAL` seguinte falha com "file exists" (lockout). Requer injeção de falha
  de fsync.
- **WALs abandonados nunca são limpos** (item 8): header.turnIndex < TurnSeq
  sobrevive a boots; `openWALAppend` com corrupção deixa sessão presa em
  "running" para sempre.
- **`gcRunners` pode deletar state de runner terminal com notice ainda em
  retry** (item 18): guards são só mapas in-memory + graça de 1h.
- **`sendBounded` descarta `bgDropNoticesMsg` em timeout** (item 19): notice
  tardio pode recriar sessão deletada (mesma classe do item 2).
- **Handoff `copyToSlot` não limpa destino** (item 21): sessão deletada após
  cópia anterior é ressuscitada no rollback; hardlinks compartilham inodes
  entre slots.
- **Tmp-orphan sweep não cobre a maioria dos prefixes** (item 14):
  `.config-*`, `.publish-*`, `.upd-*`, `.stage-*`, `.app-*`, `att-*` nunca são
  varridos.
- **`ensureLayout` estraga sessions em root quando o slot já tem `sessions/`**
  (item 16): órfãs invisíveis, sem merge.

**Do scout de relay (GatewayRelay):**
- **`file_balloon` fantasma** (`relay.ts:344`): tipo de frame no whitelist de
  compressão que não existe (reais: `turn_file_changes.balloon` e
  `session_content.fileBalloons`). Rename em um lado só. Baixo.
- **Auth de WS lifetime divergente do REST** (`relay.ts:58-61,87-91`): `?token=`
  em query string (vaza para logs) e sem re-check de `users.status`/revogação
  após o upgrade. Médio.
- **Frames daemon sem `hostId`** (`turn_finished`, `bg_notice`, `health`, etc.):
  passam pelo filtro do frontend sem atribuição; hoje descartados sem handler,
  mas risco de atribuição cruzada se um handler aparecer. Médio.
- **`useDaemonUpdate.noteUpdate` pode resetar lifecycle `pending`→`idle`**
  (`useDaemonUpdate.ts:117-136`) num `daemon_update` logo após Apply. Médio.
- **Backpressure do fan-out** (`relay.ts:317-318,348-360`): socket de cliente
  lento não é limitado (`getBufferedAmount` nunca checado); sockets zumbi
  contam para o gate "zero tabs" do push. Médio.

**Do scout de atores (DaemonSessionCore, 18 candidatos; os 4 HIGHs validados
viraram Bugs 15-18):**
- **Controle não é drenado primeiro** (issue 5, INV#4): o batch de até 64 msgs
  de data roda antes de cada checagem de control; sob pressão sustentada um
  cancel pode ser atrasado pelo backlog. Médio. Requer inundar o inbox e medir.
- **Inbox de data nunca responde busy e não tem counter de drop** (issue 6,
  INV#3): `fireAndForget` com drop counter é código morto em produção; o wsActor
  implementa a política, o inbox da sessão não. Médio.
- **Epoch-gate rejeição não é traced** (issue 7, INV#5): o branch de mismatch de
  epoch retorna sem trace/counter. Baixo-médio.
- **Mail de bg do worker não carrega `gen`** (issue 9): um worker zumbi
  quarentenado (mesmo epoch, gen antigo) pode mandar `bgTaskChunkMsg`/`Finish`
  que passam o epoch gate e mutam o estado de bg da sessão recuperada. Médio.
- **`repairToolUseResultPairs` muta o Content slice compartilhado** (issue 10):
  o pipeline de contexto deveria ser request-only; `append` no slice compartilhado
  com `a.messages` pode corromper o tail sob leitura concorrente (race). Médio.
- **`bgTaskPayloads` byte-cut pode gerar UTF-8 inválido** (issue 11):
  `content[len(content)-20*1024:]` corta no meio de rune multibyte. Médio-baixo.
- **`dropBalloonsAbove` mantém balloon no índice exato do corte** (issue 12):
  balloon em `MessageIndex == editIndex+1` sobrevive ao truncate. Baixo.
- **fork-with-edit usa two-step não-atômico** (issue 13): `truncateAndRun` manda
  `editRegenerateMsg` (truncante) + `userPromptMsg` separados; se a segunda
  perna falhar, o texto do edit é perdido (o contrato atômico de
  `discardAndResend` foi construído para evitar isso). Médio.
- **`FindCutPointMsgs` pode clampar para 0** (issue 14): compaction no-ops
  silenciosamente em transcript oversized se não houver user boundary; e
  `ownsToolCall` só olha 3 mensagens para trás (runs de >3 tool results podem
  deixar orphan result no corte). Baixo-médio.
- **`onQueueSendNow` perde a intenção sendNow em falha de startTurn** (issue 15):
  item volta para a queue sem prioridade. Baixo.
- **`sliceHistoryBlock` cap é round-up** (issue 16): até 2 grupos acima do cap
  documentado; front-end não deve assumir bound rígido de 200. Baixo.
- **Mail velho de zumbi pode esfomear heartbeat do worker vivo** (issue 17):
  inbox cheio de msgs gen-stale bloqueia `sendInbox` do worker atual → watchdog
  falso-positivo. Baixo-médio.
- **`editRegenerateMsg` (deprecated) pula repairs** (issue 18): truncamento sem
  `dropBalloonsAbove`/`pruneOrphanAttachments`/`RepairOrphanedToolResults`. Baixo
  (o primitive atômico cobre o caso novo; o deprecated só via `truncateAndRun`).

**Do scout de UI (FrontendUI, 13 candidatos; validados → Bugs 38-39; item #4
refutado → Bug 40; TDZ verificado: sem instância ativa):**
- **Running-tail staleness** (issue #1, MED-HIGH): `running` em
  `TranscriptBlocks.tsx:108` é `renderBlocks().at(-1)?.msg.id === series.msg.id`
  — só o **último** bloco é "running". `buildTurnBlocks` (transcript.ts:251-260)
  cria um bloco novo a cada mensagem de texto visível, então um turno
  text→tool→text→tool→text abrange múltiplos blocos: todos menos o último
  perdem spinner/auto-open/isActive no meio do turno. Requer turno multi-texto.
- **`visibleRuns` mescla runs de tool quando thinking está oculto** (issue #2):
  o merge só reseta `run` num boundary non-thinking; com `thinkingHidden()`
  (verboseChat off) um entry de thinking **não** reseta → tools1+tools2 fundem;
  o segundo entry renderiza `[]` (linha vazia). Default verboseChat é ON, então
  só pega quem desliga.
- **Chaves de render de segmentos órfãos colidem** (issue #3):
  `segKey = u:${toolId||'i'+idx}` — units órfãs (tool_result sem toolId) podem
  colidir; `toolRowKey = ${msgId}:${toolId||'u'+fallback}` similar. Reconcile
  reusa nó DOM entre segmentos distintos → estado de scroll/expanded errado.
- **`useComposer` restore pode sobrescrever draft** (issue #8): o efeito de
  restore re-ler localStorage a cada mudança de sid/host; paths onde o efeito
  roda com `currentSid` velho (ex.: host switch no meio do send) sobrescrevem
  `inputPromptValue` com draft antigo. Requer a janela de corrida.
- **`useMentions` timer único aninhado** (issue #9): um `timer` compartilhado
  entre debounce (180ms) e timeout (10s) + `requestId` único; digitação rápida
  pode mostrar resultados de um token anterior brevemente; residual: reset de
  `index` com `files` não-vazio → Tab/Enter pega linha velha.
- **`followTail` não solta em scrollbar drag** (issue #10): detach só em
  wheel/touchmove/pointerdown/keydown — drag de scrollbar emite só `scroll` →
  `pinned` continua true e o ResizeObserver puxa o leitor de volta ao tail.
- **`pin()` com `running=false` consome o flag forced** (issue #11):
  `explicit()` consome o one-shot `forced` mesmo quando bail em `!running()` →
  quando running vira true não há frame pendente → sem jump.
- **`preserveReadingPosition` overshoot** (issue #12): âncoras capturadas e
  aplicadas em rAF; crescimento entre capture e apply computa delta contra
  scrollHeight mudado → overshoot; fallback usa `top` velho.
- **Colisão de chaves em `setBalloons`** (issue #13): balloons keyed por
  `String(b.turnIndex)` e files por `f.path` — balloon live+committed do mesmo
  turnIndex, ou dois files do mesmo path num balloon, colidem no reconcile.
- **Divergência de predicado de collapse** (issue #7): `Composer.collapsed()`
  inclui `!!activeSessionId`, `StatusBanners.collapsed()` não — estado
  transitório draftMode=false + activeSessionId vazio esconde o task plan mas
  mantém o composer. Invariante central (os 4 somem juntos; toggle indisponível
  em draftMode/blocked) está correto — só a divergência transitória.

**Do scout de mirror/wire (FrontendMirrorWire, 13 candidatos; validados → Bugs
32-35; H4/L11 refutados pelo probe → Bugs 36-37):**
- **Ciclo de morte de reconexão** (issue H1) → **Bug 32** (confirmado por leitura).
- **`queue_add` perde `yolo`** (issue H2) → já registrado como **Bug 19**.
- **Queue edit apaga anexos** (issue H3) → **Bug 33** (leitura bilateral).
- **Correlação de pull ignora `collection`** (issue M8) → **Bug 34**.
- **`Date.now()` churn no `normalizeSession`** (issue M9) → **Bug 35**.
- **`normalizeConfig` apaga `mcpServers`/`skills`** (issue M10): `?? {}` quando o
  daemon omite a chave → campos futuros são descartados pelo cliente; e
  `lastSelection: null` (ao contrário de ausente) pode derrubar
  `configDoc().lastSelection.model` num host fresco.
- **`requestId` namespace só probabilisticamente único** (issue M7): dois tabs
  podem colidir a base (`randomUint32*1e6`), avançando em lockstep → resposta de
  um tab resolve o pull do outro (combinado com M8 = corrupção silenciosa).
- **`liveTail` join por `from` mas filtra por `seq` antes** (issue M5): gap/dup
  quando o chunk de fronteira foi podado por cap ou filtrado por seq enquanto o
  snapshot só cobre parte dele; o caminho legacy por linhas discorda sobre como
  o overlap é excluído.
- **`from` errado após trim de head do primeiro segmento** (issue M6): em modo
  linha, `removed.match(/\n/g)` sub-conta quando o corte divide a última linha
  parcial → `from` aponta meio de linha e `s.from + i > snapTotal` pula/mislabela.
- **`relayInbox` rope-cap lê o campo da mensagem de entrada** (issue L11) —
  refutado como bug (probe), mas a observação de código é real (mantido em §5
  como nota de robustez).
- **`useMirror` vaza store por host** (issue L12): `storeFor(hid)` dentro de
  `createMemo` constrói collections + SyncManager + IndexedDB no primeiro
  toque; trocar A→B→A acumula stores/listeners (só `disposeHost` na remoção de
  host; `disposeAll` só no unmount).
- **`replyTo` no contrato de erro do web nunca é emitido pelo daemon** (issue
  L13): `s.error()` (ws_server.go:176-178) não seta `replyTo`; os branches do
  dispatcher que o checam são código morto. Higiene de protocolo.

**Do scout de transcript (FrontendTranscript, 15 candidatos; validados → Bugs
29-31; item #12 refutado (o guard de `detached` está correto — ver D1); item
#9 parcialmente validado → Bug 30):**
- **Snapshot sem cursor descartado SEM resync** (issue #1, HIGH) — já registrado
  como **Bug 26** (contrato frágil; caminhos ativos carregam cursor, mas um
  emissor novo que esqueça = cliente defasado). Reachability concreto do scout:
  `session_content` de notice (IndirectCodePage.tsx:845) passa o próprio `msg`
  como overlay — se não tiver `transcript`, cai no descarte.
- **Evento sem cursor descartado uma vez que o stream existe** (issue #2):
  `order.ts:30` — `if (!cursor) { if (!stream) apply(); return; }` — sem
  `request()`. `text_delta`/`tool_result` perdidos até o próximo snapshot.
- **Troca de stream descarta eventos bufferizados** (issue #3): `change()`
  limpa `events`/`waiting`; gap events não aplicados somem se o próximo snapshot
  não tiver cursor.
- **Cap de 512 em FIFO evicção ignora estado de aplicado** (issue #4): flood de
  >512 eventos entre snapshots derruba os mais antigos, que podem ser gap events
  não aplicados.
- **Corrida de `fetchSession` prende `waiting` para sempre** (issue #5, MED-HIGH):
  dois `fetchSession` concorrentes → `transcriptRequestId` é sobrescrito, a
  resposta do resync é descartada pelo guard, `waiting` só limpa em `snapshot()`
  → todos os eventos seguintes são bufferizados e nenhum novo resync dispara
  = **freeze do transcript**. Requer duplo fetch na janela.
- **Worker path perde identidade `previous`; carriers `tools_*` não únicos**
  (issue #6): `history-worker` sempre passa `previous=[]` (diferente do sync
  path), e `tools_${wire.id}` não é único por srcIdx — duas páginas com o mesmo
  wire id criam carriers duplicados; `mergeTranscriptTail` faz double-merge ou
  ressuscita linhas velhas.
- **`orderedMessages` com dois srcIdx-null → NaN** (issue #8): ordem
  implementation-defined para linhas otimistas; e `noteHistoryPage` normaliza a
  página isolada (hoisting de tool results pode diferir de um normalize
  completo) e prepende — chamadas/resultados cruzando páginas renderizam fora de
  ordem.
- **Drafts de edit destruídos por shift de srcIdx** (issue #11): chaves
  `llmgw-edit:<host>:<sid>:<srcIdx>`; após truncation/compaction/resend o mesmo
  conteúdo está em outro srcIdx → `restoreEditDraft` falha e
  `clearEditDraft` **deleta silenciosamente** o texto do usuário. E o slot
  `...:active` único por sessão: começar edit B sobrescreve o ponteiro de A.
- **`questionSubmitting` pode travar** (issue #13): `noteQuestionError` só
  reseta quando `pendingQuestion()?.id === questionId`; se o id mudou via
  snapshot ou o erro chega para id supersedo, o modal fica sem resposta para
  sempre.
- **Eventos de approval/question bypassam a ordenação do transcript** (issue #14):
  `question_request`/`tool_approval_request` são despachados sem tratamento de
  cursor (ao contrário de `handleStatusEvent`/`handleAgentEvent`) — replay tardio
  ressuscita card de approval/question morto.
- **Heurística de match de `user_message` otimista** (issue #15): com várias
  linhas `srcIdx==null`, a primeira é substituída e as outras perdem o texto.
- **`session_truncated` via order pode ser adiado/descartado** (issue #10): com
  cursor fora de ordem durante gap, o truncate é bufferizado mas o
  `discard_and_resend` já inseriu linhas otimistas → duplicatas até um snapshot
  completo chegar.

**Do scout de runner/background (RunnerBackground, 25 candidatos; validados →
Bugs 23-25, 28; item 12 do scout está ERRADO — ver nota; items 1-2 refutados →
Bug 41):**
- **Notice acked antes do wake-up prompt durável** (issue 1, H) — **REFUTADO**
  pelo probe (Bug 41): o WAL header persiste `Prompt`+`PromptMeta` antes do ack
  e `turnResumeCandidate` retoma por `header.Prompt != ""` — o wake-up turn é
  recuperado. O scout errava em "no retry path exists".
- **Orphan kill-then-remove vs publicação terminal do runner** (issue 2, H) —
  **tratado no código**: runner_adopt.go:99-104 espera a morte do pid antes de
  remover o state (com comentário explícito sobre a ressurreição do record);
  o residual é a janela de pid-recycle, coberta pelo loop de
  `processutil.Matches`. Não é bug ativo.
- **Adoção lê transcript FROZEN, não o fused** (issue 3, H) — **mitigado na
  maioria dos casos**: `loadRecordForAdoption` (runner_adopt.go:468-476) usa
  `loadSession` (sem WAL), e `orphaned()` (runner_adopt.go:325-347) checa
  `sessionKnowsJob` (Meta + text-contains) só no frozen. **Porém** o mesmo
  `orphaned()` tem fallback via `executionReceiptPath` (runner_adopt.go:336-340)
  — e o receipt é gravado em fase `prepared` antes do launch
  (tool_receipt.go:121, com `SyncDir`) para toda tool embrulhada por
  `recordedTool` (turn_worker.go:221). Ou seja: job vivo **tem** receipt →
  `orphaned()` retorna false → adota, sem depender do link no WAL. O risco real
  sobra só para jobs sem receipt (ex.: launch fora do `recordedTool`, ou receipt
  limpo por GC antes do orfanamento).
- **`repairTerminalCopy` aceita cópia rasgada do mesmo tamanho** (issue 4, H):
  `dst.Size()==src.Size() && OutputReady` não é check de conteúdo; e se o runner
  crashou entre os dois writes terminais, o boot re-copia mas **nunca** seta
  `OutputReady=true` (só run.go:323 faz) → `tool_receipt` trata como
  `unknownExecution` para sempre.
- **Adoção interrompida perde corrida para delivery/ack** (issue 5): `bgTaskRecoverMsg`
  é best-effort (drop em mailbox cheio) mas `retainNotice` é imediato.
- **Janela disposition vs bgRegister** (issue 6): `t.Slow(...)` registra o job
  ANTES de `proc.Disposition(DispBackground)` (bash.go:213) — crash no meio →
  disposition ausente (=inline) → notice suprimida no boot pós-crash.
- **`ensureRunnerBinary` sem fsync do diretório** (issue 7): rename sem
  `SyncDir`; power loss → entrada `runners/<version>` sumida.
- **Self-copy sem integridade** (issue 8): stat check aceita arquivo não-vazio
  truncado.
- **Semântica de cancel assimétrica** (issue 9): `bg_cancel` (By=assistant) grava
  `disposition=suppressed` ANTES de matar; dashboard Stop (By=user) grava
  `disposition=background` — no restart o user-cancel re-notifica "was stopped"
  mas o model-cancel é suprimido; sidecar não distingue os dois.
- **Dashboard `bg_cancel` sem checagem de dono** (issue 10): ws_server.go:721-731
  envia `bgCancelMsg{By:"user"}` para qualquer jobID que o cliente nomear (o
  path do modelo checa dono).
- **Status/exit de cancel inventados** (issue 11): `bgTaskFinishMsg{Status:cancelled, ExitCode:-1}`
  hardcoded (bg_supervisor.go:394); se o processo já tinha saído com sucesso,
  o record diz cancelled.
- **`sessionKnowsJob` é text-contains** (issue 12 do scout — **parcialmente
  errado**): `noticeDelivered` (session_actor.go:2125-2132) é por
  `Meta["background_delivery"]`, **não** text-contains (seguro). Mas
  `sessionKnowsJob` (runner_adopt.go:352-364) **é** `strings.Contains` no texto —
  e decide adopt-vs-orphan: falso-positivo = adotar (benigno, só evita kill
  errado). O cenário de perda descrito pelo scout não existe no dedupe de notice.
- **`gcRunners` deleta state de job `inline` após 1h** (issue 14): receipt
  resolve para `unknownExecution` em replay posterior.
- **`OutName`/`ParseOutName` não round-tripa IDs com `__`** (issue 15):
  `SplitN("__", 3)` quebra se jobId/sessionId contiver `__`; `sanitize` não
  troca `:` no POSIX (vs `sanitizeID` do daemon, que troca).
- **broadcast.run() final pass não entrega o tail** (issue 16): `b.off` avança
  sem enviar aos pais conectados.
- **`killCommand` reap síncrono pode abortar publicação** (issue 17): `reapErr != nil`
  → return 75 **sem** terminal state write → state fica "running" até boot F6.
- **`maybeSelfClean` pode deletar binário de geração iniciando** (issue 18):
  sibling sem state file ainda é invisível ao ScanStates.
- **`runWith` early-return deixa heartbeat rodando** (issue 19): reapErr/
  publish-failure retornam antes do terminal write sem kill escalation.
- **CommandMain gate de 30s vs stdin grande** (issue 20): spec ~7MiB em pipe
  lento pode estourar o gate → exit 75 sem output.
- **UTF-8 splits em toda fronteira de janela de bytes** (issue 21): `TailLog`
  (8KB ReadAt → `string(buf[:n])`, tools/exec.go:177-184) e `tailAdoptedOutput`
  (32KB, runner_adopt.go:228) geram U+FFFD no tail de exibição. (Família dos
  Bugs 21/23 — mesma causa, outros pontos.)
- **`applyBgChunk`/`restoreRunnerOutput` drift linha-vs-byte** (issue 22):
  overlap em bytes, slice `m.Text[overlap:]` pode começar em rune quebrado.
- **`outputAccumulator`/`preBuf` caps por bytes** (issue 23): `preBuf[len-cap:]`
  e `bgBuffer.append` cortam rune multibyte (mesma família).
- **`ownCommand` pina kill no bootstrap PID, não no pgid** (issue 25): correto só
  porque `setProcessGroup` faz o child líder; variante de build sem Setpgid
  mataria só o líder. `groupAlive()` pode ficar true por zombie até init reaps.

**Outros:**
- **Título do push degradado** (Bug 5): `sessionId` ausente em `session_data`
  realtime. Médio-baixa. Requer VAPID + service worker.
- **Fluxo completo de settings** (`useSessionOptions` além de
  `normalizeSkillSelection`): não exercitado dinamicamente.

---

## 6. Como reproduzir (probes descartáveis usados)

Todos os probes eram temporários (`zz_audit_*.go` / `zz-audit-*.test.ts`) e
foram **removidos** ao final de cada validação (não fazem parte do repositório).
Para reproduzir qualquer achado: recriar o probe descrito em §3/§4 a partir dos
caminhos de arquivo citados. Gates de baseline usados: `go test ./...`,
`go test -race ./...`, `bun test`, `bun run typecheck` (todos verdes antes da
auditoria — os bugs achados estão fora da cobertura dessas suites).
