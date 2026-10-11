# Auditoria empírica — Indirect Code (daemon + frontend)

Objetivo: **encontrar bugs e comportamentos errados empiricamente**, sem corrigir.
Cada tópico abaixo é testado/validado a fundo, um por vez, e documentado em
`findings.md` (achados) — com reprodução, evidência (log/saída de teste) e severidade.

Metodologia por tópico:
1. Ler o código relevante e formular hipóteses de falha.
2. Escrever teste/reprodução real (Go test, script de integração, ou cenário
   rodando o binário do daemon) — não só leitura estática.
3. Registrar resultado em `findings.md` com status: **BUG CONFIRMADO** /
   **SUSPEITO (não reproduzido)** / **OK (validado)** / **NÃO TESTÁVEL AQUI**.

## Checklist de tópicos

### A. Runner e tarefas em background
- [ ] A1. `runners/<job>.state.json` como contrato de recuperação: escrita
      atômica? sobrevive a crash do runner? campos completos (pid/pgid/identity)?
- [ ] A2. Cópia do log para `brain/` na transição terminal; `OutputReady`;
      ordem state→copy→state; falha de cópia (rc 75) e o que o daemon faz.
- [ ] A3. `AutoBackgroundAfter` (10s): placeholder nomeia o log; notice de
      conclusão sem texto de resultado; `background_delivery` deduplica retries.
- [ ] A4. `.disposition` (background/inline/suppressed): ausente = inline;
      só outcomes em background acordam o agent.
- [ ] A5. Adoção de runners vivos no boot (`runner_adopt.go`): matar órfãos
      não-linkáveis/velhos; correr após crash do daemon.
- [ ] A6. Reap da árvore de processos (TERM → grace → KILL + sweep de pgid);
      descendentes setsid; códigos 128+sinal; `bg_cancel` silencioso vs
      Stop do dashboard entrega notice.
- [ ] A7. `bg_await` acorda em transições; timeout; cancelamento.
- [ ] A8. Race conditions no runner (testar com `-race`), heartbeat, `broadcast`.

### B. Actor de sessão (cmd/daemon)
- [ ] B1. Invariantes do `sessionActor`: um goroutine, mailbox, `control` drenado
      primeiro; mailbox cheia → busy/counter.
- [ ] B2. `epoch`/`gen`: mensagens stale de worker rejeitadas; trace de rejeições.
- [ ] B3. Watchdog kill = crash: recuperação via WAL/disk, não estado parcial.
- [ ] B4. `cancelRounds`/quarentena: cancelamento aceito nunca perdido.
- [ ] B5. `discard_and_resend` / `fork_and_resend` estavam em `pendingResendOp`
      durante turno rodando — duplicação de mensagem do usuário (regressão
      conhecida já corrigida? validar).
- [ ] B6. Supressão de turnos tardios após deleção de sessão/projeto
      (`purgeSession`, cascata) — late turn não recria dados deletados.

### C. WAL e persistência (store_wal, store_sessions, durable)
- [ ] C1. Append-only WAL: fsync, rotação, replay após crash, corrupção parcial.
- [ ] C2. Snapshot/assemble: dedupe de sessões (regressão conhecida), tamanho,
      truncamento.
- [ ] C3. `durable.WriteFileAtomic`: rename, permissões, diretórios.
- [ ] C4. Migrações V1→V2 (manual) e `internal/migrations` (v4_tool_vocabulary):
      idempotência, dados preservados.

### D. Espelho navegador (frontend store/hooks)
- [ ] D1. Debounce 300ms de `saveSession`/`saveProjects`/`saveConfig`/`purgeSession`
      — perda de ping no fechamento da aba? coalescência correta?
- [ ] D2. Pull de snapshots inteiros; uma store por hostId; IndexedDB
      persistência/limpeza.
- [ ] D3. `normalizeSessionMessages` preserva folds entre snapshots.
- [ ] D4. Deleção de projeto → purge em cascata de cada conversa; corrida
      late-turn.

### E. Transcrição e streaming
- [ ] E1. `agent_event`/`session_content` event-driven; reconexão não perde
      eventos; `srcIdx` mapeia mensagens de display para índices brutos.
- [ ] E2. Resultados de ferramenta exibidos no carrier do assistant.
- [ ] E3. Colapso do composer esconde input/toolbar/footer/task plan;
      indisponível em `draftMode` ou workspace bloqueado.
- [ ] E4. Fold de snapshots terminais na linha original (bg).

### F. Ferramentas do agent (packages/agent/tools)
- [ ] F1. `edit.go` (1046 linhas): fuzzy replace, múltiplos edits, edits
      sobrepostos, arquivo grande, encoding.
- [ ] F2. `bash.go`/`python.go`: runner, sandbox, timeouts, kill.
- [ ] F3. `fetchurl.go`: SSRF, redirects, tamanho, timeouts.
- [ ] F4. `search.go`, `glob.go`, `inspect.go`, `read.go`, `write.go`, `unish.go`.
- [ ] F5. `sandbox.go`: escapes, symlink, path traversal.

### G. Core agent (packages/core)
- [ ] G1. `agent.go` (1525 linhas): loop de turnos, tool dispatch, erros.
- [ ] G2. `compaction.go`/`compact.go`: correntes, overflow, manual/auto.
- [ ] G3. `question.go`, `plan.go`, `retry.go`, `budget.go`, `resume.go`.

### H. Provider (packages/provider)
- [ ] H1. `anthropic.go`: streaming SSE, tool use, erros, retries, usage.
- [ ] H2. `openai.go` (se houver), paridade de usage (input inclui cached na
      OpenAI; Anthropic não).

### I. Update flow / multi-call binary
- [ ] I1. `update_flow.go` (687 linhas): slot swap, `--update-start/end`,
      verificação SHA, rollback.
- [ ] I2. `verify_release.go`, `verify-release-dist.ts`, artefatos dist.

### J. WS / relay / protocolo
- [ ] J1. `ws_server.go` (1659 linhas): auth, reconnect, backpressure, ping.
- [ ] J2. `protocol.go`: schemas, validação de mensagens malformadas.
- [ ] J3. `handoff.go` (539 linhas): pairing, hostId, remoção de host.

### K. Segurança
- [ ] K1. Vazamento de segredos em logs/serialização (chaves, TOTP, GATEWAY_SECRET).
- [ ] K2. Path traversal em ferramentas de arquivo; sandbox de comandos.
- [ ] K3. `empirical_security.test.ts` / `security.test.ts` — validar cobertura real.

### L. Frontend (web/src/indirect-code)
- [ ] L1. `useSessionData.ts` (835), `useSessionActions.ts` (622): estados de
      corrida, memórias Solid TDZ, efeitos.
- [ ] L2. `SessionView.tsx` (1253), `TaskPlan.tsx` (871), `TurnGroup.tsx` (822):
      renderização, keys, listas virtuais.
- [ ] L3. `useMirror.ts`, `store/sessions.ts`: SignalDB, IndexedDB, um store por hostId.
- [ ] L4. `Modal`/toasts: `data-usal` proibido; fill-mode backwards.

### M. Gates de build/CI
- [ ] M1. `bun run lint`, `bun run typecheck`, `bun test`, `go test ./...`,
      `go test -race ./...`.
- [ ] M2. `bun run build:web`, `bun run build:daemon`.
- [ ] M3. Scripts `scripts/verify-release-dist.ts`, testes de UI Playwright
      (se disponíveis localmente).

## Status dos gates executados nesta sessão
- `go test ./...` (daemon): PASS (todos os pacotes, incluindo os probes `zz_empirical_*`).
- `go test -race ./...`: PASS.
- `go test ./cmd/daemon/ -v`: 292 testes PASS.
- `bun run typecheck`: PASS.
- `bun test` (suíte completa): instável — ver M1 em `findings.md`.
- Suítes isoladas do frontend/gateway: todas PASS (14 + 10 + 18 + 120 + 10 testes).

Resultado consolidado: ver `findings.md` (5 bugs confirmados, 2 suspeitos,
demais áreas validadas OK com evidência).
