// Regras de matrícula individual: matricular, mover, cancelar e duplicidades.
const pool = require('../../config/database');
const model = require('./matriculas.model');
const AppError = require('../../utils/AppError');
const { emTransacao } = require('../../utils/transacao');
const { podeMatricular } = require('./regras-matricula');
const { syncAlunoStatusFromMatriculas } = require('../alunos/status-sync');
const { logAuditEvent } = require('../../utils/audit');
const { criarNotificacao } = require('../notificacoes/notificacoes.service');
const { descreverTurma } = require('./descricao-turma');

// Turma de destino com dia/horário/turno definidos: a matrícula herda tudo
// dela, então não há como criar uma posição inconsistente com a turma.
async function buscarTurmaCompleta(id, idInstituicao, mensagem404) {
  const turma = await model.buscarTurma(id, idInstituicao);
  if (!turma) throw new AppError(mensagem404, 404);
  if (!turma.dia_semana || !turma.horario || !turma.turno) {
    throw new AppError('Essa turma ainda não tem dia/horário/turno definidos.', 400);
  }
  return turma;
}

// Duplicidades (mesmo aluno com duas matrículas ativas no mesmo dia e
// horário), para um master/coordenador escolher qual manter.
async function listarDuplicidades(idInstituicao) {
  const grupos = await model.gruposDuplicados(idInstituicao);
  if (grupos.length === 0) return [];

  const idsDoGrupo = (g) => g.ids.split(',').map(Number);
  const linhas = await model.detalhesDasMatriculas(grupos.flatMap(idsDoGrupo));
  const linhaPorId = new Map(linhas.map((l) => [l.idmatricula, l]));

  return grupos.map((g) => {
    const opcoes = idsDoGrupo(g)
      .map((id) => linhaPorId.get(id))
      .filter(Boolean);
    return {
      idaluno: g.idaluno,
      nome_aluno: opcoes[0]?.nome_aluno || '',
      dia_semana: g.dia_semana,
      horario: g.horario,
      opcoes,
    };
  });
}

// Mantém a matrícula `manter` e encerra as outras ativas na mesma posição.
async function resolverDuplicidade(manter, idInstituicao) {
  if (!manter) throw new AppError('Informe a matrícula a manter (manter).', 400);

  const matricula = await model.buscarAtiva(manter, idInstituicao);
  if (!matricula) {
    throw new AppError('Matrícula não encontrada (ou já encerrada) nesta instituição.', 404);
  }

  const outras = await model.outrasNaPosicao(
    pool,
    {
      idAluno: matricula.idaluno,
      diaSemana: matricula.dia_semana,
      horario: matricula.horario,
      exceto: manter,
    },
    idInstituicao,
  );
  if (outras.length === 0) return 0;

  await model.encerrarVarias(pool, outras);
  await syncAlunoStatusFromMatriculas(pool, [matricula.idaluno], idInstituicao);
  await logAuditEvent(
    'MATRICULA_DUPLICIDADE_RESOLVIDA',
    `Aluno #${matricula.idaluno}, ${matricula.dia_semana} ${matricula.horario}: manteve #${manter}, encerrou #${outras.join(', #')}`,
    idInstituicao,
  );
  return outras.length;
}

// Matricula um aluno numa turma (telas de Turmas, Gerenciar Matrículas e Grade).
// Se o aluno já tem outra turma no mesmo dia e horário, bloqueia: trocar de
// turma é o "Mover", que deixa essa intenção explícita.
async function matricular(idAluno, idTurma, idInstituicao) {
  if (!idAluno || !idTurma) throw new AppError('aluno_id e id_atividade são obrigatórios.', 400);

  const turma = await buscarTurmaCompleta(idTurma, idInstituicao, 'Turma não encontrada.');
  const aluno = await model.buscarAluno(idAluno, idInstituicao);
  if (!aluno) throw new AppError('Aluno não encontrado.', 404);

  // Turma da Noite (ensaio) aceita qualquer turno; manhã x tarde não.
  const turnoAluno = aluno.turno ? String(aluno.turno).trim() : null;
  if (!podeMatricular(turnoAluno, turma.turno)) {
    throw new AppError(
      `Conflito de turno: ${aluno.nome} é do turno ${turnoAluno}, mas essa turma é do turno ${turma.turno}.`,
      409,
    );
  }

  await emTransacao(async (db) => {
    const ocupacao = await model.ocupacaoNoHorario(
      db,
      { idAluno, diaSemana: turma.dia_semana, horario: turma.horario },
      idInstituicao,
    );
    if (ocupacao.length > 0 && Number(ocupacao[0].idatividades) === Number(idTurma)) {
      throw new AppError('Esse aluno já está matriculado nessa turma.', 409);
    }
    if (ocupacao.length > 0) {
      throw new AppError(
        `Conflito de horário: ${aluno.nome} já está matriculado(a) em "${ocupacao[0].nome_turma_atual}" nesse mesmo dia/horário/turno. Use "Mover" se a intenção é trocar de turma.`,
        409,
      );
    }

    await model.inserir(
      db,
      {
        idAluno,
        idAtividade: idTurma,
        diaSemana: turma.dia_semana,
        horario: turma.horario,
        turno: turma.turno,
      },
      idInstituicao,
    );
    await syncAlunoStatusFromMatriculas(db, [Number(idAluno)], idInstituicao);

    // Auditoria e notificação na conexão da transação: pedir outra ao pool
    // travaria em produção (pool de 1 conexão).
    await logAuditEvent(
      'ALUNO_MATRICULADO_TURMA',
      `Aluno #${idAluno} -> turma #${idTurma} "${turma.nome}"`,
      idInstituicao,
      db,
    );
    const local = `"${turma.nome}" (${turma.dia_semana} ${turma.horario}, ${turma.turno})`;
    await criarNotificacao(
      {
        tipo: 'matricula',
        titulo: 'Novo aluno matriculado',
        mensagem: `${aluno.nome} foi matriculado(a) em ${local}.`,
        id_instituicao: idInstituicao,
        id_aluno: Number(idAluno),
        detalhes: [
          {
            aluno_id: Number(idAluno),
            aluno_nome: aluno.nome,
            de: null,
            para: descreverTurma(turma),
          },
        ],
      },
      db,
    );
  });
}

// Move a matrícula para outra turma qualquer (modal "Mover" da Grade):
// encerra a de origem e cria a nova na mesma transação.
async function mover(idMatricula, idTurmaDestino, idInstituicao) {
  if (!idMatricula || !idTurmaDestino) {
    throw new AppError('matricula_id e id_atividade_destino são obrigatórios.', 400);
  }

  const origem = await model.buscarOrigem(idMatricula, idInstituicao);
  if (!origem) throw new AppError('Matrícula de origem não encontrada ou já encerrada.', 404);
  const idAluno = origem.idaluno;

  const turma = await buscarTurmaCompleta(
    idTurmaDestino,
    idInstituicao,
    'Turma de destino não encontrada.',
  );
  const aluno = await model.nomeETurnoDoAluno(idAluno);
  if (!podeMatricular(aluno?.turno, turma.turno)) {
    throw new AppError(
      `Conflito de turno: ${aluno?.nome || 'Aluno'} é do turno ${aluno?.turno}, mas essa turma é do turno ${turma.turno}.`,
      409,
    );
  }

  await emTransacao(async (db) => {
    await model.encerrar(db, idMatricula);

    // Se o aluno já tinha outra matrícula no dia/horário de destino, ela sai:
    // senão ficariam duas ativas na mesma posição.
    const noDestino = await model.outrasNaPosicao(
      db,
      { idAluno, diaSemana: turma.dia_semana, horario: turma.horario, exceto: idMatricula },
      idInstituicao,
    );
    if (noDestino.length > 0) await model.encerrarVarias(db, noDestino);

    await model.inserir(
      db,
      {
        idAluno,
        idAtividade: idTurmaDestino,
        diaSemana: turma.dia_semana,
        horario: turma.horario,
        turno: turma.turno,
      },
      idInstituicao,
    );
    await syncAlunoStatusFromMatriculas(db, [Number(idAluno)], idInstituicao);

    await logAuditEvent(
      'ALUNO_MOVIDO_TURMA',
      `Aluno #${idAluno} -> turma #${idTurmaDestino} "${turma.nome}" (matrícula #${idMatricula} encerrada)`,
      idInstituicao,
      db,
    );
    await criarNotificacao(
      {
        tipo: 'movimentacao',
        titulo: 'Aluno mudou de turma',
        mensagem: `${aluno?.nome || 'Aluno'} foi movido(a) para "${turma.nome}" (${turma.dia_semana} ${turma.horario}, ${turma.turno}).`,
        id_instituicao: idInstituicao,
        id_aluno: Number(idAluno),
        detalhes: [
          {
            aluno_id: Number(idAluno),
            aluno_nome: aluno?.nome || null,
            de: origem.nome_turma ? descreverTurma({ ...origem, nome: origem.nome_turma }) : null,
            para: descreverTurma(turma),
          },
        ],
      },
      db,
    );
  });
}

// Encerra uma matrícula (remover aluno da turma). Nunca apaga: mantém o histórico.
async function cancelar(id, idInstituicao) {
  const matricula = await model.buscarParaCancelar(id, idInstituicao);
  if (!matricula) throw new AppError('Matrícula não encontrada ou já cancelada.', 404);

  await model.encerrar(pool, id);
  await syncAlunoStatusFromMatriculas(pool, [matricula.idaluno], idInstituicao);
  await logAuditEvent(
    'MATRICULA_CANCELADA',
    `Matrícula #${id} (aluno #${matricula.idaluno})`,
    idInstituicao,
  );
}

module.exports = {
  listarDuplicidades,
  resolverDuplicidade,
  matricular,
  mover,
  cancelar,
};
