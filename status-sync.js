// Mantém alunos.status coerente com a realidade das matrículas: um aluno é
// "ativo" se tiver pelo menos uma matrícula corrente (data_fim NULL, status
// 'matriculado'), senão é "inativo". Chamado depois de qualquer operação que
// cria/encerra matrículas em lote (import de Excel, ajuste de grade), para que o
// status não fique desatualizado manualmente.
//
// Exceção: "espera" (aluno na fila esperando vaga, sem matrícula ainda) é um
// estado deliberado, não derivado de matrícula — ganhar uma matrícula promove
// ele pra "ativo" normalmente, mas a AUSÊNCIA de matrícula não pode rebaixar
// "espera" pra "inativo" sozinha (senão toda sincronização em lote apagaria a
// fila de espera). Só um PATCH manual tira alguém de "espera".

const { podeMatricular } = require('./regras-matricula');

function resolveAlunoStatus(temMatriculaAtiva) {
  return temMatriculaAtiva ? 'ativo' : 'inativo';
}

// Encerra as matrículas ATIVAS do aluno que ficaram incompatíveis com o
// `novoTurno` dele — chamado sempre que `alunos.turno` muda (edição de
// cadastro, PATCH rápido, ou import em massa). Usa a MESMA regra de
// compatibilidade (`podeMatricular`) já aplicada ao criar uma matrícula nova:
// turma do mesmo turno, OU turma de ensaio (turno "Noite" — sempre permitido,
// porque um ensaio pode ter tanto alunos de Manhã quanto de Tarde ao mesmo
// tempo; não é exclusivo de um turno como as turmas comuns são pro aluno).
// Sem isso, a matrícula antiga simplesmente nunca é revisitada e fica aberta
// pra sempre, mesmo o aluno não frequentando mais aquele turno (bug real
// encontrado em produção — ver Mayza/Yanne).
async function encerrarMatriculasForaDoTurno(connection, idAluno, novoTurno, idInstituicao) {
  if (!novoTurno) return { encerradas: 0, turmas: [] };

  const [ativas] = await connection.query(
    `SELECT m.idmatricula, atv.turno AS turno_turma, atv.nome AS nome_turma
     FROM matricula m
     JOIN atividades atv ON atv.idatividades = m.idatividades
     WHERE m.idaluno = ? AND m.id_instituicao = ? AND m.status = 'matriculado' AND m.data_fim IS NULL`,
    [idAluno, idInstituicao]
  );

  const incompativeis = ativas.filter(m => !podeMatricular(novoTurno, m.turno_turma));
  if (incompativeis.length === 0) return { encerradas: 0, turmas: [] };

  await connection.query(
    `UPDATE matricula SET data_fim = CURDATE(), status = 'cancelada' WHERE idmatricula IN (?)`,
    [incompativeis.map(m => m.idmatricula)]
  );

  return { encerradas: incompativeis.length, turmas: incompativeis.map(m => m.nome_turma) };
}

// Encerra TODAS as matrículas ativas do aluno quando o status dele deixa de
// ser 'ativo' (ex.: "espera", "inativo") — matrícula só faz sentido pra aluno
// ativo. Diferente de `encerrarMatriculasForaDoTurno`, aqui não há filtro por
// turno: se o status não é ativo, toda matrícula corrente é encerrada.
async function encerrarMatriculasSeNaoAtivo(connection, idAluno, novoStatus, idInstituicao) {
  const statusNormalizado = String(novoStatus || '').trim().toLowerCase();
  if (statusNormalizado === 'ativo') return { encerradas: 0, turmas: [] };

  const [ativas] = await connection.query(
    `SELECT m.idmatricula, atv.nome AS nome_turma
     FROM matricula m
     JOIN atividades atv ON atv.idatividades = m.idatividades
     WHERE m.idaluno = ? AND m.id_instituicao = ? AND m.status = 'matriculado' AND m.data_fim IS NULL`,
    [idAluno, idInstituicao]
  );

  if (ativas.length === 0) return { encerradas: 0, turmas: [] };

  await connection.query(
    `UPDATE matricula SET data_fim = CURDATE(), status = 'cancelada' WHERE idmatricula IN (?)`,
    [ativas.map(m => m.idmatricula)]
  );

  return { encerradas: ativas.length, turmas: ativas.map(m => m.nome_turma) };
}

// Recalcula e grava o status de cada aluno em `alunoIds` com base em suas
// matrículas atuais. Roda dentro da mesma transação/conexão de quem chama, para
// que a sincronização faça parte da mesma operação atômica.
async function syncAlunoStatusFromMatriculas(connection, alunoIds, idInstituicao) {
  const uniqueAlunoIds = [...new Set((alunoIds || [])
    .map(id => Number(id))
    .filter(id => Number.isInteger(id) && id > 0))];

  if (uniqueAlunoIds.length === 0) {
    return { atualizado: 0, ids: [] };
  }

  const placeholders = uniqueAlunoIds.map(() => '?').join(',');
  const [rows] = await connection.query(
    `
      SELECT a.id,
             CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM matricula m
                 WHERE m.idaluno = a.id
                   AND m.id_instituicao = a.id_instituicao
                   AND m.data_fim IS NULL
                   AND TRIM(LOWER(m.status)) = 'matriculado'
               ) THEN 'ativo'
               WHEN TRIM(LOWER(a.status)) = 'espera' THEN 'espera'
               ELSE 'inativo'
             END AS novo_status
      FROM alunos a
      WHERE a.id IN (${placeholders})
        AND a.id_instituicao = ?
    `,
    [...uniqueAlunoIds, idInstituicao]
  );

  if (!rows.length) {
    return { atualizado: 0, ids: [] };
  }

  const ids = rows.map(row => row.id);
  const valoresStatus = rows.map(row => row.novo_status);
  // Bulk update via CASE WHEN em vez de um UPDATE por aluno, para não fazer N idas ao banco.
  const caseWhen = rows.map(row => `WHEN ${row.id} THEN ?`).join(' ');

  if (!caseWhen) {
    return { atualizado: 0, ids: [] };
  }

  await connection.query(
    `
      UPDATE alunos
      SET status = CASE id ${caseWhen} END
      WHERE id IN (${ids.map(() => '?').join(',')})
        AND id_instituicao = ?
    `,
    [...valoresStatus, ...ids, idInstituicao]
  );

  return {
    atualizado: rows.length,
    ids
  };
}

module.exports = {
  resolveAlunoStatus,
  syncAlunoStatusFromMatriculas,
  encerrarMatriculasForaDoTurno,
  encerrarMatriculasSeNaoAtivo
};
