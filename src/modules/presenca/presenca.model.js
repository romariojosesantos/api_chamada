// SQL de presença (chamada) e de adições manuais à chamada.
const pool = require('../../config/database');

// Cláusula SQL pra "presença desse período" — um registro SEM período (de
// antes da coluna `periodo` existir, ver migrate-add-periodo-presenca.js)
// conta como fallback só quando o período consultado NÃO é 'noite'. Motivo:
// antes dessa coluna existir, a tela de Chamada nem tinha como fazer a
// chamada da noite separadamente — um registro antigo sem período, por
// definição, NUNCA pode ter sido da noite. Sem essa restrição, um aluno com
// presença antiga de outro turno aparecia "presente" na noite mesmo sem a
// chamada da noite ter sido feita ainda.
function condicaoPeriodo(periodo) {
  return periodo === 'noite'
    ? { sql: 'periodo = ?', params: [periodo] }
    : { sql: '(periodo = ? OR periodo IS NULL)', params: [periodo] };
}

// Histórico de presença, sem as datas marcadas como "sem aula" depois de já
// terem presença lançada (feriado cadastrado retroativamente).
async function listar({ data, dataInicio, dataFim, alunoId }, idInstituicao) {
  let sql = `
    SELECT p.aluno_id, a.nome, p.data, p.status, p.periodo, p.observacao
    FROM presenca p
    JOIN alunos a ON p.aluno_id = a.id
    WHERE p.id_instituicao = ?
      AND NOT EXISTS (
        SELECT 1 FROM dias_sem_aula d
        WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
      )
  `;
  const params = [idInstituicao, idInstituicao];
  if (data) {
    sql += ' AND DATE(p.data) = ?';
    params.push(data);
  } else if (dataInicio && dataFim) {
    sql += ' AND DATE(p.data) BETWEEN ? AND ?';
    params.push(dataInicio, dataFim);
  }
  if (alunoId) {
    sql += ' AND p.aluno_id = ?';
    params.push(alunoId);
  }
  sql += ' ORDER BY a.nome ASC, p.data DESC';
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function diaSemAula(data, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT id, motivo FROM dias_sem_aula WHERE data = ? AND id_instituicao = ?`,
    [data, idInstituicao],
  );
  return rows[0] || null;
}

// --- Gravação da chamada (dentro de transação: recebe a conexão `db`) ---

async function apagarDoPeriodo(db, alunoIds, data, periodo, idInstituicao) {
  const { sql: condPeriodo, params: paramsPeriodo } = condicaoPeriodo(periodo);
  await db.query(
    `
        DELETE FROM presenca
        WHERE aluno_id IN (${alunoIds.map(() => '?').join(',')})
        AND data = ?
        AND id_instituicao = ?
        AND ${condPeriodo}
      `,
    [...alunoIds, data, idInstituicao, ...paramsPeriodo],
  );
}

// Upsert: a chave única inclui `periodo` (ver migrate-add-periodo-presenca.js)
// — o mesmo aluno pode ter uma linha pro turno do dia e outra pro ensaio da
// noite, sem uma sobrescrever a outra.
async function gravarLote(db, linhas) {
  const [result] = await db.query(
    `
        INSERT INTO presenca (aluno_id, data, status, id_instituicao, observacao, periodo)
        VALUES ?
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          observacao = VALUES(observacao)
      `,
    [linhas],
  );
  return result.affectedRows;
}

// --- Finalizar chamada ---

// Alunos esperados num dia da semana/turno. `m.data_inicio <= data` é
// essencial: sem isso, um aluno matriculado DEPOIS da data sendo finalizada
// vira "esperado" pra um dia em que nem tinha matrícula e leva um 'ausente'
// incorreto. Filtra por `m.turno` (turno DA MATRÍCULA, não o atributo fixo do
// aluno): um aluno com matrícula dupla só é marcado ausente no turno em que
// ele de fato tem matrícula.
async function idsEsperados({ diaSemana, data, turno }, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT DISTINCT a.id
     FROM alunos a
     JOIN matricula m ON a.id = m.idaluno
     WHERE TRIM(m.dia_semana) = ?
       AND TRIM(LOWER(m.status)) = 'matriculado'
       AND m.data_fim IS NULL
       AND m.data_inicio <= ?
       AND a.id_instituicao = ?
       AND a.status = 'ativo'
       AND LOWER(TRIM(m.turno)) = LOWER(TRIM(?))`,
    [diaSemana, data, idInstituicao, turno],
  );
  return rows.map((r) => r.id);
}

async function idsComRegistro(data, periodo, idInstituicao) {
  const { sql: condPeriodo, params: paramsPeriodo } = condicaoPeriodo(periodo);
  const [rows] = await pool.query(
    `SELECT DISTINCT aluno_id FROM presenca WHERE data = ? AND id_instituicao = ? AND ${condPeriodo}`,
    [data, idInstituicao, ...paramsPeriodo],
  );
  return rows.map((r) => r.aluno_id);
}

// IGNORE é proposital: se duas pessoas finalizam quase ao mesmo tempo, as
// duas tentam inserir os mesmos alunos. Sem IGNORE, a segunda gravação falha
// com chave duplicada e a pessoa vê "erro de conexão" mesmo a chamada já
// finalizada pela outra; com IGNORE o MySQL só pula as linhas que já existem
// e affectedRows reflete só o que ESTA chamada inseriu.
async function inserirAusentes(linhas) {
  const [result] = await pool.query(
    `INSERT IGNORE INTO presenca (aluno_id, data, status, observacao, id_instituicao, periodo) VALUES ?`,
    [linhas],
  );
  return result.affectedRows;
}

// Dias até `dataFim` com turno que tem aluno esperado sem nenhum registro de
// presença no período (NULL só cobre manhã/tarde), ignorando dias sem aula.
async function pendenciasNoIntervalo(dataInicio, dataFim, idInstituicao) {
  const PERIODO_LABEL_SQL = `CASE
    WHEN LOWER(m.turno) LIKE '%manh%' THEN 'Manhã'
    WHEN LOWER(m.turno) LIKE '%tard%' THEN 'Tarde'
    WHEN LOWER(m.turno) LIKE '%noit%' THEN 'Noite'
  END`;
  const PERIODO_SQL = `CASE
    WHEN LOWER(m.turno) LIKE '%manh%' THEN 'manha'
    WHEN LOWER(m.turno) LIKE '%tard%' THEN 'tarde'
    WHEN LOWER(m.turno) LIKE '%noit%' THEN 'noite'
  END`;

  const [rows] = await pool.query(
    `WITH RECURSIVE datas AS (
       SELECT ? as data
       UNION ALL
       SELECT DATE_ADD(data, INTERVAL 1 DAY) FROM datas WHERE data < ?
     ),
     dias_letivos AS (
       SELECT data FROM datas
       WHERE NOT EXISTS (SELECT 1 FROM dias_sem_aula WHERE data = datas.data AND id_instituicao = ?)
     ),
     esperados AS (
       SELECT dl.data, a.id AS aluno_id, ${PERIODO_LABEL_SQL} AS turno, ${PERIODO_SQL} AS periodo
       FROM dias_letivos dl
       JOIN matricula m ON TRIM(m.dia_semana) = ELT(
           DAYOFWEEK(dl.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
         )
         AND dl.data >= m.data_inicio AND (m.data_fim IS NULL OR dl.data <= m.data_fim)
       JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
       WHERE m.status = 'matriculado'
     )
     SELECT e.data, e.turno, COUNT(DISTINCT e.aluno_id) AS pendentes
     FROM esperados e
     WHERE e.turno IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM presenca p
         WHERE p.aluno_id = e.aluno_id AND p.id_instituicao = ? AND DATE(p.data) = e.data
           AND (p.periodo = e.periodo OR (p.periodo IS NULL AND e.periodo <> 'noite'))
       )
     GROUP BY e.data, e.turno
     ORDER BY e.data DESC, e.turno`,
    [dataInicio, dataFim, idInstituicao, idInstituicao, idInstituicao],
  );
  return rows;
}

// --- Adições manuais ---

async function buscarAluno(alunoId, idInstituicao) {
  const [[aluno]] = await pool.query(
    'SELECT nome, transporte FROM alunos WHERE id = ? AND id_instituicao = ?',
    [alunoId, idInstituicao],
  );
  return aluno || null;
}

// Turnos das matrículas ativas do aluno num dia da semana.
async function turnosDoAlunoNoDia({ alunoId, diaSemana, data }, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT turno FROM matricula
     WHERE idaluno = ? AND id_instituicao = ? AND status = 'matriculado' AND data_fim IS NULL
       AND TRIM(dia_semana) = ? AND data_inicio <= ?`,
    [alunoId, idInstituicao, diaSemana, data],
  );
  return rows.map((r) => r.turno);
}

async function registrarAdicaoManual(adicao, idInstituicao) {
  await pool.query(
    `INSERT INTO adicoes_manuais_chamada
       (id_instituicao, aluno_id, data, turno_selecionado, transporte_selecionado, aluno_transporte, motivo_provavel)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      idInstituicao,
      adicao.alunoId,
      adicao.data,
      adicao.turno,
      adicao.transporte || null,
      adicao.alunoTransporte,
      adicao.motivoProvavel,
    ],
  );
}

async function adicoesManuaisDoMes(mes, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT am.id, am.aluno_id, a.nome AS aluno_nome, am.data, am.turno_selecionado,
       am.transporte_selecionado, am.aluno_transporte, am.motivo_provavel, am.criado_em
     FROM adicoes_manuais_chamada am
     JOIN alunos a ON a.id = am.aluno_id
     WHERE am.id_instituicao = ? AND DATE_FORMAT(am.data, '%Y-%m') = ?
     ORDER BY am.data DESC, a.nome ASC`,
    [idInstituicao, mes],
  );
  return rows;
}

module.exports = {
  listar,
  diaSemAula,
  apagarDoPeriodo,
  gravarLote,
  idsEsperados,
  idsComRegistro,
  inserirAusentes,
  pendenciasNoIntervalo,
  buscarAluno,
  turnosDoAlunoNoDia,
  registrarAdicaoManual,
  adicoesManuaisDoMes,
};
