// SQL do relatório de um único dia. "Esperado" = matrícula ativa para aquele
// dia da semana, iniciada até a data (senão quem foi matriculado hoje
// apareceria como ausente em dias passados).
const pool = require('../../../db');
const { CONDICAO_PERIODO } = require('./sql-comum');

async function diaSemAula(data, inst) {
  const [rows] = await pool.query(
    `SELECT id, motivo FROM dias_sem_aula WHERE data = ? AND id_instituicao = ?`,
    [data, inst],
  );
  return rows[0] || null;
}

// Alunos ativos esperados no dia, com a presença do período certo (se houver).
const ESPERADOS_DO_DIA = `
  FROM alunos a
  JOIN matricula m ON a.id = m.idaluno AND TRIM(m.dia_semana) = ? AND m.status = 'matriculado'
    AND m.data_fim IS NULL AND m.data_inicio <= ?
  LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
    AND ${CONDICAO_PERIODO}
  WHERE a.id_instituicao = ? AND a.status = 'ativo'`;

// Turno da presença (p.periodo) e, em registros antigos sem período, o do aluno.
const TURNO_DA_PRESENCA = `CASE p.periodo
    WHEN 'manha' THEN 'Manhã'
    WHEN 'tarde' THEN 'Tarde'
    WHEN 'noite' THEN 'Noite'
    ELSE COALESCE(NULLIF(TRIM(a.turno), ''), 'Não Definido')
  END`;

// Todas em paralelo; só agregados, sem trazer registros um a um.
async function consultasDoDia(data, diaSemana, inst) {
  const esperados = [diaSemana, data, data, inst];
  const resultados = await Promise.all([
    pool.query(
      "SELECT COUNT(*) as total FROM alunos WHERE id_instituicao = ? AND status = 'ativo' AND excluido_em IS NULL",
      [inst],
    ),
    // Por turno DA MATRÍCULA: quem tem turma de dia e ensaio à noite conta nos dois.
    pool.query(
      `SELECT m.turno,
         COUNT(DISTINCT a.id) AS esperados,
         COUNT(DISTINCT CASE WHEN p.status = 'presente' THEN a.id END) AS presentes
       ${ESPERADOS_DO_DIA}
       GROUP BY m.turno`,
      esperados,
    ),
    // Por transporte do aluno e turno da matrícula.
    pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(a.transporte), ''), 'Não Definido') AS transporte,
         COALESCE(NULLIF(TRIM(m.turno), ''), 'Não Definido') AS turno,
         COUNT(DISTINCT a.id) AS esperados,
         COUNT(DISTINCT CASE WHEN p.status = 'presente' THEN a.id END) AS presentes
       ${ESPERADOS_DO_DIA}
       GROUP BY transporte, turno`,
      esperados,
    ),
    // Ausentes: esperados sem presença NAQUELE período.
    pool.query(
      `SELECT COUNT(DISTINCT CONCAT(a.id, '|', m.turno)) AS total
       ${ESPERADOS_DO_DIA}
         AND (p.status IS NULL OR p.status != 'presente')`,
      esperados,
    ),
    pool.query(
      `SELECT
         COALESCE(p.observacao, 'Sem justificativa') AS justificativa,
         COUNT(DISTINCT CONCAT(a.id, '|', m.turno)) AS quantidade
       ${ESPERADOS_DO_DIA}
         AND (p.status IS NULL OR p.status != 'presente')
       GROUP BY p.observacao`,
      esperados,
    ),
    // Presenças registradas no dia, com ou sem matrícula.
    pool.query(
      `SELECT COUNT(*) as total
       FROM presenca
       WHERE id_instituicao = ? AND DATE(data) = ? AND status = 'presente'`,
      [inst, data],
    ),
    pool.query(
      `SELECT p.id, p.aluno_id, a.nome as aluno_nome, p.status, p.observacao, p.data
       FROM presenca p
       LEFT JOIN alunos a ON p.aluno_id = a.id
       WHERE p.id_instituicao = ? AND DATE(p.data) = ? AND p.status = 'presente'
       ORDER BY a.nome ASC`,
      [inst, data],
    ),
    // Presença real (com ou sem matrícula no dia) por turno e transporte.
    pool.query(
      `SELECT
         ${TURNO_DA_PRESENCA} AS turno,
         COALESCE(NULLIF(TRIM(a.transporte), ''), 'Não Definido') AS transporte,
         COUNT(DISTINCT p.aluno_id) AS presentes_reais
       FROM presenca p
       JOIN alunos a ON p.aluno_id = a.id
       WHERE p.id_instituicao = ? AND DATE(p.data) = ? AND p.status = 'presente'
       GROUP BY ${TURNO_DA_PRESENCA}, transporte`,
      [inst, data],
    ),
    // Alunos únicos com falta justificada (status 'justificado', não só observação).
    pool.query(
      `SELECT COUNT(DISTINCT p.aluno_id) as total
       FROM presenca p
       WHERE p.id_instituicao = ? AND DATE(p.data) = ? AND p.status = 'justificado'`,
      [inst, data],
    ),
    pool.query(
      `SELECT COUNT(*) as total
       FROM alunos a
       WHERE a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
         AND NOT EXISTS (SELECT 1 FROM matricula m WHERE m.idaluno = a.id)`,
      [inst],
    ),
  ]);

  const [
    ativos,
    porTurno,
    porTransporte,
    ausentes,
    justificativas,
    totalRegistradas,
    listaRegistradas,
    presencaReal,
    justificados,
    semMatricula,
  ] = resultados.map(([rows]) => rows);
  return {
    totalAtivos: ativos[0].total,
    porTurno,
    porTransporte,
    totalAusentes: ausentes[0].total,
    justificativas,
    totalRegistradas: totalRegistradas[0].total,
    listaRegistradas,
    presencaReal,
    totalJustificados: justificados[0].total,
    totalSemMatricula: semMatricula[0].total,
  };
}

module.exports = { diaSemAula, consultasDoDia };
