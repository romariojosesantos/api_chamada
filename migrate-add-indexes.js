const mysql = require('mysql2/promise');
require('dotenv').config();

async function addPerformanceIndexes() {
  let db;
  try {
    db = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT || 3306
    });
    console.log('Conectado ao banco de dados para adicionar índices de performance.');

    // Helper para criar índice se não existir (MySQL não suporta IF NOT EXISTS em CREATE INDEX)
    const createIndexIfNotExists = async (indexName, tableName, columns) => {
      const [indexes] = await db.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [tableName, indexName]);
      if (indexes.length === 0) {
        await db.query(`CREATE INDEX ${indexName} ON ?? (${columns})`, [tableName]);
        console.log(`Índice ${indexName} criado.`);
      } else {
        console.log(`Índice ${indexName} já existe.`);
      }
    };

    // Adiciona colunas acompanhamento e ponto se não existirem
    const addColumnIfNotExists = async (table, column, definition) => {
      const [cols] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
      );
      if (cols.length === 0) {
        await db.query(`ALTER TABLE ?? ADD COLUMN ${column} ${definition}`, [table]);
        console.log(`Coluna "${column}" adicionada à tabela ${table}.`);
      } else {
        console.log(`Coluna "${column}" já existe em ${table}.`);
      }
    };

    await addColumnIfNotExists('alunos', 'acompanhamento', 'VARCHAR(50) DEFAULT NULL');
    await addColumnIfNotExists('alunos', 'ponto', 'VARCHAR(150) DEFAULT NULL');
    await addColumnIfNotExists('matricula', 'data_inicio', 'DATE DEFAULT (CURDATE())');
    await addColumnIfNotExists('matricula', 'data_fim', 'DATE DEFAULT NULL');

    // Índice para otimizar subquery de dias_matriculados em alunos.js
    await createIndexIfNotExists('idx_matricula_aluno_status', 'matricula', 'idaluno, status, id_instituicao');

    // Índice para otimizar queries de presença em presenca.js
    await createIndexIfNotExists('idx_presenca_inst_data', 'presenca', 'id_instituicao, data');

    // Índice para otimizar query de estatísticas diárias em relatorios.js
    await createIndexIfNotExists('idx_matricula_dia_atividade', 'matricula', 'dia_semana, id_instituicao');

    // Índice composto para otimizar queries de alunos por turno
    await createIndexIfNotExists('idx_alunos_inst_status_turno', 'alunos', 'id_instituicao, status, turno');

    // Índice para otimizar queries de transporte
    await createIndexIfNotExists('idx_alunos_inst_transporte', 'alunos', 'id_instituicao, transporte');

    console.log('Todos os índices de performance foram verificados/criados com sucesso!');
  } catch (error) {
    console.error('Erro ao criar índices:', error);
  } finally {
    if (db) {
      await db.end();
      console.log('Conexão com o banco de dados fechada.');
    }
  }
}

addPerformanceIndexes();
