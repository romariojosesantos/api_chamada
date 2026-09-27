const geral = require('./geral.model');
const diario = require('./diario.service');
const periodo = require('./periodo.service');

async function estatisticasDiarias(req, res) {
  if (!req.query.data) return res.status(400).json({ error: 'Data é obrigatória.' });
  res.json(await diario.estatisticasDoDia(req.query.data, req.id_instituicao));
}

async function ativosSemMatricula(req, res) {
  res.json(await geral.ativosSemMatricula(req.id_instituicao));
}

async function matriculasPorArea(req, res) {
  res.json(await geral.matriculasPorArea(req.id_instituicao, req.query.data));
}

async function alunosPorStatus(req, res) {
  res.json(await geral.alunosPorStatus(req.id_instituicao));
}

async function estatisticasPeriodo(req, res) {
  const { data_inicio, data_fim } = req.query;
  if (!data_inicio || !data_fim) {
    return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórios' });
  }
  res.json(
    await periodo.calcularEstatisticasPeriodo(req.id_instituicao, data_inicio, data_fim, true),
  );
}

async function estatisticasMensais(req, res) {
  const { mes } = req.query;
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
    return res.status(400).json({ error: 'Parâmetro "mes" é obrigatório, no formato YYYY-MM.' });
  }
  res.json(await periodo.calcularMensal(req.id_instituicao, mes));
}

// Frequência de todo o histórico = presenças / soma dos esperados de cada dia com chamada.
async function historicoGeral(req, res) {
  const inst = req.id_instituicao;
  const desde = await geral.dataMaisAntigaConfiavel(inst);
  if (!desde) {
    return res.json({
      total_presencas: 0,
      total_oportunidades: 0,
      dias_letivos: 0,
      media_frequencia: 0,
    });
  }

  const totalPresencas = (await geral.totalPresencasDesde(inst, desde)) || 0;
  const oportunidades = await geral.oportunidadesDesde(inst, desde);
  const totalOportunidades = oportunidades.total_oportunidades || 0;

  res.json({
    total_presencas: totalPresencas,
    total_oportunidades: totalOportunidades,
    dias_letivos: oportunidades.dias_letivos || 0,
    media_frequencia:
      totalOportunidades > 0 ? Math.round((totalPresencas / totalOportunidades) * 1000) / 10 : 0,
  });
}

module.exports = {
  estatisticasDiarias,
  ativosSemMatricula,
  matriculasPorArea,
  alunosPorStatus,
  estatisticasPeriodo,
  estatisticasMensais,
  historicoGeral,
};
