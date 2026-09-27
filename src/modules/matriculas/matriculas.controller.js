const model = require('./matriculas.model');
const service = require('./matriculas.service');
const ajusteGrade = require('./ajuste-grade');

// Filtros opcionais: ?status=matriculado&dia_semana=Segunda&id_atividade=10
async function listar(req, res) {
  res.json(await model.listarAtivas(req.query, req.id_instituicao));
}

async function doAluno(req, res) {
  res.json(await model.listarAtivasDoAluno(req.params.id, req.id_instituicao));
}

async function historico(req, res) {
  const { data_inicio, data_fim } = req.query;
  if (!data_inicio || !data_fim) {
    return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórias' });
  }
  res.json(await model.historico(req.id_instituicao));
}

async function salvarAjusteGrade(req, res) {
  res.json(await ajusteGrade.salvar(req.body.alteracoes, req.id_instituicao));
}

async function duplicidades(req, res) {
  res.json(await service.listarDuplicidades(req.id_instituicao));
}

async function resolverDuplicidade(req, res) {
  const encerradas = await service.resolverDuplicidade(
    parseInt(req.body.manter),
    req.id_instituicao,
  );
  res.json({ success: true, encerradas });
}

async function matricular(req, res) {
  await service.matricular(req.body.aluno_id, req.body.id_atividade, req.id_instituicao);
  res.status(201).json({ success: true });
}

async function mover(req, res) {
  const { matricula_id, id_atividade_destino } = req.body;
  await service.mover(matricula_id, id_atividade_destino, req.id_instituicao);
  res.json({ success: true });
}

async function cancelar(req, res) {
  await service.cancelar(req.params.id, req.id_instituicao);
  res.json({ success: true });
}

module.exports = {
  listar,
  doAluno,
  historico,
  salvarAjusteGrade,
  duplicidades,
  resolverDuplicidade,
  matricular,
  mover,
  cancelar,
};
