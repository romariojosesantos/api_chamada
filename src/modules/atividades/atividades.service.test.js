const banco = require('../../utils/banco-falso');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const service = require('./atividades.service');

const turma = ['FROM atividades WHERE idatividades = ?', [{ idatividades: 10, idprofessor: 7 }]];

test('adicionarCoProfessor com professor inexistente responde 404 sem gravar o vínculo', async () => {
  banco.responder([turma]);
  await assert.rejects(service.adicionarCoProfessor('10', { idprofessor: 3 }, 5), {
    status: 404,
    message: 'Professor não encontrado.',
  });
  assert.ok(!banco.queries.some((q) => q.startsWith('INSERT INTO atividade_professores')));
});

test('adicionarCoProfessor só aceita professor da mesma instituição', async () => {
  banco.responder([turma, ['FROM professores WHERE id = ?', [{ id: 3, nome: 'Bia' }]]]);
  const professor = await service.adicionarCoProfessor('10', { idprofessor: 3 }, 5);

  assert.deepEqual(professor, { id: 3, nome: 'Bia' });
  const busca = banco.queries.find((q) => q.includes('FROM professores WHERE id = ?'));
  assert.match(busca, /AND id_instituicao = \?/);
  assert.ok(banco.queries.some((q) => q.startsWith('INSERT INTO atividade_professores')));
});
