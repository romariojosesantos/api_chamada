# API Endpoints — Controle de Presença

Resumo organizado das rotas expostas pelo backend (método, caminho, auth, parâmetros esperados e observações).

Obs:
- Muitos endpoints requerem o header `Authorization: Bearer <token>` (token HMAC implementado em [auth.routes.js](../src/modules/auth/auth.routes.js)).
- Quase todas as rotas relevantes exigem também o header `x-institution-id` (exceto rotas admin/master que podem operar cross-instituição). O middleware [tenant.js](../src/middlewares/tenant.js) valida e popula `req.id_instituicao`.

---

## /api/auth (arquivo: [auth.routes.js](../src/modules/auth/auth.routes.js))
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

## /api/alunos (arquivo: [alunos.routes.js](../src/modules/alunos/alunos.routes.js))
- GET /api/alunos/
  - Auth: Bearer token + x-institution-id
  - Query: nome, turno, transporte, status
  - Lista alunos da instituição com filtros; inclui dias matriculados via subquery.

- GET /api/alunos/por-dia
  - Auth: Bearer token + x-institution-id
  - Query: data=YYYY-MM-DD, ignoreFilters (true|false), professor
  - Retorna alunos esperados para a data (modo chamada) ou relatório (ignoreFilters=true). Verifica dias_sem_aula.

- GET /api/alunos/meritocracia
  - Auth: Bearer token + x-institution-id
  - Query: inicio, fim (datas)
  - Ranking de pontos por aluno no período: 1 ponto por dia de presença confirmada, descontado o % de ocorrências de comportamento (ver /api/ocorrencias). Substituiu /frequencia-plena.

- GET/POST/DELETE /api/ocorrencias
  - Auth: Bearer token + x-institution-id
  - Ocorrências de comportamento (leve -25%, grave -50%, gravíssima -100%) que descontam pontos na Meritocracia. Apagar é restrito a coordenador/master.

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

## /api/presenca (arquivo: [presenca.routes.js](../src/modules/presenca/presenca.routes.js))
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

## /api/relatorios (arquivo: [relatorios.routes.js](../src/modules/relatorios/relatorios.routes.js))
- GET /api/relatorios/estatisticas-diarias?data=YYYY-MM-DD
  - Auth: Bearer token + x-institution-id
  - Retorna métricas do dia: totais, por turno, por transporte, justificativas, lista de presenças, frequência %.

- GET /api/relatorios/estatisticas-periodo?data_inicio=&data_fim=
  - Auth: Bearer token + x-institution-id
  - Gera estatísticas agregadas em um período. Usa CTE recursiva para gerar dias letivos (exclui dias_sem_aula).

---

## /api/grade (arquivo: [grade.routes.js](../src/modules/matriculas/grade.routes.js))
- GET /api/grade/
  - Auth: Bearer token + x-institution-id
  - Lista matrículas/grade ativas da instituição (joins com alunos, atividades, professores).

---

## /api/dias-sem-aula (arquivo: [dias-sem-aula.routes.js](../src/modules/calendario/dias-sem-aula.routes.js))
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

## /api/historico-aluno (arquivo: [historico.routes.js](../src/modules/alunos/historico/historico.routes.js))
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

## /api/contatos-emergencia (arquivo: [contatos.routes.js](../src/modules/alunos/contatos/contatos.routes.js))
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
- DB pool: [database.js](../src/config/database.js) — configurações de mysql2/promise, adaptações para Vercel (connectionLimit = 1).
- Validação: [validate.js](../src/middlewares/validate.js) — middleware; schemas Joi em `alunos.schema.js` e `presenca.schema.js`.
- Auditoria: [audit.js](../src/utils/audit.js) — logAuditEvent(evento, detalhes, id_instituicao).
- Arquivo principal/entrypoint: [server.js](../server.js) (local) e [api/index.js](../api/index.js) (Vercel), que montam [src/app.js](../src/app.js)

---

Se desejar, posso:
- Gerar uma tabela CSV/JSON com as rotas e seus métodos para importação em ferramentas (Postman/OpenAPI).
- Gerar um arquivo OpenAPI/Swagger básico a partir desta lista.
- Incluir exemplos de requests/responses para os endpoints mais críticos.

Indique a próxima ação desejada.