// Leitura e gravação de presença (chamada). O ponto mais sensível do sistema:
// a gravação é feita em lote (todos os alunos de uma chamada de uma vez) dentro
// de uma transação, para nunca salvar uma chamada pela metade.
const model = require('./presenca.model');
const AppError = require('../../utils/AppError');
const { emTransacao } = require('../../utils/transacao');
const { logAuditEvent } = require('../../utils/audit');
const { criarNotificacao } = require('../notificacoes/notificacoes.service');
const { hojeBrasil } = require('../../utils/data-brasil');

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const diaDaSemana = (data) => DIAS[new Date(`${data}T12:00:00`).getDay()];

// Turnos usados no seletor da Chamada; "finalizar o dia" tenta os três.
const TURNOS_CANONICOS = ['Manhã', 'Tarde', 'Noite'];

// Período (coluna `presenca.periodo`) correspondente a um turno da Chamada.
function periodoDoTurno(turno) {
  const t = String(turno || '').toLowerCase();
  if (t.includes('manh')) return 'manha';
  if (t.includes('tard')) return 'tarde';
  if (t.includes('noit')) return 'noite';
  return null;
}

// Mês "YYYY-MM" pedido, ou o mês atual (Brasília).
function mesOuAtual(mes) {
  return /^\d{4}-\d{2}$/.test(mes || '') ? mes : hojeBrasil().slice(0, 7);
}

async function exigirDiaLetivo(data, idInstituicao, erro) {
  const dia = await model.diaSemAula(data, idInstituicao);
  if (dia) {
    throw new AppError(erro, 400, { motivo: dia.motivo || 'Dia sem aula', isDiaSemAula: true });
  }
}

// Filtro por data é opcional (`data` exata, ou `dataInicio`+`dataFim`) — sem
// nenhum, devolve o histórico inteiro. A Chamada faz poll a cada 15s só do dia
// atual, então nunca deve chamar sem filtro.
function listar(filtros, idInstituicao) {
  return model.listar(filtros, idInstituicao);
}

// Salva a chamada em lote para uma data: `status: null` é o sinal do frontend
// para "desmarcar" (apaga o registro do aluno no período); os demais são
// upsert. Recusa a gravação inteira se a data estiver marcada como "sem aula".
// Sem `periodo` (chamada antiga/turno não mapeado) grava NULL, como antes da
// coluna existir.
async function salvarChamada({ data, periodo, chamadas }, idInstituicao) {
  await exigirDiaLetivo(data, idInstituicao, 'Não é possível registrar presença neste dia');

  return emTransacao(async (db) => {
    const paraApagar = chamadas.filter((c) => c.status === null);
    const paraGravar = chamadas.filter((c) => c.status !== null);

    if (paraApagar.length > 0) {
      await model.apagarDoPeriodo(
        db,
        paraApagar.map((c) => c.aluno_id),
        data,
        periodo,
        idInstituicao,
      );
    }

    let afetados = paraApagar.length;
    if (paraGravar.length > 0) {
      afetados += await model.gravarLote(
        db,
        paraGravar.map((c) => [
          c.aluno_id,
          data,
          c.status,
          idInstituicao,
          c.observacao || null,
          periodo,
        ]),
      );
    }

    await logAuditEvent(
      'SALVAR_CHAMADA_LOTE',
      `Data: ${data}, Alunos: ${chamadas.length}, Afetados: ${afetados}`,
      idInstituicao,
      db,
    );
    return { total: chamadas.length, registros_afetados: afetados };
  });
}

// Registra que um aluno precisou ser adicionado manualmente (via busca) na
// chamada por não aparecer na lista automática do turno/transporte/dia — sinal
// de cadastro errado. Aponta se o problema é o turno (da MATRÍCULA, não o
// atributo fixo do aluno), o transporte, ambos ou indefinido. Grava em
// `adicoes_manuais_chamada` (pro relatório mensal), no log de auditoria e
// numa notificação.
async function registrarAdicaoManual({ alunoId, data, turno, transporte }, idInstituicao) {
  if (!alunoId || !data || !turno) {
    throw new AppError('aluno_id, data e turno são obrigatórios.', 400);
  }

  const aluno = await model.buscarAluno(alunoId, idInstituicao);
  if (!aluno) throw new AppError('Aluno não encontrado.', 404);

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .trim();
  const turnos = await model.turnosDoAlunoNoDia(
    { alunoId, diaSemana: diaDaSemana(data), data },
    idInstituicao,
  );
  const turnoOk = turnos.some((t) => norm(t) === norm(turno));

  // Transporte só é problema se havia um filtro de transporte selecionado na
  // tela (mesmo fallback "Sem transporte definido" da tela de Chamada).
  const alunoTransporte =
    aluno.transporte && aluno.transporte.trim() ? aluno.transporte : 'Sem transporte definido';
  const transporteOk =
    !transporte || !transporte.trim() || norm(alunoTransporte) === norm(transporte);

  const motivoProvavel =
    !turnoOk && !transporteOk
      ? 'ambos'
      : !turnoOk
        ? 'turno'
        : !transporteOk
          ? 'transporte'
          : 'indefinido';

  const motivoTexto = {
    turno: `o turno cadastrado na matrícula não bate com "${turno}"`,
    transporte: `o transporte cadastrado ("${alunoTransporte}") não bate com o filtro selecionado ("${transporte}")`,
    ambos: `nem o turno da matrícula nem o transporte cadastrado batem com o que estava selecionado (turno "${turno}", transporte "${transporte}")`,
    indefinido:
      'turno e transporte batem — motivo não identificado, vale conferir o cadastro mesmo assim',
  }[motivoProvavel];

  await model.registrarAdicaoManual(
    { alunoId, data, turno, transporte, alunoTransporte, motivoProvavel },
    idInstituicao,
  );

  await logAuditEvent(
    'ALUNO_ADICIONADO_MANUALMENTE_CHAMADA',
    `Aluno ID: ${alunoId} (${aluno.nome}) adicionado manualmente na chamada de ${data} (turno: ${turno}, transporte: ${transporte || '-'}) — não apareceu na lista automática. Motivo provável: ${motivoTexto}.`,
    idInstituicao,
  );

  await criarNotificacao({
    tipo: 'sistema',
    titulo: 'Aluno adicionado manualmente à chamada',
    mensagem: `${aluno.nome} não apareceu automaticamente na lista de chamada de ${data} e precisou ser adicionado via busca — ${motivoTexto}.`,
    id_instituicao: idInstituicao,
    id_aluno: alunoId,
  });
}

async function adicoesManuais(mesPedido, idInstituicao) {
  const mes = mesOuAtual(mesPedido);
  return { mes, adicoes: await model.adicoesManuaisDoMes(mes, idInstituicao) };
}

// Finalizar a chamada de UM turno: registra 'ausente' para todo aluno esperado
// que ainda não tem registro NESSE período na data. Não sobrescreve registros
// existentes; um turno sem ninguém esperado só não insere nada. Pra
// 'manha'/'tarde' um registro antigo sem período conta como "já registrado";
// pra 'noite' nunca (ver condicaoPeriodo em presenca.model.js).
async function finalizarTurno(data, turno, idInstituicao) {
  await exigirDiaLetivo(data, idInstituicao, 'Não é possível finalizar chamada neste dia');

  const esperados = await model.idsEsperados(
    { diaSemana: diaDaSemana(data), data, turno },
    idInstituicao,
  );
  const periodo = periodoDoTurno(turno);
  const comRegistro = new Set(await model.idsComRegistro(data, periodo, idInstituicao));

  const ausentes = esperados
    .filter((id) => !comRegistro.has(id))
    .map((id) => [id, data, 'ausente', null, idInstituicao, periodo]);
  return ausentes.length > 0 ? model.inserirAusentes(ausentes) : 0;
}

async function finalizar({ data, turno }, idInstituicao) {
  if (!data) throw new AppError('Data é obrigatória.', 400);
  if (!turno) throw new AppError('Turno é obrigatório.', 400);
  return finalizarTurno(data, turno, idInstituicao);
}

// Finaliza os três turnos de um dia de uma vez (botão do Painel do Gestor).
async function finalizarDia(data, idInstituicao) {
  if (!data) throw new AppError('Data é obrigatória.', 400);

  const porTurno = [];
  let total = 0;
  for (const turno of TURNOS_CANONICOS) {
    const ausentes = await finalizarTurno(data, turno, idInstituicao);
    if (ausentes > 0) {
      total += ausentes;
      porTurno.push({ turno, ausentes_registrados: ausentes });
    }
  }
  return { total, porTurno };
}

// Dias do mês (até hoje) que ainda têm turno com aluno esperado sem registro,
// agrupados por dia — pro Painel do Gestor. Dia futuro não é pendência.
async function pendenciasDoMes(mesPedido, idInstituicao) {
  const mes = mesOuAtual(mesPedido);
  const hoje = hojeBrasil();
  const primeiroDiaMes = `${mes}-01`;
  if (primeiroDiaMes > hoje) return { mes, dias: [] };
  const [ano, mesNum] = mes.split('-').map(Number);
  const ultimoDiaCalendario = `${mes}-${String(new Date(ano, mesNum, 0).getDate()).padStart(2, '0')}`;
  const dataFim = ultimoDiaCalendario > hoje ? hoje : ultimoDiaCalendario;

  const rows = await model.pendenciasNoIntervalo(primeiroDiaMes, dataFim, idInstituicao);

  const porDia = new Map();
  rows.forEach((r) => {
    const dataStr = r.data instanceof Date ? r.data.toISOString().split('T')[0] : r.data;
    if (!porDia.has(dataStr)) porDia.set(dataStr, []);
    porDia.get(dataStr).push({ turno: r.turno, pendentes: r.pendentes });
  });
  const dias = [...porDia.entries()]
    .map(([data, turnos]) => ({ data, turnos }))
    .sort((a, b) => b.data.localeCompare(a.data));

  return { mes, dias };
}

module.exports = {
  listar,
  salvarChamada,
  registrarAdicaoManual,
  adicoesManuais,
  finalizar,
  finalizarDia,
  pendenciasDoMes,
};
