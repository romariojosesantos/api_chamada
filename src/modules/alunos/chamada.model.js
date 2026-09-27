// Consultas da lista de chamada de um dia (GET /api/alunos/por-dia).
const pool = require('../../../db');
const { SUBQUERY_DIAS_MATRICULADOS } = require('./alunos.model');
const { periodoDoTurno } = require('./normalizacao');

async function buscarDiaSemAula(data, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT id, motivo FROM dias_sem_aula WHERE data = ? AND id_instituicao = ?`,
    [data, idInstituicao],
  );
  return rows[0] || null;
}

const CAMPOS_ALUNO = `
  SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status, a.telefone,
         a.acompanhamento, a.ponto, a.foto_url,
         ${SUBQUERY_DIAS_MATRICULADOS},
         p.status AS presenca_status, p.observacao AS presenca_obs
  FROM alunos a
  JOIN matricula m ON a.id = m.idaluno
`;

const JOIN_PROFESSOR = `
  JOIN atividades atv ON m.idatividades = atv.idatividades
  JOIN professores prof ON atv.idprofessor = prof.id
`;

// No máximo UMA linha de presença por aluno no dia/período. Com `turno`, só
// conta a presença daquele período: um aluno com turma de dia e ensaio à noite
// tem uma presença por período, e juntar as duas misturava os status.
// Registro sem período (legado) vale como fallback só para manhã/tarde.
// O separador '\x1F' existe porque SUBSTRING_INDEX com separador vazio sempre
// devolve ''.
function subqueryPresenca(data, turno, idInstituicao) {
  const periodo = periodoDoTurno(turno);
  const condicaoPeriodo = !turno
    ? ''
    : periodo === 'noite'
      ? 'AND periodo = ?'
      : 'AND (periodo IS NULL OR periodo = ?)';
  const sql = `
    (SELECT aluno_id,
       SUBSTRING_INDEX(GROUP_CONCAT(status ORDER BY (periodo IS NOT NULL) DESC SEPARATOR '\x1F'), '\x1F', 1) AS status,
       SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(observacao, '') ORDER BY (periodo IS NOT NULL) DESC SEPARATOR '\x1F'), '\x1F', 1) AS observacao
     FROM presenca
     WHERE DATE(data) = ? AND id_instituicao = ? ${condicaoPeriodo}
     GROUP BY aluno_id)
  `;
  return { sql, params: [data, idInstituicao, ...(turno ? [periodo] : [])] };
}

// Modo Relatório: todos os alunos ativos matriculados, com a presença do dia.
// Sem `turno` junta a presença direto, sem filtro de período.
function consultaModoRelatorio({ data, professor, turno }, idInstituicao) {
  const presenca = subqueryPresenca(data, turno, idInstituicao);
  const juncaoPresenca = turno
    ? `LEFT JOIN ${presenca.sql} p ON p.aluno_id = a.id`
    : `LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao`;
  const paramsJuncao = turno ? presenca.params : [data];

  const sql = `
    ${CAMPOS_ALUNO}
    ${professor ? JOIN_PROFESSOR : ''}
    ${juncaoPresenca}
    WHERE a.status = 'ativo'
    AND TRIM(LOWER(m.status)) = 'matriculado'
    AND m.data_fim IS NULL
    ${professor ? 'AND TRIM(prof.nome) = ?' : ''}
    AND a.id_instituicao = ?
    ORDER BY a.nome ASC
  `;
  const params = [...paramsJuncao, ...(professor ? [professor] : []), idInstituicao];
  return { sql, params };
}

// Modo Chamada: só quem tem matrícula no dia da semana da data. Filtra pelo
// turno DA MATRÍCULA (não do aluno), para quem tem ensaio em outro turno.
// `data_inicio <= data` evita que um aluno matriculado hoje apareça em
// chamadas de dias anteriores.
function consultaModoChamada({ data, diaSemana, professor, turno }, idInstituicao) {
  const presenca = subqueryPresenca(data, turno, idInstituicao);
  const sql = `
    ${CAMPOS_ALUNO}
    ${professor ? JOIN_PROFESSOR : ''}
    LEFT JOIN ${presenca.sql} p ON p.aluno_id = a.id
    WHERE TRIM(m.dia_semana) = ?
    AND a.status = 'ativo'
    AND TRIM(LOWER(m.status)) = 'matriculado'
    AND m.data_fim IS NULL
    AND m.data_inicio <= ?
    ${professor ? 'AND TRIM(prof.nome) = ?' : ''}
    AND a.id_instituicao = ?
    ${turno ? 'AND LOWER(m.turno) = LOWER(?)' : ''}
    ORDER BY a.nome ASC
  `;
  const params = [
    ...presenca.params,
    diaSemana,
    data,
    ...(professor ? [professor] : []),
    idInstituicao,
    ...(turno ? [turno] : []),
  ];
  return { sql, params };
}

async function listarPorDia(filtros, idInstituicao) {
  const { sql, params } = filtros.modoRelatorio
    ? consultaModoRelatorio(filtros, idInstituicao)
    : consultaModoChamada(filtros, idInstituicao);
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = { buscarDiaSemAula, listarPorDia };
