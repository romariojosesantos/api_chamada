// SQL dos relatórios por período (intervalo de datas e visão mensal).
const pool = require('../../../db');
const { CTE_DIAS_LETIVOS, JOIN_MATRICULA_DO_DIA, FORA_DE_DIA_SEM_AULA } = require('./sql-comum');

const ALUNO_ATIVO = `JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL`;

async function diasLetivos(inst, inicio, fim) {
  const [rows] = await pool.query(`${CTE_DIAS_LETIVOS} SELECT data FROM dias_letivos`, [
    inicio,
    fim,
    inst,
  ]);
  return rows;
}

// Alunos únicos com presença no período.
const presentesAlunos = (inst, inicio, fim) =>
  pool.query(
    `SELECT COUNT(DISTINCT p.aluno_id) as total
     FROM presenca p
     WHERE p.id_instituicao = ? AND p.status = 'presente' AND DATE(p.data) BETWEEN ? AND ?
       AND ${FORA_DE_DIA_SEM_AULA}`,
    [inst, inicio, fim, inst],
  );

// Registros de presença (um por aluno por dia).
const presentesRegistros = (inst, inicio, fim) =>
  pool.query(
    `SELECT COUNT(*) as total
     FROM presenca p
     WHERE p.id_instituicao = ? AND p.status = 'presente' AND DATE(p.data) BETWEEN ? AND ?
       AND ${FORA_DE_DIA_SEM_AULA}`,
    [inst, inicio, fim, inst],
  );

// Alunos matriculados para ter aula em algum dia letivo do período.
const esperadosAlunos = (inst, inicio, fim) =>
  pool.query(
    `${CTE_DIAS_LETIVOS}
     SELECT COUNT(DISTINCT a.id) as total
     FROM dias_letivos d
     ${JOIN_MATRICULA_DO_DIA}
     ${ALUNO_ATIVO}`,
    [inicio, fim, inst, inst],
  );

// Soma, dia a dia, dos alunos esperados (base das faltas "por registro").
// Não comparar data_inicio com '0000-00-00': o modo estrito do MySQL rejeita.
const esperadosRegistros = (inst, inicio, fim) =>
  pool.query(
    `${CTE_DIAS_LETIVOS},
     esperados_por_dia AS (
       SELECT d.data, COUNT(DISTINCT a.id) as esperados
       FROM dias_letivos d
       ${JOIN_MATRICULA_DO_DIA}
       ${ALUNO_ATIVO}
       GROUP BY d.data
     )
     SELECT COALESCE(SUM(esperados), 0) as total FROM esperados_por_dia`,
    [inicio, fim, inst, inst],
  );

// Justificativas por tipo (registros: cada lançamento conta).
const justificativasPorTipo = (inst, inicio, fim) =>
  pool.query(
    `SELECT COALESCE(p.observacao, 'Sem justificativa') AS justificativa, COUNT(*) AS quantidade
     FROM presenca p
     WHERE p.id_instituicao = ? AND p.status != 'presente' AND DATE(p.data) BETWEEN ? AND ?
       AND ${FORA_DE_DIA_SEM_AULA}
     GROUP BY p.observacao`,
    [inst, inicio, fim, inst],
  );

// Alunos únicos com pelo menos uma falta justificada.
const justificadosAlunos = (inst, inicio, fim) =>
  pool.query(
    `SELECT COUNT(DISTINCT p.aluno_id) as total
     FROM presenca p
     WHERE p.id_instituicao = ? AND p.status = 'justificado' AND DATE(p.data) BETWEEN ? AND ?
       AND ${FORA_DE_DIA_SEM_AULA}`,
    [inst, inicio, fim, inst],
  );

// Esperados e presentes em cada dia letivo (gráfico de frequência).
async function tendenciaDiaria(inst, inicio, fim) {
  const [rows] = await pool.query(
    `${CTE_DIAS_LETIVOS},
     esperados_por_dia AS (
       SELECT d.data, COUNT(DISTINCT a.id) as esperados
       FROM dias_letivos d
       ${JOIN_MATRICULA_DO_DIA}
       ${ALUNO_ATIVO}
       GROUP BY d.data
     ),
     presentes_por_dia AS (
       SELECT DATE(p.data) as data, COUNT(DISTINCT p.aluno_id) as presentes
       FROM presenca p
       WHERE p.id_instituicao = ? AND p.status = 'presente' AND DATE(p.data) BETWEEN ? AND ?
       GROUP BY DATE(p.data)
     )
     SELECT dl.data, COALESCE(ep.esperados, 0) as esperados, COALESCE(pp.presentes, 0) as presentes
     FROM dias_letivos dl
     LEFT JOIN esperados_por_dia ep ON ep.data = dl.data
     LEFT JOIN presentes_por_dia pp ON pp.data = dl.data
     ORDER BY dl.data`,
    [inicio, fim, inst, inst, inst, inicio, fim],
  );
  return rows;
}

// A mesma série por área da turma. Só conta presença de quem tinha matrícula
// naquela área no dia, então nunca passa de 100%.
async function tendenciaPorArea(inst, inicio, fim) {
  const [rows] = await pool.query(
    `${CTE_DIAS_LETIVOS},
     esperados_por_dia_area AS (
       SELECT d.data, atv.area, COUNT(DISTINCT a.id) as esperados
       FROM dias_letivos d
       ${JOIN_MATRICULA_DO_DIA}
       JOIN atividades atv ON atv.idatividades = m.idatividades
       ${ALUNO_ATIVO}
       GROUP BY d.data, atv.area
     ),
     presentes_por_dia_area AS (
       SELECT d.data, atv.area, COUNT(DISTINCT p.aluno_id) as presentes
       FROM dias_letivos d
       ${JOIN_MATRICULA_DO_DIA}
       JOIN atividades atv ON atv.idatividades = m.idatividades
       JOIN presenca p ON p.aluno_id = m.idaluno AND DATE(p.data) = d.data AND p.status = 'presente' AND p.id_instituicao = ?
       GROUP BY d.data, atv.area
     )
     SELECT e.data, e.area, e.esperados, COALESCE(pr.presentes, 0) as presentes
     FROM esperados_por_dia_area e
     LEFT JOIN presentes_por_dia_area pr ON pr.data = e.data AND pr.area = e.area
     ORDER BY e.data, e.area`,
    [inicio, fim, inst, inst, inst],
  );
  return rows;
}

// Frequência de cada aluno. "Esperados" junta os dias com matrícula E os dias
// em que ele esteve presente fora do dia normal (a Chamada permite marcar
// presença avulsa): sem essa união a frequência passava de 100%.
async function frequenciaPorAluno(inst, inicio, fim) {
  const [rows] = await pool.query(
    `${CTE_DIAS_LETIVOS},
     oportunidades_por_aluno AS (
       SELECT a.id AS aluno_id, d.data
       FROM dias_letivos d
       ${JOIN_MATRICULA_DO_DIA}
       JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ?
       UNION
       SELECT p.aluno_id, DATE(p.data)
       FROM presenca p
       JOIN dias_letivos d ON d.data = DATE(p.data)
       WHERE p.id_instituicao = ? AND p.status = 'presente'
     ),
     esperados_por_aluno AS (
       SELECT aluno_id, COUNT(DISTINCT data) AS dias_esperados
       FROM oportunidades_por_aluno
       GROUP BY aluno_id
     ),
     presentes_por_aluno AS (
       SELECT p.aluno_id, COUNT(DISTINCT DATE(p.data)) AS dias_presentes
       FROM presenca p
       WHERE p.id_instituicao = ? AND p.status = 'presente' AND DATE(p.data) BETWEEN ? AND ?
       GROUP BY p.aluno_id
     )
     SELECT ep.aluno_id, a.nome, ep.dias_esperados, COALESCE(pp.dias_presentes, 0) AS dias_presentes
     FROM esperados_por_aluno ep
     JOIN alunos a ON a.id = ep.aluno_id AND a.status = 'ativo' AND a.excluido_em IS NULL
     LEFT JOIN presentes_por_aluno pp ON pp.aluno_id = ep.aluno_id
     ORDER BY a.nome ASC`,
    [inicio, fim, inst, inst, inst, inst, inicio, fim],
  );
  return rows;
}

// Alunos únicos com qualquer falta (justificada ou não).
async function alunosComFalta(inst, inicio, fim) {
  const [rows] = await pool.query(
    `SELECT COUNT(DISTINCT p.aluno_id) as total
     FROM presenca p
     WHERE p.id_instituicao = ? AND p.status IN ('ausente', 'justificado') AND DATE(p.data) BETWEEN ? AND ?
       AND ${FORA_DE_DIA_SEM_AULA}`,
    [inst, inicio, fim, inst],
  );
  return rows[0].total || 0;
}

// Uma linha por aluno esperado por dia, com o status da presença (ou NULL):
// base para contar faltas seguidas.
async function presencaDiaADia(inst, inicio, fim) {
  const [rows] = await pool.query(
    `${CTE_DIAS_LETIVOS},
     esperado_dia_aluno AS (
       SELECT DISTINCT d.data, a.id AS aluno_id
       FROM dias_letivos d
       ${JOIN_MATRICULA_DO_DIA}
       ${ALUNO_ATIVO}
     ),
     presenca_dia AS (
       SELECT aluno_id, DATE(data) as data, status
       FROM presenca
       WHERE id_instituicao = ? AND DATE(data) BETWEEN ? AND ?
     )
     SELECT eda.aluno_id, eda.data, pd.status
     FROM esperado_dia_aluno eda
     LEFT JOIN presenca_dia pd ON pd.aluno_id = eda.aluno_id AND pd.data = eda.data
     ORDER BY eda.aluno_id, eda.data`,
    [inicio, fim, inst, inst, inst, inicio, fim],
  );
  return rows;
}

module.exports = {
  diasLetivos,
  presentesAlunos,
  presentesRegistros,
  esperadosAlunos,
  esperadosRegistros,
  justificativasPorTipo,
  justificadosAlunos,
  tendenciaDiaria,
  tendenciaPorArea,
  frequenciaPorAluno,
  alunosComFalta,
  presencaDiaADia,
};
