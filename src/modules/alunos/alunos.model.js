// SQL do cadastro de alunos. As funções que escrevem recebem `db` (pool ou a
// conexão de uma transação) para poderem participar de uma transação maior.
const pool = require('../../../db');

// Dias da semana com matrícula ativa do aluno (ex.: "Segunda,Quarta").
const SUBQUERY_DIAS_MATRICULADOS = `
  IFNULL((SELECT GROUP_CONCAT(DISTINCT TRIM(m2.dia_semana) SEPARATOR ',')
   FROM matricula m2
   WHERE m2.idaluno = a.id AND m2.status = 'matriculado' AND m2.data_fim IS NULL AND m2.id_instituicao = a.id_instituicao), '') as dias_matriculados
`;

// Nível atual = registro de aluno_niveis ainda aberto (data_fim NULL).
// Subqueries em vez de JOIN para não duplicar o aluno se houver dois abertos.
const SUBQUERY_NIVEL_ATUAL = `
  (SELECT an.nivel FROM aluno_niveis an
   WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL
   ORDER BY an.data_inicio DESC LIMIT 1) as nivel,
  (SELECT an.subnivel FROM aluno_niveis an
   WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL
   ORDER BY an.data_inicio DESC LIMIT 1) as subnivel
`;

// Observações de saúde concatenadas, só para exibição em lista.
const SUBQUERY_SAUDE = `
  IFNULL((SELECT GROUP_CONCAT(descricao SEPARATOR '; ')
   FROM aluno_saude
   WHERE id_aluno = a.id AND id_instituicao = a.id_instituicao), '') as saude
`;

// --- Consultas ---

// Com `nome`, os outros filtros são ignorados: a busca por nome acha o aluno
// em qualquer status (útil para encontrar inativos).
async function listar({ nome, turno, transporte, status }, idInstituicao) {
  let sql = `
    SELECT a.id, a.nome, a.data_nascimento, a.data_cadastro, a.criado_em, a.sexo, a.telefone,
           a.turma, a.turno, a.transporte, a.status, a.inativado_em, a.Inf,
           a.acompanhamento, a.ponto, a.informacoes_gerais, a.escola_atual, a.foto_url,
           ${SUBQUERY_DIAS_MATRICULADOS},
           ${SUBQUERY_NIVEL_ATUAL},
           ${SUBQUERY_SAUDE}
    FROM alunos a
    WHERE a.id_instituicao = ? AND a.excluido_em IS NULL
  `;
  const params = [idInstituicao];

  if (nome && nome.trim() !== '') {
    sql += ' AND a.nome LIKE ?';
    params.push(`%${nome.trim()}%`);
  } else {
    if (status === 'todos') {
      /* sem filtro de status */
    } else if (status) {
      sql += ' AND a.status = ?';
      params.push(status);
    } else {
      sql += " AND a.status = 'ativo'";
    }

    if (turno && turno !== 'Todos') {
      sql += ' AND TRIM(a.turno) = ?';
      params.push(turno);
    }
    if (transporte && transporte !== 'Todos') {
      sql += ' AND TRIM(a.transporte) = ?';
      params.push(transporte);
    }
  }

  sql += ' ORDER BY a.nome ASC';
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function telefones(ids, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT a.id, a.telefone AS telefone_aluno, rl.telefone AS telefone_responsavel
     FROM alunos a
     LEFT JOIN responsavel_legal rl ON rl.id_aluno = a.id
     WHERE a.id IN (?) AND a.id_instituicao = ?`,
    [ids, idInstituicao],
  );
  return rows;
}

async function listarExcluidos(idInstituicao) {
  const [rows] = await pool.query(
    `SELECT a.id, a.nome, a.excluido_em, u.nome AS excluido_por_nome,
            ${SUBQUERY_NIVEL_ATUAL}
     FROM alunos a
     LEFT JOIN usuarios u ON u.id = a.excluido_por
     WHERE a.id_instituicao = ? AND a.excluido_em IS NOT NULL
     ORDER BY a.excluido_em DESC`,
    [idInstituicao],
  );
  return rows;
}

async function buscarPorId(id, idInstituicao) {
  const [rows] = await pool.query(
    `SELECT id, nome, data_nascimento, data_cadastro, criado_em, sexo, telefone, turma, turno, transporte, status, Inf,
            acompanhamento, ponto, informacoes_gerais, escola_atual, foto_url
     FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL`,
    [id, idInstituicao],
  );
  return rows[0] || null;
}

async function existe(id, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT id FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [id, idInstituicao],
  );
  return rows.length > 0;
}

async function buscarFoto(id, idInstituicao) {
  const [[aluno]] = await pool.query(
    'SELECT id, foto_url FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [id, idInstituicao],
  );
  return aluno || null;
}

async function buscarNaLixeira(id, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT nome FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NOT NULL',
    [id, idInstituicao],
  );
  return rows[0] || null;
}

async function historicoNiveis(id, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT id, nivel, subnivel, data_inicio, data_fim FROM aluno_niveis WHERE id_aluno = ? AND id_instituicao = ? ORDER BY data_inicio DESC',
    [id, idInstituicao],
  );
  return rows;
}

async function situacaoAnual(id, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT id, ano, situacao_matricula, situacao_divida FROM aluno_situacao_anual WHERE id_aluno = ? AND id_instituicao = ? ORDER BY ano DESC',
    [id, idInstituicao],
  );
  return rows;
}

async function observacoesSaude(id, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT id, descricao, created_at FROM aluno_saude WHERE id_aluno = ? AND id_instituicao = ? ORDER BY created_at DESC',
    [id, idInstituicao],
  );
  return rows;
}

async function responsavel(id, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT id, nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone FROM responsavel_legal WHERE id_aluno = ? AND id_instituicao = ?',
    [id, idInstituicao],
  );
  return rows[0] || null;
}

async function listarTransportes(idInstituicao) {
  const [rows] = await pool.query(
    `SELECT DISTINCT TRIM(transporte) AS transporte
     FROM alunos
     WHERE id_instituicao = ? AND transporte IS NOT NULL AND TRIM(transporte) != ''
     ORDER BY transporte ASC`,
    [idInstituicao],
  );
  return rows.map((r) => r.transporte).filter(Boolean);
}

async function ativosComNivel(idInstituicao) {
  const [rows] = await pool.query(
    `SELECT a.id, a.nome, a.turno, ${SUBQUERY_NIVEL_ATUAL}
     FROM alunos a WHERE a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL`,
    [idInstituicao],
  );
  return rows;
}

async function ocorrenciasNoPeriodo(idInstituicao, inicio, fim) {
  const [rows] = await pool.query(
    `SELECT id_aluno, gravidade, percentual_aplicado, descricao, data_ocorrencia
     FROM aluno_ocorrencias
     WHERE id_instituicao = ? AND excluido_em IS NULL AND data_ocorrencia BETWEEN ? AND ?`,
    [idInstituicao, inicio, fim],
  );
  return rows;
}

// --- Escrita ---

async function inserir(db, a, idInstituicao) {
  const [result] = await db.query(
    `INSERT INTO alunos (nome, data_nascimento, data_cadastro, sexo, telefone, turma, turno, transporte, Inf, acompanhamento, ponto, informacoes_gerais, escola_atual, status, id_instituicao, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.nome,
      a.data_nascimento,
      a.data_cadastro,
      a.sexo,
      a.telefone,
      a.turma,
      a.turno,
      a.transporte,
      a.Inf,
      a.acompanhamento,
      a.ponto,
      a.informacoes_gerais,
      a.escola_atual,
      a.status,
      idInstituicao,
      a.criado_em,
    ],
  );
  return result.insertId;
}

async function buscarTurnoEStatus(db, id, idInstituicao) {
  const [[aluno]] = await db.query(
    'SELECT turno, status FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [id, idInstituicao],
  );
  return aluno;
}

// Devolve quantas linhas foram alteradas (0 = aluno não encontrado).
async function atualizar(db, id, a, idInstituicao) {
  const [result] = await db.query(
    `UPDATE alunos SET nome=?, data_nascimento=?, data_cadastro=?, sexo=?, telefone=?, turma=?, turno=?, transporte=?, Inf=?,
       acompanhamento=?, ponto=?, informacoes_gerais=?, escola_atual=?, status=?
     WHERE id=? AND id_instituicao=? AND excluido_em IS NULL`,
    [
      a.nome,
      a.data_nascimento,
      a.data_cadastro,
      a.sexo,
      a.telefone,
      a.turma,
      a.turno,
      a.transporte,
      a.Inf,
      a.acompanhamento,
      a.ponto,
      a.informacoes_gerais,
      a.escola_atual,
      a.status,
      id,
      idInstituicao,
    ],
  );
  return result.affectedRows;
}

async function buscarStatusENome(id, idInstituicao) {
  const [[aluno]] = await pool.query(
    'SELECT status, nome FROM alunos WHERE id = ? AND id_instituicao = ?',
    [id, idInstituicao],
  );
  return aluno;
}

async function buscarTurno(id, idInstituicao) {
  const [[aluno]] = await pool.query(
    'SELECT turno FROM alunos WHERE id = ? AND id_instituicao = ?',
    [id, idInstituicao],
  );
  return aluno;
}

// `campo` precisa vir de uma whitelist (é identificador SQL, via ??).
async function atualizarCampo(id, campo, valor, idInstituicao) {
  const [result] = await pool.query(
    'UPDATE alunos SET ?? = ? WHERE id = ? AND id_instituicao = ?',
    [campo, valor, id, idInstituicao],
  );
  return result.affectedRows;
}

async function marcarInativadoHoje(id, idInstituicao) {
  await pool.query(
    'UPDATE alunos SET inativado_em = CURDATE() WHERE id = ? AND id_instituicao = ?',
    [id, idInstituicao],
  );
}

async function limparInativadoEm(id, idInstituicao) {
  await pool.query('UPDATE alunos SET inativado_em = NULL WHERE id = ? AND id_instituicao = ?', [
    id,
    idInstituicao,
  ]);
}

async function moverParaLixeira(db, id, idUsuario, idInstituicao) {
  const [result] = await db.query(
    'UPDATE alunos SET excluido_em = NOW(), excluido_por = ? WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [idUsuario, id, idInstituicao],
  );
  return result.affectedRows;
}

async function encerrarMatriculasAtivas(db, id, idInstituicao) {
  await db.query(
    `UPDATE matricula SET data_fim = CURDATE(), status = 'cancelada' WHERE idaluno = ? AND id_instituicao = ? AND data_fim IS NULL`,
    [id, idInstituicao],
  );
}

async function restaurar(id, idInstituicao) {
  const [result] = await pool.query(
    'UPDATE alunos SET excluido_em = NULL, excluido_por = NULL WHERE id = ? AND id_instituicao = ? AND excluido_em IS NOT NULL',
    [id, idInstituicao],
  );
  return result.affectedRows;
}

// Apaga de vez: as FKs com ON DELETE CASCADE levam junto tudo que é do aluno.
async function excluirDefinitivamente(id, idInstituicao) {
  await pool.query('DELETE FROM alunos WHERE id = ? AND id_instituicao = ?', [id, idInstituicao]);
}

// Lança ER_DUP_ENTRY se o código já pertencer a outro aluno.
async function salvarCodigoAcesso(id, codigo) {
  const [result] = await pool.query('UPDATE alunos SET codigo_acesso = ? WHERE id = ?', [
    codigo,
    id,
  ]);
  return result.affectedRows;
}

async function salvarFotoUrl(id, url) {
  await pool.query('UPDATE alunos SET foto_url = ? WHERE id = ?', [url, id]);
}

async function limparFotoUrl(id) {
  await pool.query('UPDATE alunos SET foto_url = NULL WHERE id = ?', [id]);
}

// --- Nível, situação anual, saúde e responsável (dados complementares) ---

async function nivelAberto(db, id, idInstituicao) {
  const [rows] = await db.query(
    'SELECT id, nivel, subnivel FROM aluno_niveis WHERE id_aluno = ? AND id_instituicao = ? AND data_fim IS NULL',
    [id, idInstituicao],
  );
  return rows[0] || null;
}

async function encerrarNivel(db, idNivel) {
  await db.query('UPDATE aluno_niveis SET data_fim = CURDATE() WHERE id = ?', [idNivel]);
}

async function abrirNivel(db, idAluno, nivel, subnivel, idInstituicao) {
  await db.query(
    `INSERT INTO aluno_niveis (id_instituicao, id_aluno, nivel, subnivel, data_inicio) VALUES (?, ?, ?, ?, CURDATE())`,
    [idInstituicao, idAluno, nivel, subnivel],
  );
}

async function inserirSituacaoAnual(db, idAluno, situacaoMatricula, situacaoDivida, idInstituicao) {
  await db.query(
    `INSERT INTO aluno_situacao_anual (id_instituicao, id_aluno, ano, situacao_matricula, situacao_divida) VALUES (?, ?, YEAR(CURDATE()), ?, ?)`,
    [idInstituicao, idAluno, situacaoMatricula, situacaoDivida],
  );
}

async function temSituacaoAnualNoAno(db, idAluno, idInstituicao) {
  const [rows] = await db.query(
    'SELECT id FROM aluno_situacao_anual WHERE id_aluno = ? AND id_instituicao = ? AND ano = YEAR(CURDATE())',
    [idAluno, idInstituicao],
  );
  return rows.length > 0;
}

async function salvarSituacaoAnual(db, idAluno, situacaoMatricula, situacaoDivida, idInstituicao) {
  await db.query(
    `INSERT INTO aluno_situacao_anual (id_instituicao, id_aluno, ano, situacao_matricula, situacao_divida)
     VALUES (?, ?, YEAR(CURDATE()), ?, ?)
     ON DUPLICATE KEY UPDATE situacao_matricula = VALUES(situacao_matricula), situacao_divida = VALUES(situacao_divida)`,
    [idInstituicao, idAluno, situacaoMatricula, situacaoDivida],
  );
}

async function adicionarObservacaoSaude(db, idAluno, descricao, idInstituicao) {
  await db.query(`INSERT INTO aluno_saude (id_instituicao, id_aluno, descricao) VALUES (?, ?, ?)`, [
    idInstituicao,
    idAluno,
    descricao,
  ]);
}

async function removerObservacaoSaude(idSaude, idAluno, idInstituicao) {
  const [result] = await pool.query(
    'DELETE FROM aluno_saude WHERE id = ? AND id_aluno = ? AND id_instituicao = ?',
    [idSaude, idAluno, idInstituicao],
  );
  return result.affectedRows;
}

const valoresResponsavel = (idAluno, r, idInstituicao) => [
  idInstituicao,
  idAluno,
  r.nome,
  r.cpf,
  r.rg,
  r.data_nascimento,
  r.email,
  r.endereco,
  r.bairro,
  r.cep,
  r.telefone,
];

async function inserirResponsavel(db, idAluno, r, idInstituicao) {
  await db.query(
    `INSERT INTO responsavel_legal (id_instituicao, id_aluno, nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    valoresResponsavel(idAluno, r, idInstituicao),
  );
}

async function salvarResponsavelDaEdicao(db, idAluno, r, idInstituicao) {
  await db.query(
    `INSERT INTO responsavel_legal (id_instituicao, id_aluno, nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE nome=VALUES(nome), cpf=VALUES(cpf), rg=VALUES(rg), data_nascimento=VALUES(data_nascimento),
       email=VALUES(email), endereco=VALUES(endereco), bairro=VALUES(bairro), cep=VALUES(cep), telefone=VALUES(telefone)`,
    valoresResponsavel(idAluno, r, idInstituicao),
  );
}

async function salvarResponsavel(idAluno, r, idInstituicao) {
  await pool.query(
    `INSERT INTO responsavel_legal (id_instituicao, id_aluno, nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       nome = VALUES(nome), cpf = VALUES(cpf), rg = VALUES(rg),
       data_nascimento = VALUES(data_nascimento), email = VALUES(email),
       endereco = VALUES(endereco), bairro = VALUES(bairro), cep = VALUES(cep),
       telefone = VALUES(telefone)`,
    valoresResponsavel(idAluno, r, idInstituicao),
  );
}

module.exports = {
  SUBQUERY_DIAS_MATRICULADOS,
  listar,
  telefones,
  listarExcluidos,
  buscarPorId,
  existe,
  buscarFoto,
  buscarNaLixeira,
  historicoNiveis,
  situacaoAnual,
  observacoesSaude,
  responsavel,
  listarTransportes,
  ativosComNivel,
  ocorrenciasNoPeriodo,
  inserir,
  buscarTurnoEStatus,
  atualizar,
  buscarStatusENome,
  buscarTurno,
  atualizarCampo,
  marcarInativadoHoje,
  limparInativadoEm,
  moverParaLixeira,
  encerrarMatriculasAtivas,
  restaurar,
  excluirDefinitivamente,
  salvarCodigoAcesso,
  salvarFotoUrl,
  limparFotoUrl,
  nivelAberto,
  encerrarNivel,
  abrirNivel,
  inserirSituacaoAnual,
  temSituacaoAnualNoAno,
  salvarSituacaoAnual,
  adicionarObservacaoSaude,
  removerObservacaoSaude,
  inserirResponsavel,
  salvarResponsavelDaEdicao,
  salvarResponsavel,
};
