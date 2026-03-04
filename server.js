// /minha-api/server.js

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise'); // Usar a versão com suporte a Promises

// Inicializa o aplicativo Express
const app = express();
const PORT = 3001;

// --- Conexão com o Banco de Dados ---
// Cria um pool de conexões. É mais robusto que uma única conexão.
const pool = mysql.createPool({
  uri: 'mysql://romario_novo:RomarioSantos2025@31.97.83.209:3306/chamada_conexao',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Middlewares
app.use(cors()); // Habilita o CORS para todas as rotas
app.use(express.json()); // Permite que o servidor entenda requisições com corpo em JSON

// --- Banco de Dados Falso (Mock Data) ---
// Em uma aplicação real, estes dados viriam de um banco de dados.

// --- Rotas da API ---

// Rota para buscar a lista de alunos
app.get('/api/alunos', async (req, res) => {
  console.log('GET /api/alunos - Enviando lista de alunos...');
  try {
    const sql = "SELECT * FROM alunos";
    const [results] = await pool.query(sql);
    res.json(results);
  } catch (err) {
    console.error("Erro em GET /api/alunos:", err);
    res.status(500).json({ error: 'Erro ao buscar alunos: ' + err.message });
  }
});

// Rota para criar um novo aluno
app.post('/api/alunos', async (req, res) => {
  const { nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf } = req.body;
  console.log('POST /api/alunos - Criando novo aluno...');

  // Validação básica
  if (!nome) {
    return res.status(400).json({ error: 'O campo "nome" é obrigatório.' });
  }

  try {
    const sql = `
      INSERT INTO alunos (nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const [result] = await pool.query(sql, [nome, data_nascimento || null, sexo || null, telefone || null, turma || null, turno || null, transporte || null, Inf || null]);
    res.status(201).json({ id: result.insertId, message: 'Aluno criado com sucesso!' });
  } catch (err) {
    console.error("Erro em POST /api/alunos:", err);
    res.status(500).json({ error: 'Erro ao criar aluno: ' + err.message });
  }
});

// Rota para importação em lote (Bulk Import) de alunos
app.post('/api/alunos/bulk', async (req, res) => {
  const alunos = req.body;
  console.log('POST /api/alunos/bulk - Iniciando importação em lote...');

  if (!Array.isArray(alunos)) {
    return res.status(400).json({ error: 'O corpo da requisição deve ser um array de alunos.' });
  }

  // 0. Carregar mapa de atividades (Nome -> ID) para permitir envio por nome
  const atividadesMap = new Map();
  try {
    const [atvs] = await pool.query('SELECT idatividades, nome FROM atividades');
    atvs.forEach(a => {
      if (a.nome) atividadesMap.set(a.nome.trim().toLowerCase(), a.idatividades);
    });
  } catch (err) {
    console.warn('Aviso: Não foi possível carregar lista de atividades para mapeamento.', err.message);
  }

  let adicionados = 0;
  let ignorados = 0;
  let erros = [];

  for (const aluno of alunos) {
    try {
      // 1. Validação Básica
      if (!aluno.nome) {
        erros.push({ item: aluno, motivo: 'Nome ausente' });
        continue;
      }

      // 2. Normalização (Ex: Sexo)
      let sexo = aluno.sexo;
      if (sexo && typeof sexo === 'string') {
        sexo = sexo.substring(0, 1).toUpperCase();
      } else {
        sexo = null;
      }

      // Normalização de Data de Nascimento (Correção para datas do Excel)
      let data_nascimento = aluno.data_nascimento;
      // Verifica se é um valor numérico (serial Excel) e não uma string de data formatada
      if (data_nascimento && !isNaN(data_nascimento)) {
        const serial = parseFloat(data_nascimento);
        // Seriais de datas recentes (2000+) são > 36000. Evita tratar anos (ex: "2015") como serial.
        if (serial > 10000) {
          // 25569 é o offset Excel->Unix. +43200000ms (12h) compensa fuso horário/arredondamento
          const dateObj = new Date(((serial - 25569) * 86400000) + 43200000);
          try {
            data_nascimento = dateObj.toISOString().split('T')[0];
          } catch (e) { /* Mantém o valor original se falhar */ }
        }
      }

      // 3. Verificação de Duplicidade (por Nome)
      const checkSql = 'SELECT id FROM alunos WHERE nome = ? LIMIT 1';
      const [existing] = await pool.query(checkSql, [aluno.nome]);

      if (existing.length > 0) {
        ignorados++;
        continue;
      }

      // 4. Inserção
      const insertSql = `
        INSERT INTO alunos (nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const values = [
        aluno.nome,
        data_nascimento || null,
        sexo,
        aluno.telefone || null,
        aluno.turma || null,
        aluno.turno || null,
        aluno.transporte || null,
        aluno.Inf || null
      ];

      const [result] = await pool.query(insertSql, values);
      const newAlunoId = result.insertId;
      adicionados++;

      // 5. Matrícula Automática (se houver array 'matriculas' no JSON do aluno)
      if (aluno.matriculas && Array.isArray(aluno.matriculas) && aluno.matriculas.length > 0) {
        const matriculasValues = [];

        for (const m of aluno.matriculas) {
          let idAtividade = m.idatividades;
          // Se o ID não foi informado, tenta encontrar pelo nome da atividade (ex: "Futebol")
          if (!idAtividade && m.nome_atividade) {
            idAtividade = atividadesMap.get(m.nome_atividade.trim().toLowerCase());
          }

          if (idAtividade) {
            matriculasValues.push([
              newAlunoId, // ID do aluno que acabou de ser criado
              idAtividade, // ID da atividade resolvido
              m.turno || aluno.turno || null,
              m.horario || null,
              m.dia_semana || null
            ]);
          }
        }

        if (matriculasValues.length > 0) {
          const insertMatriculaSql = 'INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana) VALUES ?';
          await pool.query(insertMatriculaSql, [matriculasValues]);
        }
      }

    } catch (error) {
      console.error(`Erro ao importar aluno ${aluno.nome}:`, error);
      erros.push({ nome: aluno.nome, motivo: 'Erro interno ao salvar: ' + error.message });
    }
  }

  res.status(200).json({
    message: 'Processamento concluído',
    resumo: {
      total_recebido: alunos.length,
      adicionados: adicionados,
      ignorados: ignorados,
      erros: erros
    }
  });
});

// Rota para exclusão em lote (Bulk Delete) de alunos
app.post('/api/alunos/bulk-delete', async (req, res) => {
  const alunos = req.body;
  console.log('POST /api/alunos/bulk-delete - Iniciando exclusão em lote...');

  if (!Array.isArray(alunos)) {
    return res.status(400).json({ error: 'O corpo da requisição deve ser um array de alunos.' });
  }

  let deletados = 0;
  let naoEncontrados = 0;
  let erros = [];

  for (const aluno of alunos) {
    try {
      let alunoId = aluno.id;

      // Se não tiver ID, tenta buscar pelo nome (útil para planilhas que só têm o nome)
      if (!alunoId && aluno.nome) {
        const [rows] = await pool.query('SELECT id FROM alunos WHERE nome = ? LIMIT 1', [aluno.nome]);
        if (rows.length > 0) {
          alunoId = rows[0].id;
        }
      }

      if (!alunoId) {
        naoEncontrados++;
        continue;
      }

      // 1. Excluir matrículas associadas (para manter consistência e evitar erros de FK se não houver CASCADE)
      await pool.query('DELETE FROM matricula WHERE idaluno = ?', [alunoId]);

      // 2. Excluir o aluno
      const [result] = await pool.query('DELETE FROM alunos WHERE id = ?', [alunoId]);

      if (result.affectedRows > 0) {
        deletados++;
      } else {
        naoEncontrados++;
      }

    } catch (error) {
      console.error(`Erro ao excluir aluno ${aluno.nome}:`, error);
      erros.push({ nome: aluno.nome, motivo: error.message });
    }
  }

  res.status(200).json({
    message: 'Processamento de exclusão concluído',
    resumo: {
      total_recebido: alunos.length,
      deletados: deletados,
      nao_encontrados: naoEncontrados,
      erros: erros
    }
  });
});

// Rota para DELETAR um aluno
app.delete('/api/alunos/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`DELETE /api/alunos/${id} - Excluindo aluno...`);

  try {
    // Primeiro, delete as matrículas associadas a este aluno para evitar erros de chave estrangeira
    const deleteMatriculasSql = 'DELETE FROM matricula WHERE idaluno = ?';
    await pool.query(deleteMatriculasSql, [id]);
    console.log(`Matrículas do aluno ${id} excluídas.`);

    // Agora, delete o aluno
    const deleteAlunoSql = 'DELETE FROM alunos WHERE id = ?';
    const [result] = await pool.query(deleteAlunoSql, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Aluno não encontrado.' });
    }

    res.json({ message: 'Aluno e suas matrículas foram excluídos com sucesso!' });
  } catch (err) {
    console.error(`Erro em DELETE /api/alunos/${id}:`, err);
    res.status(500).json({ error: 'Erro ao excluir aluno: ' + err.message });
  }
});

// Rota para atualizar uma coluna específica de um aluno pelo nome
app.patch('/api/alunos/update-by-name', async (req, res) => {
  const { nome, campo, valor } = req.body;
  console.log(`PATCH /api/alunos/update-by-name - Atualizando campo '${campo}' para o aluno '${nome}'`);

  // 1. Validação básica
  if (!nome || !campo) {
    // O 'valor' pode ser nulo ou uma string vazia, então não validamos sua existência aqui.
    return res.status(400).json({ error: 'Os campos "nome" e "campo" são obrigatórios.' });
  }

  // 2. Whitelist de colunas para segurança
  const colunasPermitidas = ['data_nascimento', 'sexo', 'telefone', 'turma', 'turno', 'transporte', 'Inf'];
  if (!colunasPermitidas.includes(campo)) {
    return res.status(400).json({ error: `O campo "${campo}" não pode ser atualizado por esta rota.` });
  }

  try {
    // 3. Construção e execução da query
    const sql = 'UPDATE alunos SET ?? = ? WHERE nome = ?';
    const [result] = await pool.query(sql, [campo, valor, nome]);

    // 4. Verificação do resultado
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: `Aluno com o nome "${nome}" não encontrado.` });
    }

    res.json({ message: `Aluno "${nome}" atualizado com sucesso. Campo "${campo}" definido como "${valor}".` });
  } catch (err) {
    console.error("Erro em PATCH /api/alunos/update-by-name:", err);
    res.status(500).json({ error: 'Erro ao atualizar aluno: ' + err.message });
  }
});


// Rota para buscar os registros de presença
app.get('/api/presenca', async (req, res) => {
  console.log('GET /api/presenca - Enviando registros de presença...');
  try {
    const sql = "SELECT aluno_id, data, status FROM presenca";
    const [results] = await pool.query(sql);
    res.json(results);
  } catch (err) {
    console.error("Erro em GET /api/presenca:", err);
    res.status(500).json({ error: 'Erro ao buscar presença: ' + err.message });
  }
});

// Rota para salvar/atualizar os registros de presença de um dia
app.post('/api/presenca', async (req, res) => {
  const { data, chamadas } = req.body;

  // Validação básica dos dados recebidos
  if (!data || !Array.isArray(chamadas)) {
    return res.status(400).json({ error: 'Dados inválidos. É necessário fornecer a data e um array de chamadas.' });
  }
  console.log(`POST /api/presenca - Salvando chamada para o dia: ${data}`);

  // Se não houver chamadas, não faz nada no banco.
  if (chamadas.length === 0) {
    return res.status(200).json({ message: 'Nenhuma chamada para salvar.' });
  }
  try {
    // Prepara a query para inserir ou atualizar (UPSERT)
    const sql = `
      INSERT INTO presenca (aluno_id, data, status)
      VALUES ?
      ON DUPLICATE KEY UPDATE status = VALUES(status);
    `;
    const values = chamadas.map(c => [c.aluno_id, data, c.status]);
    await pool.query(sql, [values]);
    res.status(201).json({ message: `Presença para o dia ${data} salva com sucesso!` });
  } catch (err) {
    console.error("Erro em POST /api/presenca:", err);
    res.status(500).json({ error: 'Erro ao salvar presenças: ' + err.message });
  }
});

// Rota para buscar a grade de horários completa
app.get('/api/grade', async (req, res) => {
  console.log('GET /api/grade - Enviando a grade de horários...');
  try {
    const sql = `
      SELECT
          m.idaluno,
          a.nome AS nome_aluno,
          m.idatividades AS id_atividade,
          atv.nome AS nome_atividade,
          m.turno,
          m.horario,
          m.dia_semana,
          p.nome AS nome_professor
      FROM
          matricula AS m
      JOIN alunos AS a ON m.idaluno = a.id
      JOIN atividades AS atv ON m.idatividades = atv.idatividades
      JOIN professores AS p ON atv.idprofessor = p.id
    `;
    const [results] = await pool.query(sql);
    res.json(results);
  } catch (err) {
    console.error("Erro em GET /api/grade:", err);
    res.status(500).json({ error: 'Erro ao buscar a grade de horários: ' + err.message });
  }
});

// --- ROTAS DE MATRÍCULA ---

// Rota para importação em lote (Bulk Import) de matrículas
app.post('/api/matriculas/bulk', async (req, res) => {
  const matriculas = req.body;
  console.log('POST /api/matriculas/bulk - Iniciando importação de matrículas em lote...');

  if (!Array.isArray(matriculas)) {
    return res.status(400).json({ error: 'O corpo da requisição deve ser um array de matrículas.' });
  }

  // Helper para normalizar nomes (remove espaços duplicados e converte para minúsculo)
  const normalize = (str) => String(str || '').trim().replace(/\s+/g, ' ').toLowerCase();

  // Pré-carrega mapas para eficiência e evitar múltiplas queries no loop
  const alunosMap = new Map();
  const atividadesMap = new Map();
  const professoresMap = new Map();
  const existingMatriculas = new Set();

  try {
    const [alunosDB] = await pool.query('SELECT id, nome FROM alunos');
    alunosDB.forEach(a => alunosMap.set(normalize(a.nome), a.id));

    const [atividadesDB] = await pool.query('SELECT idatividades, nome FROM atividades');
    atividadesDB.forEach(a => atividadesMap.set(normalize(a.nome), a.idatividades));

    const [professoresDB] = await pool.query('SELECT id, nome FROM professores');
    professoresDB.forEach(p => professoresMap.set(normalize(p.nome), p.id));

    // Carrega matrículas existentes para evitar duplicatas
    const [dbMatriculas] = await pool.query('SELECT idaluno, idatividades, dia_semana, horario FROM matricula');
    dbMatriculas.forEach(m => {
      const key = `${m.idaluno}-${m.idatividades}-${m.dia_semana}-${m.horario}`;
      existingMatriculas.add(key);
    });

  } catch (err) {
    console.error("Erro ao pré-carregar dados para importação em lote:", err);
    return res.status(500).json({ error: 'Erro ao preparar o servidor para a importação: ' + err.message });
  }

  let adicionadas = 0;
  let ignoradas = 0;
  let erros = [];
  const matriculasParaInserir = [];

  for (const m of matriculas) {
    // Normaliza as chaves do objeto para minúsculas para flexibilidade
    const matricula = {};
    for (const key in m) {
      matricula[key.toLowerCase().trim()] = m[key];
    }

    // 1. Validação dos campos obrigatórios
    if (!matricula.nome_aluno || !matricula.nome_atividade || !matricula.dia_semana || !matricula.horario) {
      erros.push({ item: m, motivo: 'Campos obrigatórios ausentes (nome_aluno, nome_atividade, dia_semana, horario).' });
      continue;
    }

    // 1.5. Processar Professor (se fornecido na planilha)
    let idProfessor = null;
    const nomeProfessor = matricula.nome_professor || matricula.professor; // Aceita "nome_professor" ou "professor"

    if (nomeProfessor) {
      const nomeProfNorm = normalize(nomeProfessor);
      idProfessor = professoresMap.get(nomeProfNorm);

      if (!idProfessor) {
        try {
          const [resultProf] = await pool.query('INSERT INTO professores (nome) VALUES (?)', [nomeProfessor.trim()]);
          idProfessor = resultProf.insertId;
          professoresMap.set(nomeProfNorm, idProfessor); // Atualiza mapa
        } catch (err) {
          console.error(`Erro ao criar professor automático "${nomeProfessor}":`, err.message);
        }
      }
    }

    // 2. Busca os IDs a partir dos nomes (usando os mapas)
    const idAluno = alunosMap.get(normalize(matricula.nome_aluno));
    let idAtividade = atividadesMap.get(normalize(matricula.nome_atividade));

    if (!idAluno) {
      erros.push({ item: m, motivo: `Aluno "${matricula.nome_aluno}" não encontrado.` });
      continue;
    }
    if (!idAtividade) {
      // Se a atividade não existe, cria automaticamente no banco de dados
      try {
        // Agora inclui o idProfessor na criação
        const [resultAtv] = await pool.query('INSERT INTO atividades (nome, idprofessor) VALUES (?, ?)', [matricula.nome_atividade.trim(), idProfessor]);
        idAtividade = resultAtv.insertId;
        atividadesMap.set(normalize(matricula.nome_atividade), idAtividade); // Atualiza o mapa para as próximas linhas
      } catch (err) {
        erros.push({ item: m, motivo: `Erro ao criar atividade automática "${matricula.nome_atividade}": ${err.message}` });
        continue;
      }
    } else if (idProfessor) {
      // Se a atividade já existe e temos um professor na planilha, atualizamos o vínculo
      try {
        await pool.query('UPDATE atividades SET idprofessor = ? WHERE idatividades = ?', [idProfessor, idAtividade]);
      } catch (err) {
        console.error(`Erro ao atualizar professor da atividade ${matricula.nome_atividade}:`, err.message);
      }
    }

    // 3. Verifica se a matrícula já existe (no banco ou no próprio arquivo)
    const matriculaKey = `${idAluno}-${idAtividade}-${matricula.dia_semana}-${matricula.horario}`;
    if (existingMatriculas.has(matriculaKey)) {
      ignoradas++;
      continue;
    }

    // 4. Adiciona à lista para inserção em lote
    matriculasParaInserir.push([
      idAluno,
      idAtividade,
      matricula.turno || null,
      matricula.horario,
      matricula.dia_semana
    ]);
    existingMatriculas.add(matriculaKey); // Evita duplicatas dentro do mesmo arquivo
  }

  // 5. Insere todas as novas matrículas de uma vez
  if (matriculasParaInserir.length > 0) {
    try {
      const insertMatriculaSql = 'INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana) VALUES ?';
      const [result] = await pool.query(insertMatriculaSql, [matriculasParaInserir]);
      adicionadas = result.affectedRows;
    } catch (error) {
      console.error(`Erro no bulk insert de matrículas:`, error);
      erros.push({ item: 'GERAL', motivo: 'Falha na inserção em lote no banco de dados: ' + error.message });
    }
  }

  res.status(200).json({
    message: 'Processamento de matrículas concluído',
    resumo: {
      total_recebido: matriculas.length,
      adicionadas: adicionadas,
      ignoradas_por_duplicidade: ignoradas,
      erros: erros
    }
  });
});

// Rota para criar/atualizar matrículas em lote (Upsert) sem precisar do ID da matrícula
app.post('/api/matriculas/upsert-bulk', async (req, res) => {
  const matriculas = req.body;
  console.log('POST /api/matriculas/upsert-bulk - Iniciando upsert de matrículas em lote...');

  if (!Array.isArray(matriculas)) {
    return res.status(400).json({ error: 'O corpo da requisição deve ser um array de matrículas.' });
  }

  // Helper para normalizar nomes
  const normalize = (str) => String(str || '').trim().replace(/\s+/g, ' ').toLowerCase();

  // Pré-carrega mapas para eficiência
  const alunosMap = new Map();
  const atividadesMap = new Map();
  const professoresMap = new Map();

  let connection;
  try {
    // Pega uma conexão do pool para realizar a transação
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [alunosDB] = await connection.query('SELECT id, nome FROM alunos');
    alunosDB.forEach(a => alunosMap.set(normalize(a.nome), a.id));

    const [atividadesDB] = await connection.query('SELECT idatividades, nome FROM atividades');
    atividadesDB.forEach(a => atividadesMap.set(normalize(a.nome), a.idatividades));

    const [professoresDB] = await connection.query('SELECT id, nome FROM professores');
    professoresDB.forEach(p => professoresMap.set(normalize(p.nome), p.id));

    let criadas = 0;
    let atualizadas = 0;
    let erros = [];

    for (const m of matriculas) {
      // Normaliza as chaves do objeto para minúsculas
      const matricula = {};
      for (const key in m) {
        matricula[key.toLowerCase().trim()] = m[key];
      }

      const { nome_aluno, turno, dia_semana, horario, nome_atividade } = matricula;
      const nomeProfessor = matricula.professor || matricula.nome_professor;

      // 1. Validação dos campos obrigatórios
      if (!nome_aluno || !nome_atividade || !dia_semana || !horario || !nomeProfessor) {
        erros.push({ item: m, motivo: 'Campos obrigatórios ausentes (nome_aluno, nome_atividade, dia_semana, horario, professor).' });
        continue;
      }

      // 2. Encontrar Aluno
      const idAluno = alunosMap.get(normalize(nome_aluno));
      if (!idAluno) {
        erros.push({ item: m, motivo: `Aluno "${nome_aluno}" não encontrado no banco de dados.` });
        continue;
      }

      // 3. Encontrar ou Criar Professor
      let idProfessor = professoresMap.get(normalize(nomeProfessor));
      if (!idProfessor) {
        try {
          const [resultProf] = await connection.query('INSERT INTO professores (nome) VALUES (?)', [nomeProfessor.trim()]);
          idProfessor = resultProf.insertId;
          professoresMap.set(normalize(nomeProfessor), idProfessor); // Atualiza mapa para as próximas linhas
        } catch (err) {
          erros.push({ item: m, motivo: `Erro ao criar novo professor "${nomeProfessor}": ${err.message}` });
          continue;
        }
      }

      // 4. Encontrar ou Criar/Atualizar Atividade
      let idAtividade = atividadesMap.get(normalize(nome_atividade));
      if (!idAtividade) {
        try {
          const [resultAtv] = await connection.query('INSERT INTO atividades (nome, idprofessor) VALUES (?, ?)', [nome_atividade.trim(), idProfessor]);
          idAtividade = resultAtv.insertId;
          atividadesMap.set(normalize(nome_atividade), idAtividade); // Atualiza mapa
        } catch (err) {
          erros.push({ item: m, motivo: `Erro ao criar nova atividade "${nome_atividade}": ${err.message}` });
          continue;
        }
      } else {
        // Se a atividade já existe, garante que o professor está correto
        await connection.query('UPDATE atividades SET idprofessor = ? WHERE idatividades = ?', [idProfessor, idAtividade]);
      }

      // 5. Lógica de UPSERT da Matrícula
      const findSql = 'SELECT idmatricula FROM matricula WHERE idaluno = ? AND dia_semana = ? AND horario = ?';
      const [existingMatricula] = await connection.query(findSql, [idAluno, dia_semana, horario]);

      if (existingMatricula.length > 0) {
        // ATUALIZAR
        const idMatriculaExistente = existingMatricula[0].idmatricula;
        const updateSql = 'UPDATE matricula SET idatividades = ?, turno = ? WHERE idmatricula = ?';
        await connection.query(updateSql, [idAtividade, turno || null, idMatriculaExistente]);
        atualizadas++;
      } else {
        // CRIAR
        const insertSql = 'INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana) VALUES (?, ?, ?, ?, ?)';
        await connection.query(insertSql, [idAluno, idAtividade, turno || null, horario, dia_semana]);
        criadas++;
      }
    }

    // Se tudo deu certo, commita a transação
    await connection.commit();

    res.status(200).json({
      message: 'Processamento de matrículas (Upsert) concluído',
      resumo: {
        total_recebido: matriculas.length,
        criadas: criadas,
        atualizadas: atualizadas,
        erros: erros
      }
    });

  } catch (err) {
    // Se deu algum erro, faz rollback
    if (connection) await connection.rollback();
    console.error("Erro em POST /api/matriculas/upsert-bulk:", err);
    res.status(500).json({ error: 'Erro geral no processamento em lote: ' + err.message });
  } finally {
    // Libera a conexão de volta para o pool
    if (connection) connection.release();
  }
});

// Rota para buscar todas as matrículas de um aluno específico
app.get('/api/matriculas/aluno/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`GET /api/matriculas/aluno/${id} - Buscando matrículas do aluno...`);

  try {
    // A query agora une as tabelas para trazer informações mais completas
    const sql = `
      SELECT
        m.idmatricula,
        m.idaluno,
        m.idatividades,
        atv.nome AS nome_atividade,
        p.nome AS nome_professor,
        m.turno,
        m.horario,
        m.dia_semana
      FROM matricula AS m
      JOIN atividades AS atv ON m.idatividades = atv.idatividades
      JOIN professores AS p ON atv.idprofessor = p.id
      WHERE m.idaluno = ?
    `;
    const [results] = await pool.query(sql, [id]);
    res.json(results);
  } catch (err) {
    console.error(`Erro em GET /api/matriculas/aluno/${id}:`, err);
    res.status(500).json({ error: 'Erro ao buscar as matrículas do aluno: ' + err.message });
  }
});

// Rota para matricular um aluno em uma nova atividade
app.post('/api/matriculas', async (req, res) => {
  const { idaluno, idatividades, turno, horario, dia_semana } = req.body;
  console.log('POST /api/matriculas - Criando nova matrícula...');

  if (!idaluno || !idatividades || !turno || !horario || !dia_semana) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios: idaluno, idatividades, turno, horario, dia_semana.' });
  }

  try {
    const sql = `
      INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana)
      VALUES (?, ?, ?, ?, ?)
    `;
    const [result] = await pool.query(sql, [idaluno, idatividades, turno, horario, dia_semana]);
    res.status(201).json({ idmatricula: result.insertId, message: 'Aluno matriculado com sucesso!' });
  } catch (err) {
    console.error("Erro em POST /api/matriculas:", err);
    res.status(500).json({ error: 'Erro ao criar matrícula: ' + err.message });
  }
});

// Rota para atualizar uma matrícula (ex: trocar de atividade)
app.put('/api/matriculas/:id', async (req, res) => {
  const { id } = req.params;
  const { idatividades, turno, horario, dia_semana } = req.body;
  console.log(`PUT /api/matriculas/${id} - Atualizando matrícula...`);

  if (!idatividades && !turno && !horario && !dia_semana) {
    return res.status(400).json({ error: 'Pelo menos um campo deve ser fornecido para atualização.' });
  }

  try {
    // Constrói a query dinamicamente para atualizar apenas os campos fornecidos
    const fields = [];
    const values = [];
    if (idatividades) { fields.push('idatividades = ?'); values.push(idatividades); }
    if (turno) { fields.push('turno = ?'); values.push(turno); }
    if (horario) { fields.push('horario = ?'); values.push(horario); }
    if (dia_semana) { fields.push('dia_semana = ?'); values.push(dia_semana); }
    values.push(id); // Adiciona o ID da matrícula no final para a cláusula WHERE

    const sql = `UPDATE matricula SET ${fields.join(', ')} WHERE idmatricula = ?`;

    const [result] = await pool.query(sql, values);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Matrícula não encontrada.' });
    }

    res.json({ message: 'Matrícula atualizada com sucesso!' });
  } catch (err) {
    console.error(`Erro em PUT /api/matriculas/${id}:`, err);
    res.status(500).json({ error: 'Erro ao atualizar matrícula: ' + err.message });
  }
});

// Rota para apagar uma matrícula
app.delete('/api/matriculas/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`DELETE /api/matriculas/${id} - Apagando matrícula...`);
  try {
    const sql = "DELETE FROM matricula WHERE idmatricula = ?";
    const [result] = await pool.query(sql, [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Matrícula não encontrada.' });
    }
    res.status(200).json({ message: 'Matrícula apagada com sucesso!' });
  } catch (err) {
    console.error(`Erro em DELETE /api/matriculas/${id}:`, err);
    res.status(500).json({ error: 'Erro ao inativar matrícula: ' + err.message });
  }
});

// Inicia o servidor na porta definida
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Servidor rodando na porta ${PORT}.`);
  console.log(`Para acessar de outros dispositivos na mesma rede, use seu IP local.`);
});
