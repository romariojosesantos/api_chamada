const banco = require('./banco-falso');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { logAuditEvent } = require('./audit');
const { authMiddleware } = require('../middlewares/auth');
const { signToken } = require('../modules/auth/token');

const insercoes = () =>
  banco.queries
    .map((sql, i) => ({ sql, params: banco.parametros[i] }))
    .filter(({ sql }) => sql.startsWith('INSERT INTO chamada_conexao'));

// Simula uma requisição logada passando pelo authMiddleware.
function requisicaoDe(usuario, rota) {
  const req = { headers: { authorization: `Bearer ${signToken(usuario)}` } };
  return new Promise((resolve, reject) => {
    authMiddleware(req, {}, () => rota().then(resolve, reject));
  });
}

test('evento dentro de uma requisição logada grava o id do usuário', async () => {
  banco.responder([]);
  await requisicaoDe({ id: 42, perfil: 'monitor' }, async () => {
    await new Promise((r) => setTimeout(r, 5)); // atravessa um await, como nas rotas
    await logAuditEvent('SALVAR_CHAMADA_LOTE', 'Data: 2026-09-28', 1);
  });
  const [evento] = insercoes();
  assert.match(evento.sql, /id_usuario/);
  assert.deepEqual(evento.params, ['SALVAR_CHAMADA_LOTE', 'Data: 2026-09-28', 1, 42]);
});

test('evento fora de requisição (cron) grava usuário nulo', async () => {
  banco.responder([]);
  await logAuditEvent('LEMBRETE', 'x', 1);
  assert.equal(insercoes()[0].params[3], null);
});

test('requisições simultâneas não misturam os usuários', async () => {
  banco.responder([]);
  const esperarE = (ms, id) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    await logAuditEvent('E', String(id), 1);
  };
  await Promise.all([
    requisicaoDe({ id: 1 }, esperarE(15, 1)),
    requisicaoDe({ id: 2 }, esperarE(5, 2)),
  ]);
  for (const { params } of insercoes()) assert.equal(String(params[3]), params[1]);
});

test('banco sem a coluna id_usuario: grava o evento sem ela', async () => {
  const semColuna = Object.assign(new Error("Unknown column 'id_usuario'"), {
    code: 'ER_BAD_FIELD_ERROR',
  });
  banco.responder([['id_usuario', semColuna]]);
  await logAuditEvent('E', 'x', 1);
  const [comUsuario, semUsuario] = insercoes();
  assert.match(comUsuario.sql, /id_usuario/);
  assert.doesNotMatch(semUsuario.sql, /id_usuario/);
  assert.deepEqual(semUsuario.params, ['E', 'x', 1]);
});
