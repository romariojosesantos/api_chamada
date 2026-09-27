const service = require('./pontos.service');
const { gerarRelatorioPontoPDF } = require('./relatorio-ponto.pdf');

const texto = (valor) => String(valor || '').trim();
const periodo = (query) => ({
  dataInicio: texto(query.data_inicio),
  dataFim: texto(query.data_fim),
});

// --- Educador ---

async function turmasDeHoje(req, res) {
  res.json(await service.painelDoDia(req.user, req.id_instituicao));
}

async function meuHistorico(req, res) {
  res.json(await service.meuHistorico(req.user, periodo(req.query), req.id_instituicao));
}

async function baterEntrada(req, res) {
  const { criado, id } = await service.baterEntradaTurma(
    req.user,
    req.body.id_atividade,
    req.id_instituicao,
  );
  res.status(criado ? 201 : 200).json({ message: 'Entrada registrada.', id });
}

async function registrarSaida(req, res) {
  const id = await service.registrarSaidaTurma(req.user, req.body.id_atividade, req.id_instituicao);
  res.json({ message: 'Saída registrada.', id });
}

async function baterEntradaInterna(req, res) {
  const id = await service.baterEntradaInterna(
    req.user,
    req.body.id_tipo_interno,
    req.id_instituicao,
  );
  res.status(201).json({ message: 'Entrada registrada.', id });
}

async function registrarSaidaInterna(req, res) {
  const id = await service.registrarSaidaInterna(
    req.user,
    req.body.id_tipo_interno,
    req.id_instituicao,
  );
  res.json({ message: 'Saída registrada.', id });
}

// --- Coordenação ---

async function listar(req, res) {
  const filtros = { ...periodo(req.query), idProfessor: req.query.id_professor };
  res.json(await service.listar(req.user, filtros, req.id_instituicao));
}

async function educadores(req, res) {
  res.json(await service.educadores(req.user, req.id_instituicao));
}

async function relatorioPdf(req, res) {
  const filtros = { ...periodo(req.query), idProfessor: texto(req.query.id_professor) };
  const { nomeArquivo, ...dados } = await service.dadosDoRelatorio(
    req.user,
    filtros,
    req.id_instituicao,
  );
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  gerarRelatorioPontoPDF({ res, ...dados });
}

async function corrigir(req, res) {
  const { hora_entrada, hora_saida } = req.body;
  await service.corrigir(
    req.user,
    req.params.id,
    { horaEntrada: hora_entrada, horaSaida: hora_saida },
    req.id_instituicao,
  );
  res.json({ message: 'Registro atualizado.' });
}

async function excluir(req, res) {
  await service.excluir(req.user, req.params.id, req.id_instituicao);
  res.json({ message: 'Registro removido.' });
}

module.exports = {
  turmasDeHoje,
  meuHistorico,
  baterEntrada,
  registrarSaida,
  baterEntradaInterna,
  registrarSaidaInterna,
  listar,
  educadores,
  relatorioPdf,
  corrigir,
  excluir,
};
