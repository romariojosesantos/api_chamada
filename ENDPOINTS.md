# API Endpoints — Controle de Presença

Resumo organizado das rotas expostas pelo backend (método, caminho, auth, parâmetros esperados e observações).

Obs:
- Muitos endpoints requerem o header `Authorization: Bearer <token>` (token HMAC implementado em [auth.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/auth.js)).
- Quase todas as rotas relevantes exigem também o header `x-institution-id` (exceto rotas admin/master que podem operar cross-instituição). O middleware em [_server.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/_server.js) valida e popula `req.id_instituicao`.

---

## /api/auth (arquivo: [auth.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/auth.js))
- POST /api/auth/register
  - Auth: público
  - Body: { nome, email, senha, perfil, id_instituicao }
  - Cria usuário; bloqueia criação de múltiplos `master`.

- POST /api/auth/login
  - Auth: público
  - Body: { email, senha }
  - Retorna: { token, user }

- GET /api/auth/instituicoes
  - Auth: público
  - Lista instituições (id, nome).

- GET /api/auth/has-master
  - Auth: público
  - Retorna se já existe usuário master.

- GET /api/auth/me
  - Auth: Bearer token
  - Retorna dados do usuário autenticado (inclui instituições vinculadas).

- POST /api/auth/change-password
  - Auth: Bearer token
  - Body: { senhaAtual, novaSenha }
  - Altera senha do usuário autenticado.

- Admin (require perfil `master`):
  - GET /api/auth/admin/usuarios — lista usuários (inclui instituições)
  - GET /api/auth/admin/usuarios/pendentes — lista cadastros pendentes
  - PUT /api/auth/admin/usuarios/:id/aprovar — aprovar usuário pendente
  - DELETE /api/auth/admin/usuarios/:id/rejeitar — rejeitar e remover cadastro
  - POST /api/auth/admin/usuarios — criar usuário (master apenas)
  - PUT /api/auth/admin/usuarios/:id — atualizar usuário
  - PUT /api/auth/admin/usuarios/:id/senha — redefinir senha

---

## /api/alunos (arquivo: [alunos.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/alunos.js))
- GET /api/alunos/
  - Auth: Bearer token + x-institution-id
  - Query: nome, turno, transporte, status
  - Lista alunos da instituição com filtros; inclui dias matriculados via subquery.

- GET /api/alunos/por-dia
  - Auth: Bearer token + x-institution-id
  - Query: data=YYYY-MM-DD, ignoreFilters (true|false), professor
  - Retorna alunos esperados para a data (modo chamada) ou relatório (ignoreFilters=true). Verifica dias_sem_aula.

- GET /api/alunos/frequencia-plena
  - Auth: Bearer token + x-institution-id
  - Query: inicio, fim (datas)
  - Retorna agregados de presença por aluno no período.

- POST /api/alunos/upsert-bulk
  - Auth: Bearer token + x-institution-id
  - Body: array de alunos ou { alunos: [], atividades: [] }
  - Importação em lote (planilha): upsert de alunos, resolver/criar atividades e professores, criar/atualizar matrículas. Executa em transação.

- POST /api/alunos/
  - Auth: Bearer token + x-institution-id
  - Body: (validação Joi) campos de aluno
  - Cria aluno (usa validation.validate('aluno')).

- DELETE /api/alunos/:id
  - Auth: Bearer token + x-institution-id
  - Remove (ou soft-delete) aluno indicado.

---

## /api/presenca (arquivo: [presenca.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/presenca.js))
- GET /api/presenca/
  - Auth: Bearer token + x-institution-id
  - Retorna histórico de presenças da instituição (exclui dias_sem_aula).

- POST /api/presenca/
  - Auth: Bearer token + x-institution-id
  - Body: { data: ISODate, chamadas: [{ aluno_id, status, observacao }] }
  - Upsert em lote das chamadas; separa deleções (status === null) e inserções/updates; registra auditoria.

- POST /api/presenca/finalizar
  - Auth: Bearer token + x-institution-id
  - Body: { data, turno? }
  - Marca automaticamente como `ausente` alunos esperados que não possuem registro na data; verifica dias_sem_aula.

---

## /api/relatorios (arquivo: [relatorios.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/relatorios.js))
- GET /api/relatorios/estatisticas-diarias?data=YYYY-MM-DD
  - Auth: Bearer token + x-institution-id
  - Retorna métricas do dia: totais, por turno, por transporte, justificativas, lista de presenças, frequência %.

- GET /api/relatorios/estatisticas-periodo?data_inicio=&data_fim=
  - Auth: Bearer token + x-institution-id
  - Gera estatísticas agregadas em um período. Usa CTE recursiva para gerar dias letivos (exclui dias_sem_aula).

---

## /api/grade (arquivo: [grade.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/grade.js))
- GET /api/grade/
  - Auth: Bearer token + x-institution-id
  - Lista matrículas/grade ativas da instituição (joins com alunos, atividades, professores).

---

## /api/dias-sem-aula (arquivo: [dias-sem-aula.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/dias-sem-aula.js))
- GET /api/dias-sem-aula/?data_inicio=&data_fim=
  - Auth: Bearer token + x-institution-id
  - Lista dias sem aula (possui filtro de intervalo).

- GET /api/dias-sem-aula/verificar/:data
  - Auth: Bearer token + x-institution-id
  - Retorna { isDiaSemAula: true|false, motivo }

- POST /api/dias-sem-aula/
  - Auth: Bearer token + x-institution-id
  - Body: { data, motivo }
  - Cria dia sem aula (verifica duplicidade).

- PUT /api/dias-sem-aula/:id
  - Auth: Bearer token + x-institution-id
  - Atualiza dia sem aula (verifica pertença e duplicidade).

- DELETE /api/dias-sem-aula/:id
  - Auth: Bearer token + x-institution-id
  - Deleta dia sem aula.

- POST /api/dias-sem-aula/marcar-fins-de-semana
  - Auth: Bearer token + x-institution-id
  - Body: { ano? }
  - Marca em lote todos os fins de semana do ano (insere ON DUPLICATE KEY UPDATE).

- POST /api/dias-sem-aula/adicionar-feriados-nacionais
  - Auth: Bearer token + x-institution-id
  - Body: { ano? }
  - Insere feriados nacionais (fixos e móveis). Implementa cálculo de Páscoa e feriados móveis.

---

## /api/historico-aluno (arquivo: [historico-aluno.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/historico-aluno.js))
- Observação: este roteador tem várias rotas protegidas por `masterMiddleware` (somente perfil `master`).

- GET /api/historico-aluno/atividades/:instituicaoId
  - Auth: Bearer token (master)
  - Lista atividades de uma instituição.

- GET /api/historico-aluno/buscar?q=texto
  - Auth: Bearer token (master)
  - Busca alunos por nome em todas as instituições.

- GET /api/historico-aluno/:id
  - Auth: Bearer token (master)
  - Retorna aluno, histórico de matrículas, contatos de emergência e presenças.

- PUT /api/historico-aluno/:id
  - Auth: Bearer token (master)
  - Atualiza dados do aluno (master).

- Matrículas (master):
  - POST /api/historico-aluno/matricula — criar matrícula
  - PUT /api/historico-aluno/matricula/:id — atualizar matrícula
  - DELETE /api/historico-aluno/matricula/:id — encerrar (soft-delete) matrícula

- Contatos de emergência (master): CRUD em /api/historico-aluno/contato

---

## /api/contatos-emergencia (arquivo: [contatos-emergencia.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/contatos-emergencia.js))
- GET /api/contatos-emergencia/aluno/:alunoId
  - Auth: Bearer token + x-institution-id
  - Lista contatos do aluno (filtra por id_instituicao).

- POST /api/contatos-emergencia/
  - Auth: Bearer token + x-institution-id
  - Body: { id_aluno, nome, telefone, parentesco }
  - Cria contato e registra auditoria.

- PUT /api/contatos-emergencia/:id
  - Auth: Bearer token + x-institution-id
  - Atualiza contato (verifica pertencimento).

- DELETE /api/contatos-emergencia/:id
  - Auth: Bearer token + x-institution-id
  - Deleta contato (verifica pertencimento).

---

## Utilitários e infra
- DB pool: [db.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/db.js) — configurações de mysql2/promise, adaptações para Vercel (connectionLimit = 1).
- Validação: [validation.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/validation.js) — schemas Joi para `aluno` e `presenca`.
- Auditoria: [audit.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/audit.js) — logAuditEvent(evento, detalhes, id_instituicao).
- Arquivo principal/entrypoint: [_server.js](C:/Users/romar/OneDrive/Documentos/Sistemas/Controle/backend/_server.js)

---

Se desejar, posso:
- Gerar uma tabela CSV/JSON com as rotas e seus métodos para importação em ferramentas (Postman/OpenAPI).
- Gerar um arquivo OpenAPI/Swagger básico a partir desta lista.
- Incluir exemplos de requests/responses para os endpoints mais críticos.

Indique a próxima ação desejada.