const alunosModel = require('../alunos/alunos.model');
const professoresModel = require('../professores/professores.model');

async function transportes(req, res) {
  res.json(await alunosModel.listarTransportes(req.id_instituicao));
}

async function professores(req, res) {
  res.json(await professoresModel.listarNomesAtivos(req.id_instituicao));
}

module.exports = { transportes, professores };
