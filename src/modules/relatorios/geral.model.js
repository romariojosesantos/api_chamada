// SQL dos resumos "no geral" (sem recorte de dia) e do histórico geral.
const pool = require('../../../db');
const { FORA_DE_DIA_SEM_AULA } = require('./sql-comum');

// Ativos sem nenhuma matrícula (nem histórica): ficha incompleta.
async function ativosSemMatricula(inst) {
  const [rows] = await pool.query(
    `SELECT a.id, a.nome, a.turno, a.turma, a.telefone
     FROM alunos a
     WHERE a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
       AND NOT EXISTS (SELECT 1 FROM matricula m WHERE m.idaluno = a.id)
     ORDER BY a.nome ASC`,
    [inst],
  );
  return rows;
}

// Alunos únicos com matrícula por área (um aluno com 2 turmas na mesma área
// conta uma vez). Com `data`, reconstrói a situação naquele dia; sem, é agora.
async function matriculasPorArea(inst, data) {
  const vigencia = data
    ? 'm.data_inicio <= ? AND (m.data_fim IS NULL OR m.data_fim >= ?)'
    : "m.status = 'matriculado' AND m.data_fim IS NULL";
  const [rows] = await pool.query(
    `SELECT COALESCE(atv.area, 'sem_area') AS area, COUNT(DISTINCT m.idaluno) AS total
     FROM matricula m
     JOIN atividades atv ON atv.idatividades = m.idatividades
     WHERE m.id_instituicao = ? AND ${vigencia}
     GROUP BY area`,
    data ? [inst, data, data] : [inst],
  );
  return rows;
}

// Quantos alunos em cada status, exceto 'ativo' (que tem card próprio).
async function alunosPorStatus(inst) {
  const [rows] = await pool.query(
    `SELECT COALESCE(status, 'sem_status') AS status, COUNT(*) AS total
     FROM alunos
     WHERE id_instituicao = ? AND excluido_em IS NULL AND (status IS NULL OR status != 'ativo')
     GROUP BY status`,
    [inst],
  );
  return rows;
}

// Antes da matrícula mais antiga não há como saber quem era esperado.
async function dataMaisAntigaConfiavel(inst) {
  const [[row]] = await pool.query(
    `SELECT MIN(data_inicio) AS dataMinimaConfiavel FROM matricula WHERE id_instituicao = ?`,
    [inst],
  );
  return row.dataMinimaConfiavel;
}

async function totalPresencasDesde(inst, desde) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM presenca p
     WHERE p.id_instituicao = ? AND p.status = 'presente' AND DATE(p.data) >= ?
       AND ${FORA_DE_DIA_SEM_AULA}`,
    [inst, desde, inst],
  );
  return row.total;
}

// Para cada dia com chamada: alunos esperados (matrícula) UNIÃO quem esteve
// presente mesmo fora do dia normal. Sem a união, a frequência passava de 100%.
async function oportunidadesDesde(inst, desde) {
  const [[row]] = await pool.query(
    `SELECT SUM(esperados_dia) AS total_oportunidades, COUNT(*) AS dias_letivos
     FROM (
       SELECT dia, COUNT(DISTINCT aluno_id) AS esperados_dia
       FROM (
         SELECT d.dia, a.id AS aluno_id
         FROM (
           SELECT DISTINCT DATE(p.data) AS dia
           FROM presenca p
           WHERE p.id_instituicao = ? AND DATE(p.data) >= ? AND ${FORA_DE_DIA_SEM_AULA}
         ) d
         JOIN matricula m ON TRIM(m.dia_semana) = ELT(
           DAYOFWEEK(d.dia), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
         ) AND m.status = 'matriculado'
           AND m.data_fim IS NULL
           AND m.data_inicio <= d.dia
         JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo'
         UNION
         SELECT DATE(p.data) AS dia, p.aluno_id
         FROM presenca p
         WHERE p.id_instituicao = ? AND p.status = 'presente' AND DATE(p.data) >= ?
           AND ${FORA_DE_DIA_SEM_AULA}
       ) pares
       GROUP BY dia
     ) sub`,
    [inst, desde, inst, inst, inst, desde, inst],
  );
  return row;
}

module.exports = {
  ativosSemMatricula,
  matriculasPorArea,
  alunosPorStatus,
  dataMaisAntigaConfiavel,
  totalPresencasDesde,
  oportunidadesDesde,
};
