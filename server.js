// /minha-api/server.js

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

// Inicializa o aplicativo Express
const app = express();
const PORT = 3001;

// --- Conexão com o Banco de Dados ---
// Abre o banco de dados em modo leitura/escrita e o cria se não existir.
const db = new sqlite3.Database('./database.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('Erro ao conectar com o banco de dados:', err.message);
  } else {
    console.log('Conectado ao banco de dados SQLite.');
  }
});

// Middlewares
app.use(cors()); // Habilita o CORS para todas as rotas
app.use(express.json()); // Permite que o servidor entenda requisições com corpo em JSON

// --- Banco de Dados Falso (Mock Data) ---
// Em uma aplicação real, estes dados viriam de um banco de dados.

// --- Rotas da API ---

// Rota para buscar a lista de alunos
app.get('/api/alunos', (req, res) => {
  console.log('GET /api/alunos - Enviando lista de alunos...');
  const sql = "SELECT * FROM alunos";
  db.all(sql, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Rota para buscar os registros de presença
app.get('/api/presenca', (req, res) => {
  console.log('GET /api/presenca - Enviando registros de presença...');
  const sql = "SELECT aluno_id, data, status FROM presenca";
  db.all(sql, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Rota para salvar/atualizar os registros de presença de um dia
app.post('/api/presenca', (req, res) => {
  const { data, chamadas } = req.body;

  // Validação básica dos dados recebidos
  if (!data || !Array.isArray(chamadas)) {
    return res.status(400).json({ error: 'Dados inválidos. É necessário fornecer a data e um array de chamadas.' });
  }

  console.log(`POST /api/presenca - Salvando chamada para o dia: ${data}`);

  // Usamos db.serialize para garantir que os comandos sejam executados em ordem (transação)
  db.serialize(() => {
    // 1. Deleta os registros antigos para o dia especificado, para evitar duplicatas
    const deleteSql = "DELETE FROM presenca WHERE data = ?";
    db.run(deleteSql, [data], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      // 2. Insere os novos registros de presença
      const insertSql = "INSERT INTO presenca (aluno_id, data, status) VALUES (?, ?, ?)";
      const stmt = db.prepare(insertSql);
      chamadas.forEach(chamada => {
        stmt.run(chamada.aluno_id, data, chamada.status);
      });
      stmt.finalize();

      res.status(201).json({ message: `Presença para o dia ${data} salva com sucesso!` });
    });
  });
});

// Inicia o servidor na porta definida
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Servidor rodando na porta ${PORT}.`);
  console.log(`Para acessar de outros dispositivos na mesma rede, use seu IP local.`);
});
