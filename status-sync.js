// Mantém alunos.status coerente com a realidade das matrículas: um aluno é
// "ativo" se tiver pelo menos uma matrícula corrente (data_fim NULL, status
// 'matriculado'), senão é "inativo". Chamado depois de qualquer operação que
// cria/encerra matrículas em lote (import de Excel, ajuste de grade), para que o
// status não fique desatualizado manualmente.

function resolveAlunoStatus(temMatriculaAtiva) {
  return temMatriculaAtiva ? 'ativo' : 'inativo';
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
  syncAlunoStatusFromMatriculas
};
