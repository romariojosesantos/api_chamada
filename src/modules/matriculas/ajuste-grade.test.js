const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planejar, resolverDuplicadas } = require('./ajuste-grade');

test('resolverDuplicadas mantém a matrícula mais recente de cada posição', () => {
  const { idPorPosicao, duplicadas } = resolverDuplicadas([
    { idmatricula: 10, idaluno: 1, dia_semana: 'Segunda', horario: 'HR 1' },
    { idmatricula: 12, idaluno: 1, dia_semana: 'Segunda', horario: 'HR 1' },
    { idmatricula: 20, idaluno: 1, dia_semana: 'Terça', horario: 'HR 1' },
  ]);
  assert.equal(idPorPosicao.get('1-Segunda-HR 1'), 12);
  assert.deepEqual(duplicadas, [10]);
});

test('planejar troca, cria, encerra e barra conflito de turno', () => {
  const contexto = {
    idPorPosicao: new Map([
      ['1-Segunda-HR 1', 100],
      ['1-Terça-HR 1', 101],
    ]),
    existentePorId: new Map([
      [100, { idatividades: 7 }],
      [101, { idatividades: 7 }],
    ]),
    alunoPorId: new Map([[1, { id: 1, nome: 'Ana', turno: 'Tarde' }]]),
    turmaPorId: new Map([
      [7, { nome: 'Cello', turno: 'Tarde', nome_professor: 'Rui' }],
      [8, { nome: 'Teoria', turno: 'Tarde', nome_professor: null }],
      [9, { nome: 'Sax', turno: 'Manhã', nome_professor: null }],
    ]),
  };
  const plano = planejar(
    [
      { aluno_id: 1, dia_semana: 'Segunda', horario: 'HR 1', id_atividade: 8 }, // troca
      { aluno_id: 1, dia_semana: 'Quarta', horario: 'HR 1', id_atividade: 8 }, // cria
      { aluno_id: 1, dia_semana: 'Terça', horario: 'HR 1', id_atividade: null }, // encerra
      { aluno_id: 1, dia_semana: 'Sexta', horario: 'HR 1', id_atividade: 9 }, // conflito
    ],
    contexto,
  );

  assert.deepEqual(plano.atualizar, [{ id: 100, id_atividade: 8, turno: 'Tarde' }]);
  assert.equal(plano.inserir.length, 1);
  assert.deepEqual(plano.encerrar, [101]);
  assert.equal(plano.conflitosTurno.length, 1);
  assert.deepEqual(plano.detalhes[0].de, {
    turma: 'Cello',
    professor: 'Rui',
    dia_semana: 'Segunda',
    horario: 'HR 1',
    turno: 'Tarde',
  });
});
