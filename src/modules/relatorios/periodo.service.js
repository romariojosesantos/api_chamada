// Estatísticas de um intervalo de datas, da visão mensal e frequência por aluno.
// Duas unidades convivem na resposta:
//   "..._alunos", total_justificados, total_nao_justificados -> ALUNOS únicos;
//   "..._registros" -> registros de presença (um por aluno por dia).
const model = require('./periodo.model');
const { dataTexto, percentual } = require('./sql-comum');
const { hojeBrasil } = require('../../utils/data-brasil');

const PERIODO_VAZIO = {
  total_esperados_alunos: 0,
  total_presentes_alunos: 0,
  total_ausentes_alunos: 0,
  total_justificados: 0,
  total_nao_justificados: 0,
  total_esperados_registros: 0,
  total_presentes_registros: 0,
  total_faltas_registros: 0,
  total_justificativas_registros: 0,
  justificativas: [],
  total_dias_letivos: 0,
  media_alunos_dia: 0,
  tendencia_diaria: [],
  tendencia_por_area: [],
};

// Uma linha por (data, área) -> uma linha por data, com a % de cada área.
function pivotarPorArea(linhas) {
  const porData = new Map();
  for (const row of linhas) {
    const data = dataTexto(row.data);
    if (!porData.has(data)) porData.set(data, { data });
    porData.get(data)[row.area] = percentual(row.presentes, row.esperados);
  }
  return [...porData.values()].sort((a, b) => a.data.localeCompare(b.data));
}

async function calcularFrequenciaPorAluno(inst, inicio, fim) {
  const linhas = await model.frequenciaPorAluno(inst, inicio, fim);
  return linhas.map((row) => ({
    aluno_id: row.aluno_id,
    nome: row.nome,
    dias_esperados: row.dias_esperados,
    dias_presentes: row.dias_presentes,
    frequencia_pct: percentual(row.dias_presentes, row.dias_esperados),
  }));
}

// `incluirTendencia` monta também as séries dia a dia (duas queries a mais):
// só vale para quem desenha o gráfico, não para o "mês anterior" da comparação.
async function calcularEstatisticasPeriodo(inst, data_inicio, data_fim, incluirTendencia = false) {
  const diasLetivos = await model.diasLetivos(inst, data_inicio, data_fim);
  if (diasLetivos.length === 0) return { data_inicio, data_fim, ...PERIODO_VAZIO };

  const [
    [presentesAlunos],
    [presentesRegistros],
    [esperadosAlunos],
    [esperadosRegistros],
    justificativas,
    [justificadosAlunos],
  ] = (
    await Promise.all([
      model.presentesAlunos(inst, data_inicio, data_fim),
      model.presentesRegistros(inst, data_inicio, data_fim),
      model.esperadosAlunos(inst, data_inicio, data_fim),
      model.esperadosRegistros(inst, data_inicio, data_fim),
      model.justificativasPorTipo(inst, data_inicio, data_fim),
      model.justificadosAlunos(inst, data_inicio, data_fim),
    ])
  ).map(([rows]) => rows);

  const totalPresentesAlunos = presentesAlunos.total || 0;
  const totalPresentesRegistros = presentesRegistros.total || 0;
  const totalEsperadosAlunos = esperadosAlunos.total || 0;
  const totalAusentesAlunos = Math.max(0, totalEsperadosAlunos - totalPresentesAlunos);
  const totalEsperadosRegistros = parseInt(esperadosRegistros.total || 0, 10);
  const totalJustificados = justificadosAlunos.total || 0;

  let tendenciaDiaria = [];
  let tendenciaPorArea = [];
  if (incluirTendencia) {
    tendenciaDiaria = (await model.tendenciaDiaria(inst, data_inicio, data_fim)).map((row) => ({
      data: dataTexto(row.data),
      esperados: row.esperados,
      presentes: row.presentes,
      frequencia_pct: percentual(row.presentes, row.esperados),
    }));
    tendenciaPorArea = pivotarPorArea(await model.tendenciaPorArea(inst, data_inicio, data_fim));
  }

  return {
    data_inicio,
    data_fim,
    total_esperados_alunos: totalEsperadosAlunos,
    total_presentes_alunos: totalPresentesAlunos,
    total_ausentes_alunos: totalAusentesAlunos,
    total_justificados: totalJustificados,
    // mesma unidade (alunos) dos dois lados
    total_nao_justificados: Math.max(0, totalAusentesAlunos - totalJustificados),
    total_esperados_registros: totalEsperadosRegistros,
    total_presentes_registros: totalPresentesRegistros,
    total_faltas_registros: Math.max(0, totalEsperadosRegistros - totalPresentesRegistros),
    total_justificativas_registros: justificativas
      .filter((j) => j.justificativa !== 'Sem justificativa')
      .reduce((soma, j) => soma + j.quantidade, 0),
    justificativas: justificativas.map((j) => ({
      tipo: j.justificativa,
      quantidade: j.quantidade,
    })),
    total_dias_letivos: diasLetivos.length,
    media_alunos_dia: Math.round(totalEsperadosRegistros / diasLetivos.length),
    tendencia_diaria: tendenciaDiaria,
    tendencia_por_area: tendenciaPorArea,
  };
}

// Faltas seguidas mais recentes de cada aluno: do último dia letivo para trás
// até o primeiro "presente". Justificada também conta: o sinal é de evasão.
// `linhas` vem ordenado por aluno e data.
function faltasConsecutivas(linhas) {
  const statusPorAluno = new Map();
  for (const row of linhas) {
    if (!statusPorAluno.has(row.aluno_id)) statusPorAluno.set(row.aluno_id, []);
    statusPorAluno.get(row.aluno_id).push(row.status);
  }
  const resultado = new Map();
  for (const [aluno, status] of statusPorAluno) {
    let seguidas = 0;
    for (let i = status.length - 1; i >= 0 && status[i] !== 'presente'; i--) seguidas++;
    resultado.set(aluno, seguidas);
  }
  return resultado;
}

const doisDigitos = (n) => String(n).padStart(2, '0');

// "2026-09" -> intervalo do mês (até hoje, se for o mês corrente) e o mês anterior completo.
function intervalosDoMes(mes, hoje) {
  const [ano, mesNum] = mes.split('-').map(Number);
  const inicio = `${mes}-01`;
  const fimCalendario = `${mes}-${doisDigitos(new Date(ano, mesNum, 0).getDate())}`;

  const anterior = new Date(ano, mesNum - 2, 1);
  const anoAnterior = anterior.getFullYear();
  const mesAnterior = doisDigitos(anterior.getMonth() + 1);
  const ultimoDiaAnterior = new Date(anoAnterior, anterior.getMonth() + 1, 0).getDate();

  return {
    inicio,
    fim: fimCalendario > hoje ? hoje : fimCalendario,
    futuro: inicio > hoje,
    anteriorInicio: `${anoAnterior}-${mesAnterior}-01`,
    anteriorFim: `${anoAnterior}-${mesAnterior}-${doisDigitos(ultimoDiaAnterior)}`,
  };
}

async function calcularMensal(inst, mes) {
  const m = intervalosDoMes(mes, hojeBrasil());

  if (m.futuro) {
    return {
      mes,
      data_inicio: m.inicio,
      data_fim: m.inicio,
      ...PERIODO_VAZIO,
      frequencia_por_aluno: [],
      media_frequencia_individual: 0,
      total_alunos_com_falta: 0,
    };
  }

  const [periodo, periodoAnterior, frequencias, totalComFalta, diaADia] = await Promise.all([
    calcularEstatisticasPeriodo(inst, m.inicio, m.fim, true),
    calcularEstatisticasPeriodo(inst, m.anteriorInicio, m.anteriorFim),
    calcularFrequenciaPorAluno(inst, m.inicio, m.fim),
    model.alunosComFalta(inst, m.inicio, m.fim),
    model.presencaDiaADia(inst, m.inicio, m.fim),
  ]);

  const seguidas = faltasConsecutivas(diaADia);
  const frequenciaPorAluno = frequencias.map((f) => ({
    aluno_id: f.aluno_id,
    nome: f.nome,
    dias_esperados: f.dias_esperados,
    dias_presentes: f.dias_presentes,
    dias_falta: Math.max(0, f.dias_esperados - f.dias_presentes),
    frequencia_pct: f.frequencia_pct,
    faltas_consecutivas: seguidas.get(f.aluno_id) || 0,
  }));

  // Média das % individuais (cada aluno pesa igual), diferente da % agregada do topo.
  const mediaIndividual =
    frequenciaPorAluno.length > 0
      ? Math.round(
          frequenciaPorAluno.reduce((soma, a) => soma + a.frequencia_pct, 0) /
            frequenciaPorAluno.length,
        )
      : 0;

  return {
    mes,
    ...periodo,
    frequencia_por_aluno: frequenciaPorAluno,
    media_frequencia_individual: mediaIndividual,
    total_alunos_com_falta: totalComFalta,
    mes_anterior: {
      data_inicio: m.anteriorInicio,
      data_fim: m.anteriorFim,
      total_esperados_registros: periodoAnterior.total_esperados_registros,
      total_presentes_registros: periodoAnterior.total_presentes_registros,
      total_faltas_registros: periodoAnterior.total_faltas_registros,
      total_justificativas_registros: periodoAnterior.total_justificativas_registros,
      frequencia_pct: percentual(
        periodoAnterior.total_presentes_registros,
        periodoAnterior.total_esperados_registros,
      ),
    },
  };
}

module.exports = {
  calcularFrequenciaPorAluno,
  calcularEstatisticasPeriodo,
  calcularMensal,
  faltasConsecutivas,
  intervalosDoMes,
  pivotarPorArea,
};
