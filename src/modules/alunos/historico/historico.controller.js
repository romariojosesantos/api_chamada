const service = require('./historico.service');

async function buscar(req, res) {
  res.json(await service.buscar(req.query.q, req.query.id_instituicao));
}

async function ficha(req, res) {
  res.json(await service.ficha(req.params.id));
}

async function atualizarAluno(req, res) {
  await service.atualizarAluno(req.params.id, req.body);
  res.json({ message: 'Dados do aluno atualizados com sucesso.' });
}

async function atualizarMatricula(req, res) {
  await service.atualizarMatricula(req.params.id, req.body);
  res.json({ message: 'Matrícula atualizada com sucesso.' });
}

async function criarMatricula(req, res) {
  const id = await service.criarMatricula(req.body);
  res.status(201).json({ id, message: 'Matrícula criada com sucesso.' });
}

async function excluirMatricula(req, res) {
  const permanente = await service.excluirMatricula(req.params.id);
  res.json({
    message: permanente
      ? 'Matrícula excluída permanentemente.'
      : 'Matrícula encerrada com sucesso.',
    permanente,
  });
}

async function reabrirMatricula(req, res) {
  await service.reabrirMatricula(req.params.id);
  res.json({ message: 'Matrícula reaberta com sucesso.' });
}

async function atualizarContato(req, res) {
  await service.atualizarContato(req.params.id, req.body);
  res.json({ message: 'Contato atualizado com sucesso.' });
}

async function criarContato(req, res) {
  const id = await service.criarContato(req.body);
  res.status(201).json({ id, message: 'Contato criado com sucesso.' });
}

async function excluirContato(req, res) {
  await service.excluirContato(req.params.id);
  res.json({ message: 'Contato removido com sucesso.' });
}

module.exports = {
  buscar,
  ficha,
  atualizarAluno,
  atualizarMatricula,
  criarMatricula,
  excluirMatricula,
  reabrirMatricula,
  atualizarContato,
  criarContato,
  excluirContato,
};
