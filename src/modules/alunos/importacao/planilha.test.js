const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('./planilha');
const { montarMatriculas, separarConflitosDeTurno } = require('./matriculas');

test('lerCorpo aceita lista, { alunos, atividades } e aluno único', () => {
  assert.deepEqual(p.lerCorpo([{ nome: 'A' }]), { alunos: [{ nome: 'A' }], atividades: [] });
  assert.deepEqual(p.lerCorpo({ alunos: [{ nome: 'A' }], atividades: [{ nome: 'T' }] }), {
    alunos: [{ nome: 'A' }],
    atividades: [{ nome: 'T' }],
  });
  assert.deepEqual(p.lerCorpo({ nome: 'A' }).alunos, [{ nome: 'A' }]);
  assert.throws(() => p.lerCorpo([]), { status: 400 });
});

test('lerMatriculas encontra as colunas de dia + horário', () => {
  const linha = {
    nome: 'A',
    'SEG HR 1': 'CUL - Cello 1 A',
    'Terca-HR2': 'Teoria',
    qua_h_3: '',
    obs: 'x',
  };
  assert.deepEqual(p.lerMatriculas(linha), [
    { dia_semana: 'Segunda', horario: 'HR 1', nome_atividade: 'Cello 1' },
    { dia_semana: 'Terça', horario: 'HR 2', nome_atividade: 'Teoria' },
  ]);
});

test('lerNivel lê nível, nível.subnível e reconstrói o que o Excel virou data', () => {
  assert.deepEqual(p.lerNivel({ nivel: '3' }), { nivel: 3, subnivel: null });
  assert.deepEqual(p.lerNivel({ nivel: '3,2' }), { nivel: 3, subnivel: '2' });
  assert.deepEqual(p.lerNivel({ nivel: 2, subnivel: '1' }), { nivel: 2, subnivel: '1' });
  assert.deepEqual(p.lerNivel({ nivel: 46026 }), { nivel: 4, subnivel: '1' }); // "4.1" virou 04/01/2026
  assert.deepEqual(p.lerNivel({ nivel: 150 }), { foraDeFaixa: true });
  assert.equal(p.lerNivel({ nivel: '' }), null);
  assert.equal(p.lerNivel({ nivel: 'abc' }), null);
});

test('lerObservacoesSaude separa por ";" e ignora vazios', () => {
  assert.deepEqual(p.lerObservacoesSaude({ observacoes_saude: 'Asma; ; Rinite ' }), [
    'Asma',
    'Rinite',
  ]);
  assert.deepEqual(p.lerObservacoesSaude({}), []);
});

test('lerResponsavel devolve null quando nada foi preenchido', () => {
  assert.equal(p.lerResponsavel({}), null);
  assert.equal(p.lerResponsavel({ responsavel_email: 'a@b.c' }).email, 'a@b.c');
});

test('montarMatriculas aponta conflito de horário no mesmo upload', () => {
  const alunoPorNome = new Map([['Ana', { id: 1, turno: 'Manhã' }]]);
  const linhas = [
    { nome: 'Ana', 'seg hr 1': 'Cello 2' },
    { nome: 'Ana', 'seg hr 1': 'CIA' },
  ];
  const r = montarMatriculas(linhas, alunoPorNome, 3);
  assert.equal(r.matriculas.length, 1);
  assert.deepEqual(r.conflitosHorario, [
    { aluno: 'Ana', dia_semana: 'Segunda', horario: 'HR 1', turma_1: 'Cello 2', turma_2: 'CIA' },
  ]);
});

test('separarConflitosDeTurno barra turma só de outro turno, exceto na troca de turno', () => {
  const matriculas = [
    { idaluno: 1, nome_atividade: 'Cello 1', dia_semana: 'Terça', horario: 'HR 1', turno: 'Manhã' },
  ];
  const existentes = [{ nome: 'Cello 1', dia_semana: 'Terça', horario: 'HR 1', turno: 'Tarde' }];
  const nomes = new Map([[1, 'Ana']]);

  const semTroca = separarConflitosDeTurno(
    matriculas,
    existentes,
    nomes,
    new Map([['Ana', 'Manhã']]),
  );
  assert.equal(semTroca.validas.length, 0);
  assert.equal(semTroca.conflitos[0].turno_turma, 'Tarde');

  const trocando = separarConflitosDeTurno(
    matriculas,
    existentes,
    nomes,
    new Map([['Ana', 'Tarde']]),
  );
  assert.equal(trocando.validas.length, 1);
});
