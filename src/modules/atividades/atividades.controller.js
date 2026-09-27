const service = require('./atividades.service');

async function listar(req, res) {
  res.json(await service.listar(req.id_instituicao));
}

async function criar(req, res) {
  const turma = await service.criar(req.body, req.id_instituicao);
  res.status(201).json({
    id: turma.id,
    nome: turma.nome,
    dia_semana: turma.dia_semana,
    horario: turma.horario,
    turno: turma.turno,
    area: turma.area,
    idprofessor: turma.idprofessor,
    data_inicio: turma.data_inicio,
    data_fim: null,
  });
}

async function atualizar(req, res) {
  await service.atualizar(req.params.id, req.body, req.id_instituicao);
  res.json({ success: true });
}

async function adicionarCoProfessor(req, res) {
  res
    .status(201)
    .json(await service.adicionarCoProfessor(req.params.id, req.body, req.id_instituicao));
}

async function removerCoProfessor(req, res) {
  await service.removerCoProfessor(req.params.id, req.params.idprofessor, req.id_instituicao);
  res.json({ success: true });
}

async function encerrar(req, res) {
  const desmatriculados = await service.encerrar(req.params.id, req.id_instituicao);
  res.json({ success: true, alunos_desmatriculados: desmatriculados });
}

async function reabrir(req, res) {
  await service.reabrir(req.params.id, req.id_instituicao);
  res.json({ success: true });
}

async function historicoDeAlunos(req, res) {
  res.json(await service.historicoDeAlunos(req.params.id, req.id_instituicao));
}

async function excluir(req, res) {
  await service.excluir(req.params.id, req.id_instituicao);
  res.json({ success: true });
}

module.exports = {
  listar,
  criar,
  atualizar,
  adicionarCoProfessor,
  removerCoProfessor,
  encerrar,
  reabrir,
  historicoDeAlunos,
  excluir,
};
