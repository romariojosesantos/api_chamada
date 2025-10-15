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
