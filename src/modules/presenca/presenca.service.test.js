const banco = require('../../utils/banco-falso');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const service = require('./presenca.service');
const { hojeBrasil } = require('../../utils/data-brasil');

// Dia seguinte a hoje (Brasília), "YYYY-MM-DD".
function amanha() {
  const d = new Date(`${hojeBrasil()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const dataFutura = { status: 400, extra: { isDataFutura: true } };
const gravouPresenca = () => banco.queries.some((q) => q.includes('INTO presenca'));
const chamada = (data) => ({
  data,
  periodo: 'manha',
  chamadas: [{ aluno_id: 1, status: 'presente' }],
});

test('salvarChamada recusa data futura sem tocar no banco', async () => {
  banco.responder([]);
  await assert.rejects(service.salvarChamada(chamada(amanha()), 3), dataFutura);
  assert.equal(banco.queries.length, 0);
});

test('salvarChamada aceita a data de hoje', async () => {
  banco.responder([]);
  await service.salvarChamada(chamada(hojeBrasil()), 3);
  assert.ok(gravouPresenca());
});

test('salvarChamada aceita dia que já passou', async () => {
  banco.responder([]);
  await service.salvarChamada(chamada('2026-01-05'), 3);
  assert.ok(gravouPresenca());
});

test('registrarAdicaoManual recusa data futura', async () => {
  banco.responder([]);
  await assert.rejects(
    service.registrarAdicaoManual({ alunoId: 1, data: amanha(), turno: 'Manhã' }, 3),
    dataFutura,
  );
  assert.equal(banco.queries.length, 0);
});

test('finalizar e finalizarDia recusam data futura sem lançar faltas', async () => {
  banco.responder([]);
  await assert.rejects(service.finalizar({ data: amanha(), turno: 'Manhã' }, 3), dataFutura);
  await assert.rejects(service.finalizarDia(amanha(), 3), dataFutura);
  assert.ok(!gravouPresenca());
});
