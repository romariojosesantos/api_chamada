const { test } = require('node:test');
const assert = require('node:assert/strict');
const { intervalosDoMes, faltasConsecutivas, pivotarPorArea } = require('./periodo.service');
const { agruparPorTransporte, normalizarTurno } = require('./diario.service');

test('intervalosDoMes: mês corrente vai só até hoje', () => {
  const m = intervalosDoMes('2026-09', '2026-09-27');
  assert.equal(m.inicio, '2026-09-01');
  assert.equal(m.fim, '2026-09-27');
  assert.equal(m.futuro, false);
  assert.equal(m.anteriorInicio, '2026-08-01');
  assert.equal(m.anteriorFim, '2026-08-31');
});

test('intervalosDoMes: janeiro compara com dezembro do ano anterior; fevereiro bissexto', () => {
  const jan = intervalosDoMes('2026-01', '2026-09-27');
  assert.equal(jan.fim, '2026-01-31');
  assert.equal(jan.anteriorInicio, '2025-12-01');
  assert.equal(jan.anteriorFim, '2025-12-31');
  assert.equal(intervalosDoMes('2028-02', '2029-01-01').fim, '2028-02-29');
  assert.equal(intervalosDoMes('2026-12', '2026-09-27').futuro, true);
});

test('faltasConsecutivas conta do último dia para trás até o primeiro presente', () => {
  const linhas = [
    { aluno_id: 1, status: 'presente' },
    { aluno_id: 1, status: 'ausente' },
    { aluno_id: 1, status: null },
    { aluno_id: 2, status: 'ausente' },
    { aluno_id: 2, status: 'presente' },
    { aluno_id: 3, status: 'justificado' },
  ];
  const r = faltasConsecutivas(linhas);
  assert.equal(r.get(1), 2);
  assert.equal(r.get(2), 0);
  assert.equal(r.get(3), 1);
});

test('pivotarPorArea gera uma linha por data com a % de cada área', () => {
  const r = pivotarPorArea([
    { data: '2026-09-02', area: 'cultural', esperados: 4, presentes: 3 },
    { data: '2026-09-01', area: 'esportivo', esperados: 2, presentes: 0 },
    { data: '2026-09-02', area: 'esportivo', esperados: 0, presentes: 0 },
  ]);
  assert.deepEqual(r, [
    { data: '2026-09-01', esportivo: 0 },
    { data: '2026-09-02', cultural: 75, esportivo: 0 },
  ]);
});

test('agruparPorTransporte junta esperados da matrícula com a presença real', () => {
  assert.equal(normalizarTurno('MANHÃ'), 'Manhã');
  const r = agruparPorTransporte(
    [
      { transporte: 'Rota 1', turno: 'MANHÃ', esperados: 5 },
      { transporte: 'Rota 1', turno: 'Tarde', esperados: 3 },
      { transporte: 'Rota 2', turno: 'Tarde', esperados: 1 },
    ],
    [{ transporte: 'Rota 1', turno: 'Manhã', presentes_reais: 4 }],
  );
  assert.deepEqual(r['Rota 1'].turnos['Manhã'], { total: 5, pres: 4 });
  assert.deepEqual(r['Rota 1'].turnos.Tarde, { total: 3, pres: 0 });
  assert.deepEqual([r['Rota 1'].total, r['Rota 1'].pres], [8, 4]);
  assert.equal(r['Rota 2'].pres, 0);
});
