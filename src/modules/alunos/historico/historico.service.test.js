const banco = require('../../../utils/banco-falso');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const service = require('./historico.service');

test('excluirContato audita com a instituição lida antes de apagar', async () => {
  banco.responder([['SELECT id_instituicao FROM contatos_emergencia', [{ id_instituicao: 5 }]]]);
  await service.excluirContato('1');

  const [leitura, exclusao, auditoria] = banco.queries;
  assert.match(leitura, /^SELECT id_instituicao FROM contatos_emergencia/);
  assert.match(exclusao, /^DELETE FROM contatos_emergencia/);
  assert.match(auditoria, /^INSERT INTO chamada_conexao/);
});

test('atualizarMatricula de turma apagada responde 404, sem gravar', async () => {
  banco.responder([
    [
      'SELECT idmatricula, data_fim, idatividades',
      [{ idmatricula: 8, data_fim: null, idatividades: 10 }],
    ],
  ]);
  await assert.rejects(service.atualizarMatricula('8', {}), {
    status: 404,
    message: 'A turma dessa matrícula não existe mais.',
  });
  assert.ok(!banco.queries.some((q) => q.startsWith('UPDATE')));
});
