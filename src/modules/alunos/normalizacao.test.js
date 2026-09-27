const { test } = require('node:test');
const assert = require('node:assert/strict');
const n = require('./normalizacao');

test('validarTurno mantém os turnos conhecidos e capitaliza o resto', () => {
  assert.equal(n.validarTurno(' Manhã '), 'Manhã');
  assert.equal(n.validarTurno('tarde'), 'tarde');
  assert.equal(n.validarTurno('MANHÃ'), 'Manhã');
  assert.equal(n.validarTurno(''), null);
  assert.equal(n.validarTurno(null), null);
});

test('parseDataNascimento entende dd/mm/aaaa, ISO e serial do Excel', () => {
  assert.equal(n.parseDataNascimento('15/03/2012'), '2012-03-15');
  assert.equal(n.parseDataNascimento('5-3-2012'), '2012-03-05');
  assert.equal(n.parseDataNascimento('2012-03-15'), '2012-03-15');
  assert.equal(n.parseDataNascimento(44000), '2020-06-18');
});

test('parseDataNascimento rejeita datas inexistentes e seriais implausíveis', () => {
  assert.equal(n.parseDataNascimento('29/02/2022'), null);
  assert.equal(n.parseDataNascimento('31/04/2020'), null);
  assert.equal(n.parseDataNascimento(2), null); // viraria 1900
  assert.equal(n.parseDataNascimento('texto'), null);
  assert.equal(n.parseDataNascimento(''), null);
});

test('truncar corta no tamanho e trata vazio como null', () => {
  assert.equal(n.truncar('abcdef', 3), 'abc');
  assert.equal(n.truncar(12345, 2), '12');
  assert.equal(n.truncar('', 3), null);
  assert.equal(n.truncar(undefined, 3), null);
});

test('parseInteiro descarta a parte decimal', () => {
  assert.equal(n.parseInteiro('3,5'), 3);
  assert.equal(n.parseInteiro(' 7 '), 7);
  assert.equal(n.parseInteiro('x'), null);
  assert.equal(n.parseInteiro(''), null);
});

test('normalizarNomeAtividade remove o prefixo CUL e a letra final', () => {
  assert.equal(n.normalizarNomeAtividade('CUL - Cello 1 A'), 'Cello 1');
  assert.equal(n.normalizarNomeAtividade('cul-Violino 2 - B'), 'Violino 2');
  assert.equal(n.normalizarNomeAtividade('CUL - Teclado 1 R'), 'Teclado 1 (R)');
  assert.equal(n.normalizarNomeAtividade('ESP - N1 A'), 'ESP - N1 A'); // sem CUL não mexe
});

test('normalizarArea ignora acento e maiúscula', () => {
  assert.equal(n.normalizarArea('Tecnológico'), 'tecnologico');
  assert.equal(n.normalizarArea('CULTURAL'), 'cultural');
  assert.equal(n.normalizarArea('Culinária'), null);
});

test('detectarAreaPorNome usa o prefixo e marca o padrão como palpite', () => {
  assert.deepEqual(n.detectarAreaPorNome('ESP - N3'), { area: 'esportivo', confiavel: true });
  assert.deepEqual(n.detectarAreaPorNome('E.P. - N2'), { area: 'educacional', confiavel: true });
  assert.deepEqual(n.detectarAreaPorNome('Espanhol'), { area: 'cultural', confiavel: false });
});

test('periodoDoTurno e diaDaSemana', () => {
  assert.equal(n.periodoDoTurno('Manhã'), 'manha');
  assert.equal(n.periodoDoTurno('NOITE'), 'noite');
  assert.equal(n.periodoDoTurno('xyz'), null);
  assert.equal(n.diaDaSemana('2026-09-24'), 'Quinta');
});
