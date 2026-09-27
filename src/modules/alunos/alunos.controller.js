const model = require('./alunos.model');
const chamadaModel = require('./chamada.model');
const service = require('./alunos.service');
const meritocracia = require('./meritocracia.service');
const importacao = require('./importacao/importacao.service');
const { diaDaSemana } = require('./normalizacao');

async function listar(req, res) {
  res.json(await model.listar(req.query, req.id_instituicao));
}

// Telefones sob demanda, só para os alunos visíveis na exportação do Ajuste de Grade.
async function telefones(req, res) {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return res.json([]);
  res.json(await model.telefones(ids, req.id_instituicao));
}

// Base da tela de Chamada. `ignoreFilters=true` (modo Relatório) traz todos os
// ativos matriculados, não só os do dia da semana.
async function porDia(req, res) {
  const { data, ignoreFilters, professor, turno } = req.query;
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });

  const diaSemAula = await chamadaModel.buscarDiaSemAula(data, req.id_instituicao);
  if (diaSemAula) {
    return res.json({
      isDiaSemAula: true,
      motivo: diaSemAula.motivo || 'Dia sem aula',
      alunos: [],
    });
  }

  const filtros = {
    data,
    diaSemana: diaDaSemana(data),
    professor,
    turno,
    modoRelatorio: ignoreFilters === 'true',
  };
  try {
    res.json(await chamadaModel.listarPorDia(filtros, req.id_instituicao));
  } catch (error) {
    console.error('Erro na rota /por-dia:', error.message);
    res.status(500).json({ error: 'Erro interno ao buscar alunos por dia' });
  }
}

async function ranking(req, res) {
  const { inicio, fim } = req.query;
  if (!inicio || !fim) return res.status(400).json({ error: 'Datas início/fim obrigatórias.' });
  res.json(await meritocracia.calcular(req.id_instituicao, inicio, fim));
}

async function importar(req, res) {
  const resumo = await importacao.importarPlanilha(req.body, req.id_instituicao);
  res.json({ message: 'Processamento concluído', resumo });
}

async function criar(req, res) {
  const id = await service.criar(req.body, req.id_instituicao);
  res.status(201).json({ id, message: 'Aluno criado com sucesso!' });
}

async function atualizar(req, res) {
  const encerramentos = await service.atualizarCompleto(
    req.params.id,
    req.body,
    req.user.id,
    req.id_instituicao,
  );
  res.json({ message: 'Aluno atualizado com sucesso!', ...encerramentos });
}

async function atualizarCampo(req, res) {
  const { campo, valor } = req.body;
  const encerramentos = await service.atualizarCampo(
    req.params.id,
    campo,
    valor,
    req.id_instituicao,
  );
  res.json({ message: 'Campo atualizado com sucesso.', ...encerramentos });
}

async function excluir(req, res) {
  await service.moverParaLixeira(req.params.id, req.user.id, req.id_instituicao);
  res.json({ message: 'Aluno excluído com sucesso!' });
}

async function excluirDefinitivamente(req, res) {
  await service.excluirDefinitivamente(req.params.id, req.user.id, req.id_instituicao);
  res.json({ message: 'Aluno excluído permanentemente.' });
}

async function listarExcluidos(req, res) {
  res.json(await model.listarExcluidos(req.id_instituicao));
}

async function restaurar(req, res) {
  await service.restaurar(req.params.id, req.user.id, req.id_instituicao);
  res.json({ message: 'Aluno restaurado com sucesso!' });
}

async function gerarCodigo(req, res) {
  const codigo = await service.gerarCodigoAcesso(req.params.id, req.user.id, req.id_instituicao);
  res.json({ codigo_acesso: codigo });
}

async function enviarFoto(req, res) {
  const url = await service.atualizarFoto(
    req.params.id,
    req.body.imagem_base64,
    req.id_instituicao,
  );
  res.json({ foto_url: url });
}

async function removerFoto(req, res) {
  await service.removerFotoDoAluno(req.params.id, req.id_instituicao);
  res.json({ success: true });
}

async function detalhe(req, res) {
  const aluno = await model.buscarPorId(req.params.id, req.id_instituicao);
  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado.' });
  res.json(aluno);
}

async function niveis(req, res) {
  res.json(await model.historicoNiveis(req.params.id, req.id_instituicao));
}

async function situacaoAnual(req, res) {
  res.json(await model.situacaoAnual(req.params.id, req.id_instituicao));
}

async function saude(req, res) {
  res.json(await model.observacoesSaude(req.params.id, req.id_instituicao));
}

async function removerSaude(req, res) {
  await service.removerObservacaoSaude(req.params.alunoId, req.params.saudeId, req.id_instituicao);
  res.json({ message: 'Observação removida com sucesso.' });
}

async function responsavel(req, res) {
  res.json(await model.responsavel(req.params.id, req.id_instituicao));
}

async function salvarResponsavel(req, res) {
  await service.salvarResponsavel(req.params.id, req.body, req.id_instituicao);
  res.json({ message: 'Responsável legal salvo com sucesso.' });
}

module.exports = {
  listar,
  telefones,
  porDia,
  ranking,
  importar,
  criar,
  atualizar,
  atualizarCampo,
  excluir,
  excluirDefinitivamente,
  listarExcluidos,
  restaurar,
  gerarCodigo,
  enviarFoto,
  removerFoto,
  detalhe,
  niveis,
  situacaoAnual,
  saude,
  removerSaude,
  responsavel,
  salvarResponsavel,
};
