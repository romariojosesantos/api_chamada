const service = require('./presenca.service');

async function listar(req, res) {
  const { data, data_inicio, data_fim, aluno_id } = req.query;
  res.json(
    await service.listar(
      { data, dataInicio: data_inicio, dataFim: data_fim, alunoId: aluno_id },
      req.id_instituicao,
    ),
  );
}

async function salvarChamada(req, res) {
  const { data, chamadas } = req.body;
  const detalhes = await service.salvarChamada(
    { data, chamadas, periodo: req.body.periodo || null },
    req.id_instituicao,
  );
  res.status(201).json({ message: 'Presenças processadas com sucesso!', detalhes });
}

async function adicaoManual(req, res) {
  const { aluno_id, data, turno, transporte } = req.body;
  await service.registrarAdicaoManual(
    { alunoId: aluno_id, data, turno, transporte },
    req.id_instituicao,
  );
  res.status(201).json({ success: true });
}

async function adicoesManuais(req, res) {
  res.json(await service.adicoesManuais(req.query.mes, req.id_instituicao));
}

async function finalizar(req, res) {
  const ausentes = await service.finalizar(req.body, req.id_instituicao);
  res.json({
    message: ausentes > 0 ? 'Chamada finalizada com sucesso' : 'Chamada já estava finalizada',
    ausentes_registrados: ausentes,
  });
}

async function finalizarDia(req, res) {
  const { total, porTurno } = await service.finalizarDia(req.body.data, req.id_instituicao);
  res.json({
    message: total > 0 ? 'Chamada do dia finalizada com sucesso' : 'Chamada já estava finalizada',
    ausentes_registrados: total,
    por_turno: porTurno,
  });
}

async function pendenciasMes(req, res) {
  res.json(await service.pendenciasDoMes(req.query.mes, req.id_instituicao));
}

module.exports = {
  listar,
  salvarChamada,
  adicaoManual,
  adicoesManuais,
  finalizar,
  finalizarDia,
  pendenciasMes,
};
