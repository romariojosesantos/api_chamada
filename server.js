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

// Inicia o servidor na porta definida
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Servidor rodando na porta ${PORT}.`);
  console.log(`Para acessar de outros dispositivos na mesma rede, use seu IP local.`);
});
