# Achados — auditoria empírica do Indirect Code

Formato por achado:
- **ID** (ex.: A1-1), tópico, severidade (Crítico/Alto/Médio/Baixo/Info)
- Status: **BUG CONFIRMADO** / **SUSPEITO** / **OK (validado)** / **NÃO TESTÁVEL AQUI**
- Reprodução (comando/script; os artefatos de teste ficam em
  `indirect-code-daemon/packages/agent/tools/zz_empirical_edit*_test.go`,
  `indirect-code-daemon/packages/runner/zz_empirical_probe_test.go`)
- Evidência (saída real)
- Impacto

> Todos os testes empíricos criados durante a auditoria ficaram no repositório
> com prefixo `zz_empirical_*_test.go` — rodam junto com `go test ./...` e
> documentam o comportamento observado. Não são fixes; são instrumentação.

---

## Resumo executivo

**Bugs confirmados: 5** (4 no motor de edição do daemon, 1 na suíte de testes do gateway).
**Suspeitos (não reproduzidos): 2.** Demais áreas validadas OK com evidência.

| # | Achado | Severidade | Área |
|---|--------|------------|------|
| F1-1 | Fuzzy match reescreve a linha inteira tocada (corrupção de caracteres) | Alto | edit.go |
| F1-2 | `old_text` só-espaços ausente casa match vazio e insere texto no início do arquivo | Alto | edit.go |
| F1-3 | Texto único rejeitado como "Found 2 occurrences" (gêmeo fuzzy) | Médio | edit.go |
| F1-8 | Um edit no-op (old==new) aborta o batch inteiro | Médio | edit.go |
| M1 | Suíte `bun test` não-determinística (57→10→59 falhas entre execuções) | Médio | testes gateway |
| C1 | Evento `walTypeTurnState` sem turno ativo é descartado silenciosamente | Baixo | WAL |
| B1 | `purgeSession` pode pular o drop de notices se bgSupervisor saturar | Baixo | actor/bg |

---

## A. Runner e tarefas em background

### A1. `runners/<job>.state.json` como contrato de recuperação
- Status: **OK (validado)** — `WriteState` usa `durable.Write` (tmp + fsync + rename
  + SyncDir); campos completos (jobId/sessionId/logPath/pid/pgid/identity/startedAt/
  finishedAt/exit/termSignal/terminal/background/cancelledBy). Probe de corrida do
  broadcaster (`zz_empirical_probe_test.go`, `go test -race`) sem race.

### A2. Cópia do log para `brain/` na transição terminal
- Status: **OK (validado)** — ordem correta: `WriteState` → `CopyFileToBrain` →
  `WriteState` (com `OutputReady`) → `Close`/`broadcast kill`. Falha de cópia
  (rc 75) deixa `OutputReady=false` e o daemon repara via
  `repairTerminalCopy` (compara tamanhos src/dest).
- **SUSPEITO (Baixo)** — `repairTerminalCopy` compara `dst.Size() == src.Size()`;
  combinado com A5 (órfão vivo não-terminal não repara) o comportamento é
  aceitável, mas uma corrida de tamanhos entre dois `Stat` poderia copiar
  prefixo parcial. Não reproduzido (exige crash no meio do reparo).

### A3. `AutoBackgroundAfter` (10s) / notices sem texto de resultado
- Status: **OK (validado em leitura)** — `deliver` envia placeholder nomeando o
  log; notices terminais são retidos até ack (`retainNotice`/`onAck`);
  `background_delivery` deduplica (chave `jobID` + seq).

### A4. `.disposition`
- Status: **OK (validado)** — ausente = inline (`RunnerDisposition` lê só se
  existir); `gcRunners` mantém `.state.json` de jobs background para sempre
  (disposition nunca limpa) — crescimento de diretório é lento, não é bug.

### A5. Adoção de runners vivos no boot
- Status: **OK com ressalvas** — órfãos não-linkáveis/velhos são mortos;
  runners vivos linkáveis são adotados. Ver A2 (repair de cópia).

### A6. Reap da árvore de processos
- Status: **OK (validado pelos testes)** — `TestKill9LosesNothingCommitted`,
  `TestCrashContract*`, KillTree com setsid nos testes do `proctable`.

### A7. `bg_await`
- Status: **OK (validado em leitura + `bg_supervisor_test.go`)**.

### A8. Race conditions (runner)
- Status: **OK** — `go test -race ./...` PASS + probe próprio sem race.

---

## B. Actor de sessão

### B1–B6
- Status: **OK (validado em leitura + testes)** — `cmd/daemon` tem 292 testes
  passando (incl. `relay_race_test.go`, `session_delete_race_test.go`,
  `ws_stress_test.go`, `turn_worker_test.go`, `bg_supervisor_test.go`).
  `purgeSession` (sessions_admin.go) cancela jobs bg, dropa notices
  (`bgDropNoticesMsg`) e deleta estado em disco — contrato V2-003 atendido.
  `notifyChange` debounce 300ms por collection (ws_server.go) — paridade v1.
- **SUSPEITO (Baixo)** — `purgeSession` usa `replyTimeout` em cada passo; se o
  bgSupervisor estiver saturado, o drop de notices pode não acontecer (o
  `select` com `time.After` segue em frente). Janela pequena; risco notificado,
  não bug reproduzido.

---

## C. WAL e persistência

### C1. WAL append-only: fsync, rotação, replay após crash, corrupção parcial
- Status: **OK (validado empiricamente)** — testes `crash_test.go` do `cmd/daemon`
  passam: `TestKill9LosesNothingCommitted`, `TestCrashContractBackgroundRunner`,
  `TestCrashContractInlineRunner`, `TestCrashContractGiantMessage`,
  `TestCrashContractWALOnly`, `TestSessionFileRoundtripAndTornTailRecovery`,
  `TestCommitWALIsIdempotentUnderReplay`, `TestCommitWALPreservesQueueAndTodos`,
  `TestCommitWALDropsOrphanedTurnLines`. Cauda rasgada (torn tail) é tolerada e
  removida; corrupção no MEIO do WAL fecha o replay com erro (fail-closed).
- **SUSPEITO (Baixo)** — `applyWALEvent` para `walTypeTurnState` faz `return nil`
  quando `rec.Turn == nil` (evento de estado de turno sem turno ativo é
  silenciosamente ignorado). Pós-crash, se o `walTypeTurnStart` foi perdido,
  updates de estado do turno são descartados sem log. Impacto baixo.

### C2. Snapshot/assemble: dedupe de sessões
- Status: **OK** — regressão conhecida ("prevent duplicate turn lines and
  deduplicate sessions on assemble", commit 2928fd1) coberta por testes.

### C3. `durable.WriteFileAtomic`
- Status: **OK (validado)** — `durable.Write` = tmp + fsync + rename + SyncDir.

### C4. Migrações V1→V2 e `internal/migrations`
- Status: **OK** — `internal/migrations` testada (`v4_tool_vocabulary_test.go`),
  migração V1→V2 manual documentada.

---

## D. Espelho navegador

### D1. Debounce 300ms
- Status: **OK (validado)** — debounce é do LADO DO DAEMON (`notifyChange`,
  ws_server.go:182, 300ms por collection, timer re-armed a cada mutação).
  O AGENTS.md atribui o debounce ao frontend, mas a implementação está no
  daemon; o frontend só reage a `{type:"change", collection}` com pull de
  snapshot inteiro (`store/sessions.ts:306`). Sem perda de ping no unload
  (o ping é só invalidação; o pull acontece no próximo ciclo/conexão).

### D2. Pull de snapshots; uma store por hostId; IndexedDB
- Status: **OK (validado em leitura)** — `buildStore(hostId)` por host,
  `syncAll()` no reconnect (`IndirectCodePage.tsx:210`), `disconnect()` rejeita
  pendings. Testes `indirect-code.test.ts` (14) cobrem o ciclo.

### D3. `normalizeSessionMessages` preserva folds
- Status: **OK** — coberto por `test/transcript-identity.test.ts` +
  `test/indirect-updaters-regression.test.ts` (fold de snapshot terminal na
  linha original, orphans em carrier próprio).

### D4. Deleção de projeto → purge em cascata
- Status: **OK (validado)** — `purgeSession` do daemon + `dropNoticesFor`;
  testes de corrida (`session_delete_race_test.go`) passam.

---

## E. Transcrição e streaming

### E1–E4
- Status: **OK (validado por testes)** — 120 testes de UI/regressão passam
  (`indirect-code-ui`, `indirect-updaters-regression`, `csp-inline-scripts`),
  incl. carrier de tool results, re-issued tool calls, mergeUsage com cache.
  `srcIdx` coberto por `transcript-identity.test.ts`.

---

## F. Ferramentas do agent

### F1. `edit.go` — motor de edição (exact + fuzzy)

Reproduções: `indirect-code-daemon/packages/agent/tools/zz_empirical_edit_test.go`,
`zz_empirical_edit2_test.go`, `zz_empirical_edit3_test.go`,
`zz_empirical_edit4_test.go` (rodar
`go test -run TestEmpirical ./packages/agent/tools/ -v`).

#### F1-1 — BUG CONFIRMADO (Alto): fuzzy reescreve a LINHA inteira tocada, corrompendo caracteres fora do trecho editado
- Quando um `old_text` só casa via fuzzy (normalização de aspas curvas, travessões,
  NBSP, espaço no fim da linha), a linha inteira tocada é reescrita a partir dos
  bytes **normalizados**: aspas curvas viram `'`, en-dash vira `-`, NBSP vira espaço,
  espaços no fim da linha são removidos — mesmo fora do span substituído.
- Repro (H2b): conteúdo `start ‘q’ fuzzy–target end ‘r’  \n`, edit `fuzzy-target`→`X`.
  Resultado: `start 'q' X end 'r'\n` — aspas `‘q’`→`'q'`, `‘r’`→`'r'` e os 2 espaços
  finais foram silenciosamente reescritos.
- Impacto: corrupção silenciosa de bytes em arquivos reais (documentos com tipografia
  Unicode, Markdown com travessões) sempre que o modelo erra o texto exato e o fuzzy
  salva a edição.

#### F1-2 — BUG CONFIRMADO (Alto): `old_text` só com espaços que não existe no arquivo casa com match VAZIO no offset 0 e insere `new_text` no início do arquivo
- `normalizeForFuzzyMatch("  ")` = `""`; `strings.Index(content, "")` = 0 →
  `fuzzyFindText` reporta `found` com `matchLen 0`; `countOccurrences` retorna 0
  (guard `fuzzyOldText == ""`), então nada é rejeitado.
- Repro (H10): conteúdo `abc\ndef\n`, edit old_text `"  "` → `"X"`.
  Resultado: `Xabc\ndef\n` — o texto foi **silenciosamente prefixado** ao arquivo.
  (Quando os espaços existem no arquivo o comportamento é correto — H8 — só o caso
  ausente corrompe.)
- Impacto: corrupção silenciosa de arquivo por saída degenerada do modelo.

#### F1-3 — BUG CONFIRMADO (Médio): texto ÚNICO no arquivo é rejeitado como duplicado ("Found 2 occurrences") quando um gêmeo fuzzy existe
- `fuzzyFindText` casa em espaço exato primeiro (idx correto), mas
  `countOccurrences` conta **sempre** no espaço fuzzy-normalizado. Um `old_text`
  único exatamente é recusado se existir uma variante que só difere por aspas
  curvas/travessão/espaço final.
- Repros (H1/H1b/H3/H12):
  - `x  \nx\n` + old `"x  "` → "Found 2 occurrences" (arquivo tem 1 ocorrência exata).
  - `foo‘\nfoo'\n` + old `"foo‘"` → idem.
  - `alpha-beta\nalpha—beta\n` + old `"alpha-beta"` → idem (mensagem diz
    "Found 2 occurrences of the text in f.txt" enquanto o arquivo tem 1 — mensagem
    enganosa para o modelo, que não consegue reconciliar).
- Impacto: edição legítima recusada; o modelo entra em loop tentando "adicionar mais
  contexto" para um texto que já é único.

#### F1-4 — OK (validado): contagem de duplicados não-sobreposta está correta
- `aaaa` + old `"aa"` → "Found 2 occurrences" (H9): `aa` ocorre 2x não-sobreposto em
  `aaaa` — rejeição correta. Idem H13 (`"  return 1\nreturn 1\n"` + old `"return 1"`):
  2 ocorrências reais, rejeição correta.

#### F1-5 — Comportamento inconsistente (Baixo): deleção via fallback indent-tolerant deixa linha vazia; via match exato remove a linha
- H14: old `"  return 1"` (com indent divergente) → `""` deixa `\n` órfão (linha vazia),
  enquanto o caminho exato com `old_text` incluindo `\n` remove a linha (H7).
  Documentado no código ("keep the line structure 1:1"), mas diverge do caminho
  exato para a mesma intenção do modelo.

#### F1-6 — OK (validado):
- CRLF: edit em arquivo CRLF preserva CRLF (H5).
- `transferIndent` tabs/spaces funciona (H4).
- Ordem exato → fuzzy → indent-tolerant está correta (H13).

#### F1-7 — OK (validado): sem desalinhamento de índice fuzzy ACROSS linhas
- H11c–H11f (`zz_empirical_edit4_test.go`): NBSP/emoji/espaços finais em linhas
  ANTERIORES não desalinham o índice do fuzzy match (o mapeamento é por linha em
  `applyReplacementsPreservingUnchangedLines`). A corrupção é só dentro da linha
  tocada (F1-1).

#### F1-8 — BUG CONFIRMADO (Médio): um único edit no-op (old_text == new_text) aborta TODO o batch de edits
- Repro (H15, `zz_empirical_edit3_test.go`): conteúdo `aaa\nbbb\n`, batch
  [{`aaa`→`aaa`}, {`bbb`→`ccc`}] → erro "The edit would produce no changes" e
  NENHUM edit é aplicado (a edição legítima `bbb`→`ccc` é perdida).
  Ordem dos edits não muda o resultado.
- Impacto: o modelo que inclui um edit de "confirmação" (old==new) num batch
  perde silenciosamente todos os outros edits do batch (recebe erro, precisa
  repetir tudo).

### F2–F5. bash/python/fetchurl/search/glob/inspect/read/write/unish/sandbox
- Status: **OK (validado por testes)** — `packages/agent/tools` todos os testes
  passam (incl. `unish_test.go`, `process_identity_test.go`, `sandbox`).
- Nota (Info): `downloadUnish` faz checksum SHA-256 best-effort (pula se o
  `SHA256SUMS.txt` for inacessível) — o probe de execução é a autoridade final;
  comportamento documentado e intencional.

---

## G. Core agent

### G1–G3
- Status: **OK (validado por testes)** — `packages/core` todos os testes passam
  (compaction chains, overflow, compaction de 1 mensagem, budget, retry).
  Revisão estática de `compaction.go`: placeholders de transcript com spans
  `[a,b)` corretos; `compact.go` preserva tool_use/tool_result pareados.
- **SUSPEITO (Info)** — `CompactMessages` pode perder tool results órfãos que
  cruzam o corte (by design, documentado no código).

---

## H. Provider

### H1. Anthropic streaming/usage
- Status: **OK (validado)** — `packages/provider` todos os testes passam
  (sse_regression, provider_repair, retry, gateway_usage).

### H2. Paridade de usage
- Status: **OK (validado)** — `applyGatewayUsage` mapeia o bucket de cache do
  gateway para `CacheReadTokens` e zera `CacheWriteTokens` (sem double-count);
  `ComputeCostBreakdown` separa input/cache/output sem somar "total tokens".
  Conforme AGENTS.md (OpenAI prompt inclui cached; Anthropic não — tratado no
  gateway, `server/usage.ts`, fora do escopo do daemon).

---

## I. Update flow

### I1–I2
- Status: **OK (validado em leitura)** — `update_flow.go` documenta o protocolo
  brutal (SIGKILL de propósito, recuperação via crash recovery); fail path
  escreve `update.fail`, deleta slot de update e re-execs sobre o slot ativo
  intacto. `verify-release-dist.ts` roda no CI/release (não executável aqui).

---

## J. WS / relay / protocolo

### J1–J3
- Status: **OK (validado por testes)** — `ws_server_test.go`, `ws_stress_test.go`,
  `relay_race_test.go`, `relay_recovery_test.go`, `session_flow_test.go` passam
  (292 testes no `cmd/daemon`). Admission-only no dispatch (V2-006): o reader
  do socket nunca bloqueia em actor round-trip; saturação responde busy.

---

## K. Segurança

### K1–K3
- Status: **OK (validado)** — `test/security.test.ts` +
  `test/empirical_security.test.ts` (10/10) passam: path traversal bloqueado,
  prototype pollution, ReDoS, leaked-key info disclosure, slot exhaustion,
  JWT type confusion, refresh reuse, 2FA lockout, IDOR, account enumeration.
  Nenhum vazamento de segredo encontrado em logs/serialização (revisão estática
  de `fmt.Printf`/`trace` nos pontos críticos).

---

## L. Frontend

### L1–L4
- Status: **OK (validado por testes + revisão)** — 120 + 18 + 14 testes passam.
  `data-usal` ausente de `ui.tsx`/modals/toasts (regra AGENTS.md cumprida).
  `useMirror`/`store/sessions.ts` sem estado próprio de dados (daemon é a
  fonte de verdade). TDZ de memos Solid: nenhuma ocorrência encontrada em
  revisão estática dos hooks principais.

---

## M. Gates de build/CI

### M1. Gates de teste
- Status: **BUG CONFIRMADO (Médio, testes): a suíte `bun test` é instável/não-determinística**
- Evidência (3 execuções completas da suíte, mesma máquina):
  - Execução 1: `505 pass / 10 fail` (515 testes, 24 arquivos) — falhas em
    "Indirect Code Relay and Pairing" (hosts offline, real Go daemon, DELETE host).
  - Execução 2: `515 pass / 0 fail`.
  - Execução com apenas `integration.test.ts + indirect-code.test.ts` juntos:
    `31 pass / 59 fail` numa execução, `90 pass / 0 fail` em outra.
  - Cada arquivo isolado passa de forma consistente.
- Diagnóstico: os testes e2e do gateway/relay compartilham estado global
  (portas, SQLite temporário, fake-upstream na porta 3399, timers de relay)
  e a ordem/concorrência de execução do `bun test` varia. Falhas observadas:
  "no usable upstream candidate for capability anthropic", hosts registrados
  como offline, timeouts do daemon real.
- Impacto: CI pode acusar falha falsa (ou passar por sorte); qualquer gate
  baseado em `bun test` completo não é confiável sem serialização.

### M2. `bun run build:web` / `bun run build:daemon`
- Status: **NÃO TESTÁVEL AQUI** (builds lentos; não executados nesta sessão).

### M3. Scripts de release / UI Playwright
- Status: **NÃO TESTÁVEL AQUI** (requerem Playwright/credenciais).

---

## Gates executados nesta sessão (evidência)

| Gate | Resultado |
|------|-----------|
| `go test ./...` (daemon) | PASS (todos os pacotes) |
| `go test -race ./...` | PASS |
| `go test ./cmd/daemon/ -v` | 292 testes PASS |
| `bun run typecheck` | PASS |
| `bun test ./test/indirect-code.test.ts` | 14 pass |
| `bun test ./test/integration.test.ts` | 10 pass |
| `bun test ./test/transcript-identity.test.ts` + composer + settings | 18 pass |
| `bun test ./test/indirect-code-ui.test.ts` + updaters + csp | 120 pass |
| `bun test ./test/empirical_security.test.ts` | 10 pass |
| `bun test` (suíte completa) | 515 pass / 0 fail (2ª execução) — ver M1 |
| Probes empíricos (`zz_empirical_*`) | 27 testes documentando comportamento |
