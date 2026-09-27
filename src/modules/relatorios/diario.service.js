// Relatório de um único dia (dashboard diário).
const model = require('./diario.model');
const { percentual } = require('./sql-comum');

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// "MANHÃ", "manha", "Manhã" -> "Manhã"
function normalizarTurno(turno) {
  const texto = String(turno || '').toLowerCase();
  if (texto.includes('manh')) return 'Manhã';
  if (texto.includes('tard')) return 'Tarde';
  if (texto.includes('noit')) return 'Noite';
  return turno || 'Não Definido';
}

// Por transporte, com quebra por turno. Esperados vêm da matrícula (é uma
// expectativa); presentes vêm da presença real, igual ao resto da tela.
function agruparPorTransporte(esperadosPorTransporte, presencaReal) {
  const presentes = new Map();
  for (const r of presencaReal) {
    presentes.set(`${r.transporte}|${normalizarTurno(r.turno)}`, r.presentes_reais);
  }

  const porTransporte = {};
  for (const row of esperadosPorTransporte) {
    const turno = normalizarTurno(row.turno);
    const pres = presentes.get(`${row.transporte}|${turno}`) || 0;
    const grupo = (porTransporte[row.transporte] ??= { total: 0, pres: 0, turnos: {} });
    grupo.total += row.esperados;
    grupo.pres += pres;
    const doTurno = (grupo.turnos[turno] ??= { total: 0, pres: 0 });
    doTurno.total += row.esperados;
    doTurno.pres += pres;
  }
  return porTransporte;
}

function presentesReaisPorTurno(presencaReal) {
  const porTurno = new Map();
  for (const r of presencaReal)
    porTurno.set(r.turno, (porTurno.get(r.turno) || 0) + r.presentes_reais);
  return [...porTurno.entries()].map(([turno, presentes_reais]) => ({ turno, presentes_reais }));
}

async function estatisticasDoDia(data, inst) {
  const diaSemana = DIAS[new Date(`${data}T12:00:00`).getDay()];

  const semAula = await model.diaSemAula(data, inst);
  if (semAula) {
    return {
      data,
      dia_semana: diaSemana,
      is_dia_sem_aula: true,
      motivo: semAula.motivo,
      total_ativos_instituicao: 0,
      total_esperado: 0,
      total_presentes: 0,
      total_ausentes: 0,
      por_turno: [],
      por_transporte: {},
    };
  }

  const r = await model.consultasDoDia(data, diaSemana, inst);

  // Esperado, presentes e ausentes na MESMA base (matrícula do dia), para
  // somarem entre si no gráfico. A presença real (sem exigir matrícula) vai
  // em campos à parte e é sempre maior ou igual.
  const totalEsperado = r.porTurno.reduce((s, t) => s + t.esperados, 0);
  const totalPresentes = r.porTurno.reduce((s, t) => s + t.presentes, 0);

  return {
    data,
    dia_semana: diaSemana,
    total_ativos_instituicao: r.totalAtivos,
    total_esperado: totalEsperado,
    total_presentes: totalPresentes,
    total_presentes_real: r.presencaReal.reduce((s, p) => s + p.presentes_reais, 0),
    total_ausentes: r.totalAusentes,
    total_justificados: r.totalJustificados || 0,
    total_ativos_sem_matricula: r.totalSemMatricula || 0,
    total_presencas_registradas: r.totalRegistradas,
    lista_presencas_registradas: r.listaRegistradas,
    presentes_reais_por_turno: presentesReaisPorTurno(r.presencaReal),
    frequencia_pct: percentual(totalPresentes, totalEsperado),
    por_turno: r.porTurno,
    por_transporte: agruparPorTransporte(r.porTransporte, r.presencaReal),
    justificativas: r.justificativas.map((j) => ({
      tipo: j.justificativa,
      quantidade: j.quantidade,
    })),
  };
}

module.exports = { estatisticasDoDia, agruparPorTransporte, normalizarTurno };
