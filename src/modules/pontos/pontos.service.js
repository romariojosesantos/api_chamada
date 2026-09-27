// Ponto do educador — registro de entrada/saída por AULA (turma + data) OU
// por ATIVIDADE INTERNA (Planejamento, Reuniões, Monitorias, Ensaios, Outros
// — tipos cadastrados por coordenador em tipos-interno.routes.js, nunca
// em `atividades`, de propósito: assim nunca aparecem em relatório/grade/
// roster de turma). Uma linha de `pontos` representa OU uma aula
// (id_atividade preenchido, id_tipo_interno NULL) OU uma atividade interna
// (o inverso) — nunca as duas; bater ponto grava hora_entrada, "Registrar
// saída" completa a mesma linha.
//
// Quem corrige um ponto (de turma OU interno): só coordenador (geral ou da
// ÁREA daquela turma/tipo) ou master. Não existe "educador responsável" — o
// educador comum nunca corrige nem o próprio ponto. Um usuário perfil
// 'coordenador' tem `usuarios.area_coordenacao`: null = coordenador GERAL
// (vê/edita todas as áreas); preenchida = só aquela área — ver
// escopo-ponto.js (escopoDeAcesso, compartilhado com tipos-interno.routes.js).
//
// Atividade interna não tem horário fixo (diferente de turma) — o educador
// só vê e bate ponto nos tipos das áreas onde ele dá aula.
//
// Bater ponto só vale pro dia de hoje (em Brasília) — não dá pra registrar
// entrada/saída de outro dia; o "hoje" é calculado no servidor, ignorando
// qualquer data do cliente.
//
// Isso é um controle interno complementar, não o ponto oficial de CLT (que
// exigiria certificação REP-P/Portaria 671) — não tem esse peso de
// compliance aqui de propósito.
const model = require('./pontos.model');
const AppError = require('../../utils/AppError');
const { escopoDeAcesso } = require('./escopo-ponto');
// Hora de Brasília calculada no Node — nunca NOW() do MySQL, que roda no
// fuso do SERVIDOR do banco (frequentemente UTC): "bater ponto às 23:39"
// ficava salvo como "02:39". A string gravada já É a hora de Brasília.
const { hojeBrasil, agoraBrasil } = require('../../utils/data-brasil');

const DIAS_SEMANA_POR_INDICE = [
  'Domingo',
  'Segunda',
  'Terça',
  'Quarta',
  'Quinta',
  'Sexta',
  'Sábado',
];

// Dia da semana de uma data "YYYY-MM-DD", sem depender do fuso horário do
// processo — Date.UTC + getUTCDay é sempre a mesma resposta.
function diaSemanaDaData(dataStr) {
  const partes = String(dataStr || '')
    .split('-')
    .map(Number);
  if (partes.length !== 3 || partes.some(Number.isNaN)) return null;
  const [ano, mes, dia] = partes;
  return DIAS_SEMANA_POR_INDICE[new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay()];
}

// Só educador com conta vinculada a um cadastro de professor bate ponto.
function exigirProfessor(usuario) {
  if (usuario.perfil !== 'professor') {
    throw new AppError('Só educadores batem ponto pela própria conta.', 403);
  }
  if (!usuario.id_professor) {
    throw new AppError('Sua conta não está vinculada a um cadastro de educador.', 403);
  }
  return usuario.id_professor;
}

// Visão agregada: master e coordenador geral veem tudo (''); coordenador de
// área só vê a área dele — o filtro de área é forçado, nunca aceita ver outra.
function exigirEscopo(usuario) {
  const escopo = escopoDeAcesso(usuario);
  if (escopo === null) throw new AppError('Sem acesso à visão geral de registros.', 403);
  return escopo;
}

function exigirPeriodo(dataInicio, dataFim) {
  if (!dataInicio || !dataFim) throw new AppError('Informe data_inicio e data_fim.', 400);
}

// Um professor só pode ter UM ponto em aberto por vez, turma ou atividade
// interna — precisa registrar a saída antes de bater outro (a pessoa está
// fisicamente num lugar só por vez).
async function exigirNenhumPontoAberto(idProfessor, data, idInstituicao) {
  const aberto = await model.buscarPontoAberto(idProfessor, data, idInstituicao);
  if (aberto) {
    throw new AppError(
      `Você já tem um registro em aberto em "${aberto.nome}" — registre a saída antes de bater outro.`,
      409,
    );
  }
}

// --- Tela do educador ---

// Turmas de HOJE do educador (só as do dia da semana de hoje), com o status
// do ponto já embutido (null = ainda não bateu), e as atividades internas.
async function painelDoDia(usuario, idInstituicao) {
  const idProfessor = exigirProfessor(usuario);
  const data = hojeBrasil();
  const diaSemana = diaSemanaDaData(data);
  const [turmas, tipos] = await Promise.all([
    model.turmasDoDia(idProfessor, data, diaSemana, idInstituicao),
    model.tiposInternosDoProfessor(idProfessor, data, idInstituicao),
  ]);
  return { data, dia_semana: diaSemana, turmas, atividades_internas: tipos };
}

// O "espelho de ponto" do próprio educador — só consulta.
async function meuHistorico(usuario, { dataInicio, dataFim }, idInstituicao) {
  const idProfessor = exigirProfessor(usuario);
  exigirPeriodo(dataInicio, dataFim);
  return model.historicoDoProfessor(idProfessor, dataInicio, dataFim, idInstituicao);
}

// --- Visão agregada (coordenação) ---

async function listar(usuario, { dataInicio, dataFim, idProfessor }, idInstituicao) {
  const area = exigirEscopo(usuario);
  exigirPeriodo(dataInicio, dataFim);
  return model.listar({ dataInicio, dataFim, idProfessor, area }, idInstituicao);
}

async function educadores(usuario, idInstituicao) {
  const area = exigirEscopo(usuario);
  return model.educadoresComPonto(area, idInstituicao);
}

// Dados do Relatório de Ponto em PDF — sempre de UM educador (folha de ponto
// individual: cabeçalho com nome/e-mail do prestador, subtotal por dia,
// assinatura), por isso `idProfessor` é obrigatório.
async function dadosDoRelatorio(usuario, { dataInicio, dataFim, idProfessor }, idInstituicao) {
  const area = exigirEscopo(usuario);
  exigirPeriodo(dataInicio, dataFim);
  if (!idProfessor) {
    throw new AppError('Selecione um educador — o relatório em PDF é sempre individual.', 400);
  }

  const rows = await model.linhasDoRelatorio(
    { dataInicio, dataFim, idProfessor, area },
    idInstituicao,
  );
  const professor = await model.buscarProfessor(idProfessor, idInstituicao);
  if (!professor) throw new AppError('Educador não encontrado.', 404);
  const [professorEmail, instituicaoNome] = await Promise.all([
    model.emailDoProfessor(idProfessor),
    model.nomeDaInstituicao(idInstituicao),
  ]);

  return {
    nomeArquivo: `RegistroAtividades_${professor.nome.replace(/[^a-zA-Z0-9]+/g, '_')}_${dataInicio}_a_${dataFim}.pdf`,
    instituicaoNome,
    // Relatório formal usa o nome COMPLETO quando cadastrado; o `nome` curto
    // é só o de exibição casual no resto do sistema.
    professorNome: professor.nome_completo || professor.nome,
    professorEmail,
    dataInicio,
    dataFim,
    rows,
  };
}

// --- Bater ponto ---

// Entrada numa turma, só HOJE: cria a linha ou marca a entrada numa linha
// que já existia sem entrada. `criado` diz qual dos dois (201 x 200).
async function baterEntradaTurma(usuario, idAtividade, idInstituicao) {
  const idProfessor = exigirProfessor(usuario);
  if (!idAtividade) throw new AppError('Informe id_atividade.', 400);

  const data = hojeBrasil();
  const diaSemana = diaSemanaDaData(data);

  const turma = await model.buscarTurmaAtiva(idAtividade, idInstituicao);
  if (!turma) throw new AppError('Turma não encontrada.', 404);
  if (turma.idprofessor !== idProfessor && !(await model.ehCoProfessor(idAtividade, idProfessor))) {
    throw new AppError('Essa turma não é sua.', 403);
  }
  if (turma.dia_semana !== diaSemana) {
    throw new AppError(
      `Essa turma acontece na(o) ${turma.dia_semana}, não hoje (${diaSemana}).`,
      400,
    );
  }

  const existente = await model.pontoDaTurmaNoDia(idProfessor, idAtividade, data);
  if (existente?.hora_entrada) {
    throw new AppError('Você já bateu ponto de entrada nessa aula hoje.', 409);
  }
  // Se o ponto aberto fosse desta mesma turma, a checagem acima já teria barrado.
  await exigirNenhumPontoAberto(idProfessor, data, idInstituicao);

  const hora = agoraBrasil();
  if (existente) {
    await model.marcarEntrada(existente.id, hora);
    return { criado: false, id: existente.id };
  }
  const id = await model.criarEntradaTurma({ idProfessor, idAtividade, data, hora }, idInstituicao);
  return { criado: true, id };
}

// Saída da turma — a linha de hoje precisa ter entrada e não ter saída.
async function registrarSaidaTurma(usuario, idAtividade, idInstituicao) {
  const idProfessor = exigirProfessor(usuario);
  if (!idAtividade) throw new AppError('Informe id_atividade.', 400);

  const ponto = await model.pontoDaTurmaNaInstituicao(
    idProfessor,
    idAtividade,
    hojeBrasil(),
    idInstituicao,
  );
  if (!ponto || !ponto.hora_entrada) throw new AppError('Registre a entrada primeiro.', 400);
  if (ponto.hora_saida) throw new AppError('Você já registrou a saída dessa aula.', 409);

  await model.marcarSaida(ponto.id, agoraBrasil());
  return ponto.id;
}

// Entrada numa atividade INTERNA — sem turma nem horário fixo: vale a qualquer
// hora de hoje, sem checagem de dia_semana, só para tipos de uma área onde o
// professor dá aula. Sempre cria uma linha NOVA (ao contrário de turma):
// atividade interna pode ser batida várias vezes no dia, e reaproveitar uma
// linha já encerrada apagaria a sessão anterior. Seguro porque a checagem de
// ponto aberto garante que não há sessão pendurada.
async function baterEntradaInterna(usuario, idTipo, idInstituicao) {
  const idProfessor = exigirProfessor(usuario);
  if (!idTipo) throw new AppError('Informe id_tipo_interno.', 400);

  if (!(await model.tipoInternoPermitido(idTipo, idProfessor, idInstituicao))) {
    throw new AppError('Você não tem acesso a esse tipo de atividade.', 403);
  }

  const data = hojeBrasil();
  await exigirNenhumPontoAberto(idProfessor, data, idInstituicao);

  return model.criarEntradaInterna(
    { idProfessor, idTipo, data, hora: agoraBrasil() },
    idInstituicao,
  );
}

// Saída da atividade interna — fecha a sessão em ABERTO de hoje (pode haver
// outras já encerradas mais cedo; por isso a busca filtra `hora_saida IS NULL`).
async function registrarSaidaInterna(usuario, idTipo, idInstituicao) {
  const idProfessor = exigirProfessor(usuario);
  if (!idTipo) throw new AppError('Informe id_tipo_interno.', 400);

  const ponto = await model.sessaoInternaAberta(idProfessor, idTipo, hojeBrasil(), idInstituicao);
  if (!ponto) throw new AppError('Registre a entrada primeiro.', 400);

  await model.marcarSaida(ponto.id, agoraBrasil());
  return ponto.id;
}

// --- Correção pela coordenação ---

// Carrega o ponto e confere se o usuário pode mexer nele: master ou
// coordenador geral sempre; coordenador de área só na área da turma/tipo.
async function pontoEditavel(usuario, id, idInstituicao, acao) {
  const ponto = await model.buscarPorId(id, idInstituicao);
  if (!ponto) throw new AppError('Registro não encontrado.', 404);

  const escopo = escopoDeAcesso(usuario);
  const pode = escopo === '' || (escopo !== null && (await model.areaDoPonto(ponto)) === escopo);
  if (!pode) {
    throw new AppError(
      `Só o coordenador da área dessa turma (ou master) pode ${acao} esse registro.`,
      403,
    );
  }
  return ponto;
}

async function corrigir(usuario, id, { horaEntrada, horaSaida }, idInstituicao) {
  await pontoEditavel(usuario, id, idInstituicao, 'corrigir');
  await model.atualizarHorarios(id, horaEntrada || null, horaSaida || null);
}

async function excluir(usuario, id, idInstituicao) {
  await pontoEditavel(usuario, id, idInstituicao, 'apagar');
  await model.excluir(id);
}

module.exports = {
  painelDoDia,
  meuHistorico,
  listar,
  educadores,
  dadosDoRelatorio,
  baterEntradaTurma,
  registrarSaidaTurma,
  baterEntradaInterna,
  registrarSaidaInterna,
  corrigir,
  excluir,
};
