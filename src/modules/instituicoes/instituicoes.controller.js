const service = require('./instituicoes.service');

async function listarTodas(req, res) {
  res.json(await service.listarParaUsuario(req.user));
}

async function detalhe(req, res) {
  res.json(await service.buscarPorId(req.id_instituicao));
}

module.exports = { listarTodas, detalhe };
