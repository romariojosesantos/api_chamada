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
  host: '31.97.83.209',
  user: 'romario_novo',
  password: 'RomarioSantos2025',
  database: 'chamada_conexao',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 20, // Aumentado para suportar mais requisições simultâneas
  queueLimit: 0,
  enableKeepAlive: true, // Mantém a conexão ativa com o servidor remoto
  connectTimeout: 20000  // Aumentado para 20 segundos para evitar quedas em redes lentas
});

// Middlewares
app.use(cors()); // Habilita o CORS para todas as rotas

// Aumentado o limite para suportar grandes volumes de dados em importações (Bulk Import)
// O padrão é 100kb, aqui estamos definindo para 50mb.
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Rota pública para listar todas as instituições cadastradas
// Útil para o frontend preencher um Select/Dropdown de escolha de escola
app.get('/api/instituicoes/todas', async (req, res) => {
  try {
    const [results] = await pool.query("SELECT id, nome FROM instituicoes ORDER BY nome ASC");
    res.json(results);
  } catch (err) {
    console.error("Erro em GET /api/instituicoes/todas:", err);
    res.status(500).json({ error: 'Erro ao buscar lista de instituições: ' + err.message });
  }
});

// Middleware para forçar o ID da instituição em todas as rotas da API
app.use('/api', (req, res, next) => {
  const institutionId = req.headers['x-institution-id'];
  
  if (!institutionId) {
    return res.status(401).json({ error: 'Acesso negado. O cabeçalho "x-institution-id" é obrigatório para todas as consultas.' });
  }

  req.id_instituicao = parseInt(institutionId);
  next();
});

// --- Rotas da API ---

// Rota para buscar os dados da instituição atual (baseado no ID enviado no header)
app.get('/api/instituicao', async (req, res) => {
  try {
    const sql = "SELECT * FROM instituicoes WHERE id = ?";
    const [results] = await pool.query(sql, [req.id_instituicao]);
    
    if (results.length === 0) {
      return res.status(404).json({ error: 'Instituição não encontrada.' });
    }
    
    res.json(results[0]); // Retorna o objeto da instituição (id e nome)
  } catch (err) {
    console.error("Erro em GET /api/instituicao:", err);
    res.status(500).json({ error: 'Erro ao buscar dados da instituição: ' + err.message });
  }
});

// Rota para buscar a lista de alunos
app.get('/api/alunos', async (req, res) => {
  console.log(`GET /api/alunos - Instituição: ${req.id_instituicao}`);
  try {
    const sql = "SELECT * FROM alunos WHERE status = 'ativo' AND id_instituicao = ?";
    const [results] = await pool.query(sql, [req.id_instituicao]);
    res.json(results);
  } catch (err) {
    console.error("Erro em GET /api/alunos:", err);
    res.status(500).json({ error: 'Erro ao buscar alunos: ' + err.message });
  }
});

// Rota para buscar alunos que têm aula em um dia específico (por data ou nome do dia)
app.get('/api/alunos/por-dia', async (req, res) => {
  const { dia_semana, data } = req.query;

  let diaDaSemanaParaBusca;

  if (data) {
    // Se a data for fornecida (ex: '2024-05-23'), calcula o dia da semana correspondente.
    try {
      // Adiciona 'T00:00:00' para garantir que a data seja interpretada no fuso horário local do servidor,
      // evitando que a data mude para o dia anterior/posterior.
      const dateObj = new Date(`${data}T00:00:00`);
      if (isNaN(dateObj.getTime())) {
        return res.status(400).json({ error: 'Formato de data inválido. Use AAAA-MM-DD.' });
      }
      
      const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
      diaDaSemanaParaBusca = dias[dateObj.getDay()];

    } catch (e) {
      return res.status(400).json({ error: 'Erro ao processar a data. Use o formato AAAA-MM-DD.' });
    }
  } else if (dia_semana) {
    // Se não houver data, usa o dia_semana fornecido diretamente.
    diaDaSemanaParaBusca = dia_semana;
  } else {
    // Se nenhum dos dois for fornecido, retorna um erro.
    return res.status(400).json({ error: 'O parâmetro "data" (formato AAAA-MM-DD) ou "dia_semana" é obrigatório.' });
  }

  console.log(`GET /api/alunos/por-dia - Buscando alunos para o dia: ${diaDaSemanaParaBusca} (a partir de: ${data || dia_semana})`);

  try {
    // A query usa DISTINCT para garantir que cada aluno apareça apenas uma vez,
    // mesmo que tenha várias aulas no mesmo dia.
    // TRIM é usado para limpar espaços em branco no campo dia_semana, como "Quarta   ".
    const sql = `
      SELECT DISTINCT a.*
      FROM alunos a
      JOIN matricula m ON a.id = m.idaluno
      WHERE TRIM(m.dia_semana) = ? AND a.status = 'ativo' AND m.status = 'matriculado' AND a.id_instituicao = ?
    `;
    const [results] = await pool.query(sql, [diaDaSemanaParaBusca, req.id_instituicao]);
    res.json(results);
  } catch (err) {
    console.error("Erro em GET /api/alunos/por-dia:", err);
    res.status(500).json({ error: 'Erro ao buscar alunos por dia: ' + err.message });
  }
});

// Rota para buscar os dias da semana agendados para um aluno específico
app.get('/api/alunos/:id/dias-agendados', async (req, res) => {
  const { id } = req.params;
  console.log(`GET /api/alunos/${id}/dias-agendados - Buscando dias agendados para o aluno...`);

  try {
    const sql = `
      SELECT DISTINCT m.dia_semana
      FROM matricula AS m
      WHERE m.idaluno = ? AND m.status = 'matriculado' AND m.id_instituicao = ?
      ORDER BY FIELD(m.dia_semana, 'Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado')
    `;
    const [results] = await pool.query(sql, [id, req.id_instituicao]);
    
    // Mapeia os resultados para um array de strings
    const diasAgendados = results.map(row => row.dia_semana);
    
    res.json(diasAgendados);
  } catch (err) {
    console.error(`Erro em GET /api/alunos/${id}/dias-agendados:`, err);
    res.status(500).json({ error: 'Erro ao buscar dias agendados do aluno: ' + err.message });
  }
});

// Rota para criar um novo aluno
app.post('/api/alunos', async (req, res) => {
  const { nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf, instituicao, status } = req.body;
  console.log('POST /api/alunos - Criando novo aluno...');

  // Validação básica
  if (!nome) {
    return res.status(400).json({ error: 'O campo "nome" é obrigatório.' });
  }

  try {
    const sql = `
      INSERT INTO alunos (nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf, status, id_instituicao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const [result] = await pool.query(sql, [nome, data_nascimento || null, sexo || null, telefone || null, turma || null, turno || null, transporte || null, Inf || null, status || 'ativo', req.id_instituicao]);
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
    const [atvs] = await pool.query('SELECT idatividades, nome FROM atividades WHERE id_instituicao = ?', [req.id_instituicao]);
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
      const checkSql = 'SELECT id FROM alunos WHERE nome = ? AND id_instituicao = ? LIMIT 1';
      const [existing] = await pool.query(checkSql, [aluno.nome, req.id_instituicao]);

      if (existing.length > 0) {
        ignorados++;
        continue;
      }

      // 4. Inserção
      const insertSql = `
        INSERT INTO alunos (nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf, status, id_instituicao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const values = [
        aluno.nome,
        data_nascimento || null,
        sexo,
        aluno.telefone || null,
        aluno.turma || null,
        aluno.turno || null,
        aluno.transporte || null,
        aluno.Inf || null,
        aluno.status || 'ativo',
        req.id_instituicao
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
              m.dia_semana || null,
              'matriculado',
              req.id_instituicao
            ]);
          }
        }

        if (matriculasValues.length > 0) {
          const insertMatriculaSql = 'INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, status, id_instituicao) VALUES ?';
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

// Rota para Importação/Atualização em Lote de Alunos (Upsert)
app.post('/api/alunos/upsert-bulk', async (req, res) => {
  const alunos = req.body; // Array de alunos enviado pelo frontend
  console.log('POST /api/alunos/upsert-bulk - Iniciando upsert de alunos em lote...');

  if (!Array.isArray(alunos)) {
    return res.status(400).json({ error: 'O corpo da requisição deve ser um array de alunos.' });
  }

  // Objeto para retornar o resumo da operação
  const resumo = {
    total_recebido: alunos.length,
    criados: 0,
    atualizados: 0,
    deletados: 0,
    erros: []
  };

  // Helper para normalizar nomes e Maps para cache
  const normalize = (str) => String(str || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const atividadesMap = new Map();
  const professoresMap = new Map();

  let connection;
  try {
    const processedIds = []; // Lista para guardar IDs que devem ser mantidos

    // Obtém uma conexão do pool para realizar a transação
    connection = await pool.getConnection();
    await connection.beginTransaction(); // Inicia uma transação

    // Pré-carrega mapas para eficiência (necessário para processar matrículas aninhadas)
    const [atividadesDB] = await connection.query('SELECT idatividades, nome FROM atividades WHERE id_instituicao = ?', [req.id_instituicao]);
    atividadesDB.forEach(a => atividadesMap.set(normalize(a.nome), a.idatividades));

    const [professoresDB] = await connection.query('SELECT id, nome FROM professores WHERE id_instituicao = ?', [req.id_instituicao]);
    professoresDB.forEach(p => professoresMap.set(normalize(p.nome), p.id));

    for (const aluno of alunos) {
      try {
        // Normalização de Data de Nascimento (Correção para datas do Excel)
        let data_nascimento = aluno.data_nascimento;
        // Verifica se é um valor numérico (serial Excel) e não uma string de data formatada
        if (data_nascimento && !isNaN(data_nascimento)) {
          const serial = parseFloat(data_nascimento);
          // Seriais de datas recentes (2000+) são > 10000. Evita tratar anos (ex: "2015") como serial.
          if (serial > 10000) {
            // 25569 é o offset Excel->Unix. +43200000ms (12h) compensa fuso horário/arredondamento
            const dateObj = new Date(((serial - 25569) * 86400000) + 43200000);
            try {
              data_nascimento = dateObj.toISOString().split('T')[0];
            } catch (e) { /* Mantém o valor original se falhar */ }
          }
        }

        // 1. Verifica se o aluno já existe pelo NOME (ignorando maiúsculas/minúsculas)
        const [checkRes] = await connection.query(
          'SELECT id FROM alunos WHERE LOWER(nome) = LOWER(?) AND id_instituicao = ? LIMIT 1',
          [aluno.nome, req.id_instituicao]
        );

        let alunoId;

        if (checkRes.length > 0) {
          // --- CENÁRIO: ALUNO EXISTE -> ATUALIZAR ---
          alunoId = checkRes[0].id;

          await connection.query(
            `UPDATE alunos SET 
              data_nascimento = ?,
              sexo = ?,
              telefone = ?,
              turma = ?,
              turno = ?,
              transporte = ?,
              Inf = ?,
              status = ?
             WHERE id = ? AND id_instituicao = ?`,
            [
              data_nascimento || null,
              aluno.sexo,
              aluno.telefone,
              aluno.turma,
              aluno.turno,
              aluno.transporte,
              aluno.Inf,
              aluno.status || 'ativo',
              alunoId,
              req.id_instituicao
            ]
          );
          resumo.atualizados++;
        } else {
          // --- CENÁRIO: ALUNO NÃO EXISTE -> CRIAR ---
          const [insertRes] = await connection.query(
            `INSERT INTO alunos (nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf, status, id_instituicao)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              aluno.nome,
              data_nascimento || null,
              aluno.sexo,
              aluno.telefone,
              aluno.turma,
              aluno.turno,
              aluno.transporte,
              aluno.Inf,
              aluno.status || 'ativo',
              req.id_instituicao
            ]
          );
          alunoId = insertRes.insertId;
          resumo.criados++;
        }

        processedIds.push(alunoId);

        // 2. Processar Matrículas (se houver na planilha)
        // Implementa a lógica de sincronização para as matrículas deste aluno
        if (aluno.matriculas && Array.isArray(aluno.matriculas)) {
          const currentStudentMatriculaKeys = new Set(); // Set de strings "dia_semana|||horario" para este aluno da entrada
          const matriculasToUpsertForStudent = []; // Matrículas processadas para este aluno

          for (const mat of aluno.matriculas) {
            // Resolve idatividades (assumindo que atividadesMap e professoresMap estão disponíveis do escopo externo)
            let idAtividade = mat.idatividades;
            // Se o ID não foi informado, tenta encontrar pelo nome da atividade
            if (!idAtividade && mat.nome_atividade) {
              idAtividade = atividadesMap.get(normalize(mat.nome_atividade));
            }
            // Se a atividade ainda não foi encontrada, ou o professor não foi encontrado, lida com o erro ou pula
            if (!idAtividade) {
                // Esta é uma manipulação de erro simplificada. Em uma aplicação real, você pode querer coletar esses erros.
                console.warn(`Atividade "${mat.nome_atividade}" não encontrada para aluno ${aluno.nome}. Matrícula ignorada.`);
                continue;
            }

            // Se o professor for fornecido na matrícula, garante que a atividade tenha o professor correto
            if (mat.nome_professor) {
                let idProfessorMatricula = professoresMap.get(normalize(mat.nome_professor));
                if (!idProfessorMatricula) {
                    try {
                        const [resultProf] = await connection.query('INSERT INTO professores (nome, id_instituicao) VALUES (?, ?)', [mat.nome_professor.trim(), req.id_instituicao]);
                        idProfessorMatricula = resultProf.insertId;
                        professoresMap.set(normalize(mat.nome_professor), idProfessorMatricula);
                    } catch (err) {
                        console.warn(`Erro ao criar professor automático "${mat.nome_professor}" para atividade ${mat.nome_atividade}:`, err.message);
                    }
                }
                if (idProfessorMatricula) {
                    await connection.query('UPDATE atividades SET idprofessor = ? WHERE idatividades = ? AND id_instituicao = ?', [idProfessorMatricula, idAtividade, req.id_instituicao]);
                }
            }

            const normalizedDiaSemana = (mat.dia_semana || '').trim();
            const normalizedHorario = (mat.horario || '').trim();
            const normalizedTurno = (mat.turno || '').trim();

            matriculasToUpsertForStudent.push({
                idaluno: alunoId,
                idatividades: idAtividade,
                turno: normalizedTurno || null,
                horario: normalizedHorario,
                dia_semana: normalizedDiaSemana,
                id_instituicao: req.id_instituicao
            });
            currentStudentMatriculaKeys.add(`${normalizedDiaSemana}|||${normalizedHorario}`);
          }

          // Upsert as matrículas recebidas para este aluno
          for (const mat of matriculasToUpsertForStudent) {
            const insertUpdateSql = `
              INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, id_instituicao)
              VALUES (?, ?, ?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE
                idatividades = VALUES(idatividades),
                turno = VALUES(turno);
            `;
            await connection.query(insertUpdateSql, [
              mat.idaluno,
              mat.idatividades,
              mat.turno,
              mat.horario,
              mat.dia_semana,
              mat.id_instituicao
            ]);
            // Nota: Contar criadas/atualizadas aqui seria complexo, pois é por aluno dentro de um loop de alunos.
            // A rota principal /api/matriculas/upsert-bulk é melhor para contagens detalhadas de matrículas.
          }
        }

      } catch (err) {
        console.error(`Erro ao processar aluno ${aluno.nome}:`, err);
        resumo.erros.push({ nome: aluno.nome, erro: err.message });
      }
    }

    // Opcional: Remover alunos que NÃO estão na planilha (Sincronização total)
    /*
    const [delRes] = await connection.query('DELETE FROM alunos WHERE id_instituicao = ? AND id NOT IN (?)', [req.id_instituicao, processedIds]);
    resumo.deletados = delRes.affectedRows;
    */

    await connection.commit(); // Confirma todas as alterações
    res.json({ message: 'Processamento concluído com sucesso.', resumo });

  } catch (error) {
    // Se a conexão existir e a transação foi iniciada, tenta fazer o rollback.
    // Envolve em um try-catch pois o rollback pode falhar se a conexão já foi perdida (ex: timeout).
    try {
      if (connection) await connection.rollback();
    } catch (rollbackError) {
      console.error("Erro ao tentar fazer rollback na rota de alunos:", rollbackError);
    }
    console.error("Erro fatal na rota upsert-bulk:", error);
    res.status(500).json({ error: "Erro de conexão ou processamento no banco de dados: " + error.message });
  } finally {
    if (connection) connection.release(); // Libera a conexão
  }
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
        const [rows] = await pool.query('SELECT id FROM alunos WHERE nome = ? AND id_instituicao = ? LIMIT 1', [aluno.nome, req.id_instituicao]);
        if (rows.length > 0) {
          alunoId = rows[0].id;
        }
      }

      if (!alunoId) {
        naoEncontrados++;
        continue;
      }

      // 1. Excluir matrículas associadas (para manter consistência e evitar erros de FK se não houver CASCADE)
      await pool.query('DELETE FROM matricula WHERE idaluno = ? AND id_instituicao = ?', [alunoId, req.id_instituicao]);

      // 2. Excluir o aluno
      const [result] = await pool.query('DELETE FROM alunos WHERE id = ? AND id_instituicao = ?', [alunoId, req.id_instituicao]);

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
    const deleteMatriculasSql = 'DELETE FROM matricula WHERE idaluno = ? AND id_instituicao = ?';
    await pool.query(deleteMatriculasSql, [id, req.id_instituicao]);
    console.log(`Matrículas do aluno ${id} excluídas.`);

    // Agora, delete o aluno
    const deleteAlunoSql = 'DELETE FROM alunos WHERE id = ? AND id_instituicao = ?';
    const [result] = await pool.query(deleteAlunoSql, [id, req.id_instituicao]);

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
  const colunasPermitidas = ['data_nascimento', 'sexo', 'telefone', 'turma', 'turno', 'transporte', 'Inf', 'status'];
  if (!colunasPermitidas.includes(campo)) {
    return res.status(400).json({ error: `O campo "${campo}" não pode ser atualizado por esta rota.` });
  }

  try {
    // 3. Construção e execução da query
    const sql = 'UPDATE alunos SET ?? = ? WHERE nome = ? AND id_instituicao = ?';
    const [result] = await pool.query(sql, [campo, valor, nome, req.id_instituicao]);

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

// Rota para buscar alunos sem faltas no período, considerando apenas os dias de aula (matrícula)
app.get('/api/alunos/frequencia-plena', async (req, res) => {
  const { inicio, fim } = req.query;

  if (!inicio || !fim) {
    return res.status(400).json({ error: 'Os parâmetros "inicio" e "fim" (AAAA-MM-DD) são obrigatórios.' });
  }

  console.log(`GET /api/alunos/frequencia-plena - Período: ${inicio} até ${fim}`);

  try {
    const sql = `
      SELECT 
        a.id, a.nome, a.turno, a.turma, a.transporte,
        GROUP_CONCAT(DISTINCT DATE_FORMAT(p.data, '%Y-%m-%d') ORDER BY p.data ASC) as dias_presente,
        COUNT(DISTINCT p.data) as total_presencas_nas_matrículas
      FROM alunos a
      /* Join com presença e matrícula simultaneamente para contar apenas presenças em dias de aula oficial */
      INNER JOIN presenca p ON a.id = p.aluno_id AND p.status = 'presente' AND p.data BETWEEN ? AND ? AND p.id_instituicao = ?
      INNER JOIN matricula m ON a.id = m.idaluno AND TRIM(m.dia_semana) = CASE DAYOFWEEK(p.data)
          WHEN 1 THEN 'Domingo'
          WHEN 2 THEN 'Segunda'
          WHEN 3 THEN 'Terça'
          WHEN 4 THEN 'Quarta'
          WHEN 5 THEN 'Quinta'
          WHEN 6 THEN 'Sexta'
          WHEN 7 THEN 'Sábado'
      END
      WHERE a.id_instituicao = ?
      GROUP BY a.id, a.nome, a.turno, a.turma, a.transporte
      /* O aluno só entra na lista se o total de presenças úteis for igual ao total de dias letivos para a grade dele */
      HAVING total_presencas_nas_matrículas = (
          SELECT COUNT(DISTINCT d.data)
          FROM (SELECT DISTINCT data FROM presenca WHERE data BETWEEN ? AND ? AND id_instituicao = ?) d
          INNER JOIN matricula m2 ON m2.idaluno = a.id AND m2.id_instituicao = ?
          WHERE TRIM(m2.dia_semana) = CASE DAYOFWEEK(d.data)
              WHEN 1 THEN 'Domingo'
              WHEN 2 THEN 'Segunda'
              WHEN 3 THEN 'Terça'
              WHEN 4 THEN 'Quarta'
              WHEN 5 THEN 'Quinta'
              WHEN 6 THEN 'Sexta'
              WHEN 7 THEN 'Sábado'
          END AND m2.status = 'matriculado'
      )
      ORDER BY a.nome ASC
    `;

    const [results] = await pool.query(sql, [inicio, fim, req.id_instituicao, req.id_instituicao, inicio, fim, req.id_instituicao, req.id_instituicao]);
    res.json(results);
  } catch (err) {
    console.error("Erro em /api/alunos/frequencia-plena:", err);
    res.status(500).json({ error: 'Erro ao processar relatório de frequência: ' + err.message });
  }
});

// Rota para buscar os registros de presença
app.get('/api/presenca', async (req, res) => {
  console.log('GET /api/presenca - Enviando registros de presença...');
  try {
    const sql = "SELECT aluno_id, data, status FROM presenca WHERE id_instituicao = ?";
    const [results] = await pool.query(sql, [req.id_instituicao]);
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
      INSERT INTO presenca (aluno_id, data, status, id_instituicao)
      VALUES ?
      ON DUPLICATE KEY UPDATE status = VALUES(status);
    `;
    const values = chamadas.map(c => [c.aluno_id, data, c.status, req.id_instituicao]);
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
      WHERE m.status = 'matriculado' AND a.status = 'ativo' AND m.id_instituicao = ?
    `;
    const [results] = await pool.query(sql, [req.id_instituicao]);
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
    const [alunosDB] = await pool.query('SELECT id, nome FROM alunos WHERE id_instituicao = ?', [req.id_instituicao]);
    alunosDB.forEach(a => alunosMap.set(normalize(a.nome), a.id));

    const [atividadesDB] = await pool.query('SELECT idatividades, nome FROM atividades WHERE id_instituicao = ?', [req.id_instituicao]);
    atividadesDB.forEach(a => atividadesMap.set(normalize(a.nome), a.idatividades));

    const [professoresDB] = await pool.query('SELECT id, nome FROM professores WHERE id_instituicao = ?', [req.id_instituicao]);
    professoresDB.forEach(p => professoresMap.set(normalize(p.nome), p.id));

    // Carrega matrículas existentes para evitar duplicatas
    const [dbMatriculas] = await pool.query('SELECT idaluno, idatividades, dia_semana, horario FROM matricula WHERE id_instituicao = ?', [req.id_instituicao]);
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
          const [resultProf] = await pool.query('INSERT INTO professores (nome, id_instituicao) VALUES (?, ?)', [nomeProfessor.trim(), req.id_instituicao]);
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
        const [resultAtv] = await pool.query('INSERT INTO atividades (nome, idprofessor, id_instituicao) VALUES (?, ?, ?)', [matricula.nome_atividade.trim(), idProfessor, req.id_instituicao]);
        idAtividade = resultAtv.insertId;
        atividadesMap.set(normalize(matricula.nome_atividade), idAtividade); // Atualiza o mapa para as próximas linhas
      } catch (err) {
        erros.push({ item: m, motivo: `Erro ao criar atividade automática "${matricula.nome_atividade}": ${err.message}` });
        continue;
      }
    } else if (idProfessor) {
      // Se a atividade já existe e temos um professor na planilha, atualizamos o vínculo
      try {
        await pool.query('UPDATE atividades SET idprofessor = ? WHERE idatividades = ? AND id_instituicao = ?', [idProfessor, idAtividade, req.id_instituicao]);
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
      matricula.dia_semana,
      req.id_instituicao
    ]);
    existingMatriculas.add(matriculaKey); // Evita duplicatas dentro do mesmo arquivo
  }

  // 5. Insere todas as novas matrículas de uma vez
  if (matriculasParaInserir.length > 0) {
    try {
      const insertMatriculaSql = 'INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, id_instituicao) VALUES ?';
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
  const resumo = {
    total_recebido: matriculas.length,
    criadas: 0,
    atualizadas: 0,
    deletadas: 0, // Adicionado para contagem de matrículas deletadas
    erros: []
  };

  try {
    // Pega uma conexão do pool para realizar a transação
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Pré-carrega mapas para eficiência
    // Helper para normalizar nomes (remove espaços duplicados e converte para minúsculo)
    const normalize = (str) => String(str || '').trim().replace(/\s+/g, ' ').toLowerCase();

    const [alunosDB] = await connection.query('SELECT id, nome FROM alunos WHERE id_instituicao = ?', [req.id_instituicao]);
    alunosDB.forEach(a => alunosMap.set(normalize(a.nome), a.id));

    const [atividadesDB] = await connection.query('SELECT idatividades, nome FROM atividades WHERE id_instituicao = ?', [req.id_instituicao]);
    atividadesDB.forEach(a => atividadesMap.set(normalize(a.nome), a.idatividades));

    const [professoresDB] = await connection.query('SELECT id, nome FROM professores WHERE id_instituicao = ?', [req.id_instituicao]);
    professoresDB.forEach(p => professoresMap.set(normalize(p.nome), p.id));
    
    const studentMatriculaKeys = new Map(); // Map: idaluno -> Set de strings "dia_semana|||horario" da entrada
    const matriculasToProcess = []; // Armazena matrículas processadas com IDs resolvidos

    for (const m of matriculas) {
      // Normaliza as chaves do objeto para minúsculas
      const matricula = {};
      for (const key in m) {
        matricula[key.toLowerCase().trim()] = m[key];
      }

      const { nome_aluno, turno, dia_semana, horario, nome_atividade } = matricula;
      const nomeProfessor = matricula.professor || matricula.nome_professor; // Aceita "professor" ou "nome_professor"

      // 1. Validação dos campos obrigatórios
      if (!nome_aluno || !nome_atividade || !dia_semana || !horario || !nomeProfessor) {
        resumo.erros.push({ item: m, motivo: 'Campos obrigatórios ausentes (nome_aluno, nome_atividade, dia_semana, horario, professor).' });
        continue;
      }

      // 2. Encontrar Aluno
      const idAluno = alunosMap.get(normalize(nome_aluno));
      if (!idAluno) {
        resumo.erros.push({ item: m, motivo: `Aluno "${nome_aluno}" não encontrado no banco de dados.` });
        continue;
      }

      // 3. Encontrar ou Criar Professor
      let idProfessor = professoresMap.get(normalize(nomeProfessor));
      if (!idProfessor) {
        try {
          const [resultProf] = await connection.query('INSERT INTO professores (nome, id_instituicao) VALUES (?, ?)', [nomeProfessor.trim(), req.id_instituicao]);
          idProfessor = resultProf.insertId;
          professoresMap.set(normalize(nomeProfessor), idProfessor); // Atualiza o mapa para as próximas linhas
        } catch (err) {
          resumo.erros.push({ item: m, motivo: `Erro ao criar novo professor "${nomeProfessor}": ${err.message}` });
          continue;
        }
      }

      // 4. Encontrar ou Criar/Atualizar Atividade
      let idAtividade = atividadesMap.get(normalize(nome_atividade));
      if (!idAtividade) {
        try {
          const [resultAtv] = await connection.query('INSERT INTO atividades (nome, idprofessor, id_instituicao) VALUES (?, ?, ?)', [nome_atividade.trim(), idProfessor, req.id_instituicao]);
          idAtividade = resultAtv.insertId;
          atividadesMap.set(normalize(nome_atividade), idAtividade); // Atualiza o mapa
        } catch (err) {
          resumo.erros.push({ item: m, motivo: `Erro ao criar nova atividade "${nome_atividade}": ${err.message}` });
          continue;
        }
      } else {
        // Se a atividade já existe, garante que o professor está correto
        await connection.query('UPDATE atividades SET idprofessor = ? WHERE idatividades = ? AND id_instituicao = ?', [idProfessor, idAtividade, req.id_instituicao]);
      }
      
      const normalizedDiaSemana = (dia_semana || '').trim();
      const normalizedHorario = (horario || '').trim();
      const normalizedTurno = (turno || '').trim();

      matriculasToProcess.push({
        idaluno: idAluno,
        idatividades: idAtividade,
        turno: normalizedTurno || null,
        horario: normalizedHorario,
        dia_semana: normalizedDiaSemana,
        id_instituicao: req.id_instituicao
      });

      // Armazena a chave única para a lógica de exclusão posterior
      if (!studentMatriculaKeys.has(idAluno)) {
        studentMatriculaKeys.set(idAluno, new Set());
      }
      // Usa um delimitador único para evitar problemas se o horário contiver um hífen
      studentMatriculaKeys.get(idAluno).add(`${normalizedDiaSemana}|||${normalizedHorario}`);
    }

    // --- Fase de Processamento com Histórico ---
    for (const mat of matriculasToProcess) {
      const [existing] = await connection.query(
        'SELECT idmatricula, idatividades FROM matricula WHERE idaluno = ? AND TRIM(dia_semana) = ? AND horario = ? AND status = "matriculado" AND id_instituicao = ? LIMIT 1',
        [mat.idaluno, mat.dia_semana, mat.horario, req.id_instituicao]
      );

      if (existing.length > 0) {
        if (existing[0].idatividades === mat.idatividades) {
          // Mesma atividade e turno, apenas atualizar o turno se mudou (opcional)
          await connection.query('UPDATE matricula SET turno = ? WHERE idmatricula = ? AND id_instituicao = ?', [mat.turno, existing[0].idmatricula, req.id_instituicao]);
          resumo.atualizadas++;
          continue;
        }
        // Atividade diferente: Cancela a anterior
        await connection.query('UPDATE matricula SET status = "cancelada" WHERE idmatricula = ? AND id_instituicao = ?', [existing[0].idmatricula, req.id_instituicao]);
      }

      // Cria a nova matrícula como 'matriculado'
      const insertSql = `
        INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, status, id_instituicao)
        VALUES (?, ?, ?, ?, ?, "matriculado", ?)
      `;
      await connection.query(insertSql, [mat.idaluno, mat.idatividades, mat.turno, mat.horario, mat.dia_semana, req.id_instituicao]);
      resumo.criadas++;
    }

    // Se tudo deu certo, commita a transação
    await connection.commit();

    res.status(200).json({
      message: 'Processamento de matrículas (Upsert) concluído',
      resumo: {
        total_recebido: matriculas.length,
        criadas: resumo.criadas,
        atualizadas: resumo.atualizadas,
        deletadas: resumo.deletadas,
        erros: resumo.erros
      }
    });

  } catch (err) {
    // Se a conexão existir e a transação foi iniciada, tenta fazer o rollback.
    // Envolve em um try-catch pois o rollback pode falhar se a conexão já foi perdida (ex: timeout).
    try {
      if (connection) await connection.rollback();
    } catch (rollbackError) {
      console.error("Erro ao tentar fazer rollback na rota de matrículas:", rollbackError);
    }

    console.error("Erro em POST /api/matriculas/upsert-bulk:", err);
    res.status(500).json({ error: 'Erro de conexão ou processamento na importação de matrículas: ' + err.message });
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
      WHERE m.idaluno = ? AND m.status = 'matriculado'
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
      INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, id_instituicao)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const [result] = await pool.query(sql, [idaluno, idatividades, turno, horario, dia_semana, req.id_instituicao]);
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
    values.push(req.id_instituicao);

    const sql = `UPDATE matricula SET ${fields.join(', ')} WHERE idmatricula = ? AND id_instituicao = ?`;

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
    const sql = "DELETE FROM matricula WHERE idmatricula = ? AND id_instituicao = ?";
    const [result] = await pool.query(sql, [id, req.id_instituicao]);
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
