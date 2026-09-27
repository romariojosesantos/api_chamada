// Salvamento em lote da tela de Ajuste de Grade. Cada alteração é uma célula
// da grade (aluno × dia × horário) com a nova turma, ou vazia para remover:
//   turma + matrícula na posição -> troca a turma;
//   turma + posição livre        -> cria matrícula;
//   vazia + matrícula na posição -> encerra.
// Sempre em lote (poucos SELECTs e até 3 escritas): uma query por célula
// estourava o tempo limite da função na Vercel em lotes grandes.
const model = require('./matriculas.model');
const AppError = require('../../utils/AppError');
const { emTransacao } = require('../../utils/transacao');
const { podeMatricular } = require('./regras-matricula');
const { syncAlunoStatusFromMatriculas } = require('../alunos/status-sync');
const { criarNotificacao } = require('../notificacoes/notificacoes.service');
const { descreverTurma } = require('./descricao-turma');

function validar(alteracoes) {
  if (!alteracoes || !Array.isArray(alteracoes) || alteracoes.length === 0) {
    throw new AppError('Nenhuma alteração fornecida', 400);
  }
  if (alteracoes.some((a) => !a.aluno_id || !a.dia_semana || !a.horario)) {
    throw new AppError('Dados incompletos na alteração', 400);
  }
}

const chavePosicao = (idAluno, dia, horario) => `${idAluno}-${dia}-${horario}`;

// Nunca deveria haver duas matrículas ativas na mesma posição, mas um bug
// antigo deixou isso acontecer. Fica a mais recente; as outras são encerradas.
function resolverDuplicadas(existentes) {
  const idsPorPosicao = new Map();
  for (const m of existentes) {
    const chave = chavePosicao(m.idaluno, m.dia_semana, m.horario);
    if (!idsPorPosicao.has(chave)) idsPorPosicao.set(chave, []);
    idsPorPosicao.get(chave).push(m.idmatricula);
  }
  const idPorPosicao = new Map();
  const duplicadas = [];
  idsPorPosicao.forEach((ids, chave) => {
    const maisRecente = Math.max(...ids);
    idPorPosicao.set(chave, maisRecente);
    ids.filter((id) => id !== maisRecente).forEach((id) => duplicadas.push(id));
  });
  return { idPorPosicao, duplicadas };
}

// Decide o que fazer com cada célula (sem banco). Célula com turma de turno
// incompatível vira conflito e é pulada, sem travar o lote.
function planejar(alteracoes, { idPorPosicao, existentePorId, alunoPorId, turmaPorId }) {
  const plano = {
    inserir: [],
    atualizar: [],
    encerrar: [],
    results: [],
    conflitosTurno: [],
    detalhes: [],
  };

  for (const { aluno_id, dia_semana, horario, id_atividade } of alteracoes) {
    const idExistente = idPorPosicao.get(chavePosicao(Number(aluno_id), dia_semana, horario));
    const aluno = alunoPorId.get(Number(aluno_id));
    const turmaAntiga = turmaPorId.get(Number(existentePorId.get(idExistente)?.idatividades));
    const de = turmaAntiga ? descreverTurma({ ...turmaAntiga, dia_semana, horario }) : null;

    if (id_atividade) {
      const turma = turmaPorId.get(Number(id_atividade));
      if (turma && !podeMatricular(aluno?.turno, turma.turno)) {
        plano.conflitosTurno.push(
          `${aluno?.nome || 'Aluno'} (turno ${aluno?.turno}) x "${turma.nome}" (turno ${turma.turno}), ${dia_semana} ${horario}`,
        );
        continue;
      }

      const turno = turma?.turno || '';
      if (idExistente) {
        plano.atualizar.push({ id: idExistente, id_atividade, turno });
        plano.results.push({ action: 'updated', id: idExistente });
      } else {
        plano.inserir.push({ aluno_id, dia_semana, horario, id_atividade, turno });
        plano.results.push({ action: 'created', aluno_id, dia_semana, horario });
      }
      plano.detalhes.push({
        aluno_id: Number(aluno_id),
        aluno_nome: aluno?.nome || null,
        de,
        para: turma ? descreverTurma({ ...turma, dia_semana, horario }) : null,
      });
    } else if (idExistente) {
      plano.encerrar.push(idExistente);
      plano.results.push({ action: 'deleted', id: idExistente });
      plano.detalhes.push({
        aluno_id: Number(aluno_id),
        aluno_nome: aluno?.nome || null,
        de,
        para: null,
      });
    }
  }
  return plano;
}

async function salvar(alteracoes, idInstituicao) {
  validar(alteracoes);

  return emTransacao(async (db) => {
    const posicoes = alteracoes.map((a) => [Number(a.aluno_id), a.dia_semana, a.horario]);
    const existentes = await model.ativasNasPosicoes(db, posicoes, idInstituicao);
    const { idPorPosicao, duplicadas } = resolverDuplicadas(existentes);

    const idsAlunos = [...new Set(alteracoes.map((a) => Number(a.aluno_id)))];
    const alunos = await model.alunosPorIds(db, idsAlunos);

    // Turmas novas e antigas: o turno da turma é gravado na matrícula e as
    // duas pontas entram no "de/para" da notificação.
    const idsTurmas = [
      ...new Set([
        ...alteracoes
          .map((a) => a.id_atividade)
          .filter(Boolean)
          .map(Number),
        ...existentes
          .map((m) => m.idatividades)
          .filter(Boolean)
          .map(Number),
      ]),
    ];
    const turmas = idsTurmas.length > 0 ? await model.turmasPorIds(db, idsTurmas) : [];

    const plano = planejar(alteracoes, {
      idPorPosicao,
      existentePorId: new Map(existentes.map((m) => [m.idmatricula, m])),
      alunoPorId: new Map(alunos.map((a) => [a.id, a])),
      turmaPorId: new Map(turmas.map((t) => [t.idatividades, t])),
    });

    if (plano.inserir.length > 0) await model.inserirVarias(db, plano.inserir, idInstituicao);
    const aEncerrar = [...new Set([...plano.encerrar, ...duplicadas])];
    if (aEncerrar.length > 0) await model.encerrarVarias(db, aEncerrar);
    if (plano.atualizar.length > 0) await model.trocarTurmas(db, plano.atualizar);

    const idsTocados = [
      ...new Set(
        alteracoes.map((a) => Number(a.aluno_id)).filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    await syncAlunoStatusFromMatriculas(db, idsTocados, idInstituicao);

    // Uma notificação-resumo por lote, não uma por célula. Usa a conexão da
    // transação: pedir outra ao pool travaria em produção (pool de 1 conexão).
    const total = plano.results.length;
    if (total > 0) {
      await criarNotificacao(
        {
          tipo: 'movimentacao',
          titulo: 'Grade ajustada em lote',
          mensagem: `${total} ${total === 1 ? 'alteração feita' : 'alterações feitas'} na grade (Ajuste de Grade).`,
          id_instituicao: idInstituicao,
          detalhes: plano.detalhes,
        },
        db,
      );
    }

    return {
      success: true,
      updated: total,
      results: plano.results,
      conflitos_turno: plano.conflitosTurno,
      duplicatas_resolvidas: duplicadas.length,
    };
  });
}

module.exports = { salvar, planejar, resolverDuplicadas };
