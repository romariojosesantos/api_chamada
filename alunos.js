const express = require('express');
const router = express.Router();
const pool = require('./db');
const { validate } = require('./validation');
const { logAuditEvent } = require('./audit');

// Helper para envolver rotas assíncronas e capturar erros
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Helper para subquery de dias matriculados (evita duplicação de código)
const getDiasMatriculadosSubquery = () => `
  IFNULL((SELECT GROUP_CONCAT(DISTINCT TRIM(m2.dia_semana) SEPARATOR ',') 
   FROM matricula m2 
   INNER JOIN atividades atv ON m2.idatividades = atv.idatividades
   WHERE m2.idaluno = a.id AND m2.status = 'matriculado' AND m2.id_instituicao = a.id_instituicao AND atv.exibir_no_resumo = 1), '') as dias_matriculados
`;

// Helper para validar e normalizar turno
const validarTurno = (turno) => {
  if (!turno) return null;
  const turnoNormalizado = String(turno).trim();
  const turnosValidos = ['Manhã', 'Tarde', 'Noite', 'Integral', 'manhã', 'tarde', 'noite', 'integral'];
  if (!turnoNormalizado) return null;
  // Capitaliza primeira letra se não estiver nos padrões conhecidos
  if (!turnosValidos.includes(turnoNormalizado)) {
    return turnoNormalizado.charAt(0).toUpperCase() + turnoNormalizado.slice(1).toLowerCase();
  }
  return turnoNormalizado;
};

// Helper para parse de data de nascimento (simplificado)
const parseDataNascimento = (data) => {
  if (!data) return null;
  if (data instanceof Date) {
    return data.toISOString().split('T')[0];
  }
  if (typeof data === 'string' && data.trim()) {
    const parsedDate = new Date(data);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate.toISOString().split('T')[0];
    }
  }
  return null;
};

// Listar Alunos com filtros dinâmicos
router.get('/', asyncHandler(async (req, res) => {
  const { nome, turno, transporte, status } = req.query;
  
  let sql = `
    SELECT a.id, a.nome, a.data_nascimento, a.sexo, a.telefone, 
           a.turma, a.turno, a.transporte, a.status, a.Inf,
           '' as dias_matriculados
    FROM alunos a 
    WHERE a.id_instituicao = ?
  `;
  const params = [req.id_instituicao];

  if (nome && nome.trim() !== '') {
    sql += " AND a.nome LIKE ?";
    params.push(`%${nome.trim()}%`);
  } else {
    if (status) { sql += " AND a.status = ?"; params.push(status); }
    else { sql += " AND a.status = 'ativo'"; }

    if (turno && turno !== 'Todos') { sql += " AND TRIM(a.turno) = ?"; params.push(turno); }
    if (transporte && transporte !== 'Todos') { sql += " AND TRIM(a.transporte) = ?"; params.push(transporte); }
  }

  sql += " ORDER BY a.nome ASC";
  const [results] = await pool.query(sql, params);
  res.json(results);
}));

// Rota para buscar alunos que possuem aula em um dia específico (Base para a Chamada)
router.get('/por-dia', asyncHandler(async (req, res) => {
  const { data, ignoreFilters } = req.query; // Espera formato YYYY-MM-DD
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });

  const dateObj = new Date(`${data}T00:00:00`);
  const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const diaDaSemana = dias[dateObj.getDay()];

  let sql, params;

  if (ignoreFilters === 'true') {
    // Modo Relatório: retorna TODOS os alunos ativos com status de presença para a data
    sql = `
      SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status,
             '' as dias_matriculados,
             p.status AS presenca_status, p.observacao AS presenca_obs
      FROM alunos a
      JOIN matricula m ON a.id = m.idaluno
      JOIN atividades atv ON m.idatividades = atv.idatividades
      LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
      WHERE a.status = 'ativo'
      AND m.status = 'matriculado'
      AND a.id_instituicao = ?
      ORDER BY a.nome ASC
    `;
    params = [data, req.id_instituicao];
  } else {
    // Modo Chamada: filtra apenas os alunos matriculados no dia da semana informado
    sql = `
      SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status,
             '' as dias_matriculados,
             p.status AS presenca_status, p.observacao AS presenca_obs
      FROM alunos a
      JOIN matricula m ON a.id = m.idaluno
      JOIN atividades atv ON m.idatividades = atv.idatividades
      LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
      WHERE TRIM(m.dia_semana) = ? 
      AND a.status = 'ativo'
      AND m.status = 'matriculado'
      AND a.id_instituicao = ?
      ORDER BY a.nome ASC
    `;
    params = [data, diaDaSemana, req.id_instituicao];
  }

  const [results] = await pool.query(sql, params);
  res.json(results);
}));


// Relatório Frequência Plena (Otimizado)
router.get('/frequencia-plena', asyncHandler(async (req, res) => {
  const { inicio, fim } = req.query;
  if (!inicio || !fim) return res.status(400).json({ error: 'Datas início/fim obrigatórias.' });
  
  const sql = `
    SELECT a.id, a.nome, a.turno, a.turma, a.transporte,
           COUNT(DISTINCT p.data) as total_presencas,
           GROUP_CONCAT(DISTINCT DATE_FORMAT(p.data, '%d/%m') ORDER BY p.data ASC SEPARATOR ', ') as dias_presente
    FROM alunos a
    INNER JOIN presenca p ON a.id = p.aluno_id AND p.status = 'presente' 
      AND p.data BETWEEN ? AND ? AND p.id_instituicao = ?
    WHERE a.id_instituicao = ?
    GROUP BY a.id, a.nome, a.turno, a.turma, a.transporte
    ORDER BY a.nome ASC
  `;
  const [results] = await pool.query(sql, [inicio, fim, req.id_instituicao, req.id_instituicao]);
  res.json(results);
}));

// Rota para Upsert em Lote (Importação do Excel)
router.post('/upsert-bulk', asyncHandler(async (req, res) => {
  let alunos = [];
  let atividadesExcel = [];
  
  if (Array.isArray(req.body)) {
    alunos = req.body;
  } else if (req.body && req.body.alunos) {
    alunos = req.body.alunos;
    atividadesExcel = req.body.atividades || [];
  } else {
    alunos = [req.body];
  }

  if (alunos.length === 0) return res.status(400).json({ error: 'Nenhum dado enviado.' });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Prepara os valores para o INSERT em massa
    // Mapeia os campos vindos do Excel para as colunas do banco
    const values = alunos.map(a => [
      String(a.nome || a.ALUNO || a.Aluno).trim(),
      parseDataNascimento(a.data_nascimento),
      a.sexo || null,
      a.telefone || null,
      // Ensure turma is not null if it's an empty string, otherwise default to null
      // This helps with consistency if some Excel rows have empty turma
      String(a.turma || '').trim() || null, 
      a.turno || null,
      a.transporte || null,
      a.Inf || null,
      'ativo',
      req.id_instituicao
    ]);

    const sql = `
      INSERT INTO alunos (nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf, status, id_instituicao)
      VALUES ?
      ON DUPLICATE KEY UPDATE 
        data_nascimento = VALUES(data_nascimento),
        sexo = VALUES(sexo),
        telefone = VALUES(telefone),
        turma = VALUES(turma),
        turno = VALUES(turno),
        transporte = VALUES(transporte),
        Inf = VALUES(Inf)
    `;

    const [alunosUpsertResult] = await connection.query(sql, [values]);

    // 1. Após o upsert de alunos, precisamos dos IDs de todos os alunos processados.
    // Como result.insertId não é confiável para bulk updates, fazemos um SELECT.
    const studentNames = alunos.map(a => String(a.nome || a.ALUNO || a.Aluno).trim());
    const [existingStudents] = await connection.query(
      `SELECT id, nome, turno FROM alunos WHERE nome IN (?) AND id_instituicao = ?`,
      [studentNames, req.id_instituicao]
    );
    const studentIdMap = new Map(existingStudents.map(s => [s.nome, { id: s.id, turno: s.turno }]));

    // 2. Preparar dados de matrícula
    const matriculasToUpsert = [];
    const activitiesToFindOrCreate = new Set(); // Coleta nomes de atividades únicas
    const excelActivityProfMap = new Map(); // Mapa de atividade -> professor

    // Processa a aba de atividades enviada do Excel
    for (const atv of atividadesExcel) {
      const atvNome = String(atv.atividade || atv.nome || atv.atividades || '').trim();
      const profNome = String(atv.professor || atv.professores || atv.prof || '').trim();
      if (atvNome) {
        activitiesToFindOrCreate.add(atvNome);
        if (profNome) {
          excelActivityProfMap.set(atvNome, profNome);
        }
      }
    }

    // Regex para identificar colunas de matrícula como "SEG HR 1", "TER HR 2"
    const matriculaColRegex = /^(seg|ter|qua|qui|sex)\s+(hr\s+\d+)$/i;
    const diaSemanaMap = {
      'seg': 'Segunda', 'ter': 'Terça', 'qua': 'Quarta', 'qui': 'Quinta', 'sex': 'Sexta'
    };

    for (const alunoRaw of alunos) {
      const alunoNome = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno).trim();
      const studentInfo = studentIdMap.get(alunoNome);
      const idaluno = studentInfo?.id;
      const alunoTurno = validarTurno(studentInfo?.turno || alunoRaw.turno); // Prioriza turno do DB, senão do Excel

      if (!idaluno) {
        console.warn(`Aluno ${alunoNome} não encontrado após upsert. Pulando matrículas.`);
        continue;
      }

      for (const key in alunoRaw) {
        const match = key.match(matriculaColRegex);
        if (match && alunoRaw[key]) { // Se é uma coluna de matrícula e tem um valor (nome da atividade)
          const diaAbreviado = match[1].toLowerCase();
          const horario = match[2].toUpperCase(); // Ex: "HR 1", "HR 2"
          const dia_semana = diaSemanaMap[diaAbreviado];
          const nome_atividade = String(alunoRaw[key]).trim();

          if (dia_semana && nome_atividade && alunoTurno) { // Garante que todas as partes são válidas
            activitiesToFindOrCreate.add(nome_atividade);
            matriculasToUpsert.push({
              idaluno,
              nome_atividade, // Armazena temporariamente o nome, será substituído por idatividades
              turno: alunoTurno,
              horario,
              dia_semana,
              id_instituicao: req.id_instituicao
            });
          }
        }
      }
    }

    // 3. Encontrar ou criar atividades e professores
    const activityIdMap = new Map();
    if (activitiesToFindOrCreate.size > 0) {
      // 3.1 Resolvendo Professores
      const profsToFindOrCreate = new Set(['Professor Padrão']);
      for (const profNome of excelActivityProfMap.values()) {
        profsToFindOrCreate.add(profNome);
      }

      const profIdMap = new Map();
      const profsArray = Array.from(profsToFindOrCreate);
      const [existingProfs] = await connection.query(
        `SELECT id, nome FROM professores WHERE nome IN (?) AND id_instituicao = ?`,
        [profsArray, req.id_instituicao]
      );
      existingProfs.forEach(p => profIdMap.set(p.nome, p.id));

      const profsToCreate = profsArray.filter(name => !profIdMap.has(name));
      if (profsToCreate.length > 0) {
        const newProfsValues = profsToCreate.map(name => [name, req.id_instituicao]);
        await connection.query(
          `INSERT INTO professores (nome, id_instituicao) VALUES ?`,
          [newProfsValues]
        );
        const [newlyCreatedProfs] = await connection.query(
          `SELECT id, nome FROM professores WHERE nome IN (?) AND id_instituicao = ?`,
          [profsToCreate, req.id_instituicao]
        );
        newlyCreatedProfs.forEach(p => profIdMap.set(p.nome, p.id));
      }

      const defaultProfessorId = profIdMap.get('Professor Padrão');

      // 3.2 Resolvendo Atividades
      const [existingActivities] = await connection.query(
        `SELECT idatividades, nome, idprofessor FROM atividades WHERE nome IN (?) AND id_instituicao = ?`,
        [Array.from(activitiesToFindOrCreate), req.id_instituicao]
      );
      existingActivities.forEach(act => activityIdMap.set(act.nome, act.idatividades));

      const activitiesToCreate = Array.from(activitiesToFindOrCreate).filter(
        name => !activityIdMap.has(name)
      );

      if (activitiesToCreate.length > 0) {
        const newActivitiesValues = activitiesToCreate.map(name => {
          const profNome = excelActivityProfMap.get(name);
          const idprof = profNome ? profIdMap.get(profNome) : defaultProfessorId;
          return [name, idprof, req.id_instituicao];
        });
        await connection.query(
          `INSERT INTO atividades (nome, idprofessor, id_instituicao) VALUES ?`,
          [newActivitiesValues]
        );
        const [newlyCreatedActivities] = await connection.query(
          `SELECT idatividades, nome FROM atividades WHERE nome IN (?) AND id_instituicao = ?`,
          [activitiesToCreate, req.id_instituicao]
        );
        newlyCreatedActivities.forEach(act => activityIdMap.set(act.nome, act.idatividades));
      }

      // 3.3 Atualizando Atividades Existentes (se o professor mudou na planilha)
      const activitiesToUpdate = [];
      for (const existingAct of existingActivities) {
        const profNomeFromExcel = excelActivityProfMap.get(existingAct.nome);
        if (profNomeFromExcel) {
          const mappedProfId = profIdMap.get(profNomeFromExcel);
          if (mappedProfId && existingAct.idprofessor !== mappedProfId) {
            activitiesToUpdate.push([mappedProfId, existingAct.idatividades, req.id_instituicao]);
          }
        }
      }
      if (activitiesToUpdate.length > 0) {
        // Otimização: Bulk update usando CASE WHEN em vez de loop
        const caseWhenParts = activitiesToUpdate.map(([profId, actId]) => 
          `WHEN ${actId} THEN ${profId}`
        ).join(' ');
        const actIds = activitiesToUpdate.map(([, actId]) => actId).join(',');
        
        await connection.query(
          `UPDATE atividades SET idprofessor = CASE idatividades ${caseWhenParts} END WHERE idatividades IN (${actIds}) AND id_instituicao = ?`,
          [req.id_instituicao]
        );
      }
    }

    // 4. Preparar valores finais de matrícula com idatividades reais
    const finalMatriculasValues = matriculasToUpsert.map(m => [
      m.idaluno,
      activityIdMap.get(m.nome_atividade), // Obtém o idatividades real
      m.turno,
      m.horario,
      m.dia_semana,
      m.id_instituicao
    ]);

    // 5. Executar Upsert em Lote para Matrículas
    let matriculasAffected = 0;
    if (finalMatriculasValues.length > 0) {
      const matriculaSql = `
        INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, id_instituicao)
        VALUES ?
        ON DUPLICATE KEY UPDATE 
          idatividades = VALUES(idatividades),
          status = 'matriculado' -- Garante que o status seja ativo se for uma re-matrícula
      `;
      const [matriculaResult] = await connection.query(matriculaSql, [finalMatriculasValues]);
      matriculasAffected = matriculaResult.affectedRows;
    }

    await connection.commit();

    res.json({
      message: 'Processamento concluído',
      resumo: {
        total_recebido: alunos.length,
        alunos_afetados: alunosUpsertResult.affectedRows,
        matriculas_afetadas: matriculasAffected
      }
    });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}));

// Criar Aluno com Validação
router.post('/', validate('aluno'), asyncHandler(async (req, res) => {
  const { nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf, status } = req.body;
  const sql = `
    INSERT INTO alunos (nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf, status, id_instituicao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const [result] = await pool.query(sql, [
    nome, data_nascimento || null, sexo || null, telefone || null, 
    turma || null, turno || null, transporte || null, Inf || null, 
    status || 'ativo', req.id_instituicao
  ]);
  
  await logAuditEvent('CRIAR_ALUNO', `Aluno ID: ${result.insertId}, Nome: ${nome}`, req.id_instituicao);
  res.status(201).json({ id: result.insertId, message: 'Aluno criado com sucesso!' });
}));

// Atualização parcial via PATCH (Update by ID)
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { campo, valor } = req.body;
  const colunasPermitidas = ['data_nascimento', 'sexo', 'telefone', 'turma', 'turno', 'transporte', 'Inf', 'status'];
  
  if (!colunasPermitidas.includes(campo)) {
    return res.status(400).json({ error: 'Campo não permitido para atualização.' });
  }

  const sql = 'UPDATE alunos SET ?? = ? WHERE id = ? AND id_instituicao = ?';
  const [result] = await pool.query(sql, [campo, valor, id, req.id_instituicao]);

  if (result.affectedRows === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });
  
  await logAuditEvent('ATUALIZAR_ALUNO', `Aluno ID: ${id}, Campo: ${campo}`, req.id_instituicao);
  res.json({ message: 'Campo atualizado com sucesso.' });
}));

// Excluir Aluno (Com proteção de Instituição)
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    // Remove matrículas primeiro (Integridade Referencial)
    await connection.query('DELETE FROM matricula WHERE idaluno = ? AND id_instituicao = ?', [id, req.id_instituicao]);
    
    const [result] = await connection.query('DELETE FROM alunos WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
    
    if (result.affectedRows === 0) throw new Error('Aluno não encontrado');

    await logAuditEvent('EXCLUIR_ALUNO', `Aluno ID: ${id} excluído com matrículas`, req.id_instituicao, connection);
    await connection.commit();
    res.json({ message: 'Aluno e suas matrículas excluídos com sucesso!' });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}));

module.exports = router;