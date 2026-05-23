const mysql = require('mysql2/promise');
require('dotenv').config();

async function setupDatabase() {
  let db;
  try {
    // 1. Conecta ao banco de dados
    db = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT || 3306
    });
    console.log('Conectado com sucesso ao banco de dados MySQL.');

    // Desativa a verificação de chaves estrangeiras para permitir o reset das tabelas
    await db.query('SET FOREIGN_KEY_CHECKS=0;');

    // Remove as tabelas existentes para garantir que o novo esquema (com id_instituicao) seja aplicado.
    const tablesToReset = ['presenca', 'matricula', 'atividades', 'professores', 'alunos', 'instituicoes', 'chamada_conexao'];
    for (const table of tablesToReset) {
      await db.query(`DROP TABLE IF EXISTS ${table}`);
    }
    console.log('Tabelas antigas removidas para atualização de esquema.');

    // 2. Define o SQL para criar as tabelas
    const createInstituicoesTable = `
      CREATE TABLE IF NOT EXISTS instituicoes (
        id INT PRIMARY KEY AUTO_INCREMENT,
        nome VARCHAR(255) NOT NULL
      ) ENGINE=InnoDB;
    `;

    const createAlunosTable = `
      CREATE TABLE IF NOT EXISTS alunos (
        id INT PRIMARY KEY AUTO_INCREMENT,
        nome VARCHAR(255) NOT NULL,
        data_nascimento DATE DEFAULT NULL,
        sexo VARCHAR(1) DEFAULT NULL,
        telefone VARCHAR(20) DEFAULT NULL,
        turma VARCHAR(10) DEFAULT NULL,
        turno VARCHAR(50) DEFAULT NULL,
        transporte VARCHAR(100) DEFAULT NULL,
        Inf VARCHAR(60) DEFAULT NULL,
        status VARCHAR(20) DEFAULT 'ativo',
        id_instituicao INT NOT NULL,
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id),
        UNIQUE KEY idx_nome_inst (nome, id_instituicao)
      ) ENGINE=InnoDB;
    `;

    const createProfessoresTable = `
      CREATE TABLE IF NOT EXISTS professores (
        id INT PRIMARY KEY AUTO_INCREMENT,
        nome VARCHAR(100) NOT NULL,
        id_instituicao INT NOT NULL,
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id)
      ) ENGINE=InnoDB;
    `;

    const createAtividadesTable = `
      CREATE TABLE IF NOT EXISTS atividades (
        idatividades INT PRIMARY KEY AUTO_INCREMENT,
        nome VARCHAR(60) NOT NULL,
        idprofessor INT,
        id_instituicao INT NOT NULL,
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id)
      ) ENGINE=InnoDB;
    `;

    const createPresencaTable = `
      CREATE TABLE IF NOT EXISTS presenca (
        id INT PRIMARY KEY AUTO_INCREMENT,
        aluno_id INT NOT NULL,
        data DATE NOT NULL,
        status VARCHAR(20) NOT NULL,
        observacao TEXT DEFAULT NULL,
        id_instituicao INT NOT NULL,
        FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id),
        UNIQUE KEY idx_aluno_inst_data (aluno_id, id_instituicao, data)
      ) ENGINE=InnoDB;
    `;

    const createChamadaConexaoTable = `
      CREATE TABLE IF NOT EXISTS chamada_conexao (
        id INT PRIMARY KEY AUTO_INCREMENT,
        evento VARCHAR(255) NOT NULL,
        detalhes TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        id_instituicao INT,
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id)
      ) ENGINE=InnoDB;
    `;

    const createMatriculaTable = `
      CREATE TABLE IF NOT EXISTS matricula (
        idmatricula INT PRIMARY KEY AUTO_INCREMENT,
        idaluno INT,
        idatividades INT,
        turno VARCHAR(45),
        horario VARCHAR(45),
        dia_semana VARCHAR(45),
        status VARCHAR(20) DEFAULT 'matriculado',
        id_instituicao INT NOT NULL,
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id)
      ) ENGINE=InnoDB;
    `;

    // 3. Executa as queries em sequência
    await db.query(createInstituicoesTable);
    console.log('Tabela "instituicoes" pronta.');

    await db.query(createAlunosTable);
    console.log('Tabela "alunos" pronta.');

    await db.query(createProfessoresTable);
    console.log('Tabela "professores" pronta.');

    await db.query(createAtividadesTable);
    console.log('Tabela "atividades" pronta.');

    await db.query(createPresencaTable);
    console.log('Tabela "presenca" pronta.');

    await db.query(createChamadaConexaoTable);
    console.log('Tabela "chamada_conexao" pronta.');

    await db.query(createMatriculaTable);
    console.log('Tabela "matricula" pronta.');

    // 4. Insere uma instituição de teste
    const [instResult] = await db.query('INSERT INTO instituicoes (nome) VALUES (?)', ['Instituição Padrão']);
    const instId = instResult.insertId;

    const insertAlunosSQL = 'INSERT INTO alunos (nome, telefone, turno, transporte, id_instituicao) VALUES ?';
    const alunosValues = [
      ['Ana Silva', '123456789', 'Manhã', 'Onibus Branco', instId],
      ['Bruno Costa', '987654321', 'Tarde', 'Onibus Amarelo', instId]
    ];

    await db.query(insertAlunosSQL, [alunosValues]);
    console.log('Dados iniciais inseridos para a instituição ' + instId);

    // Reativa a verificação de chaves estrangeiras
    await db.query('SET FOREIGN_KEY_CHECKS=1;');

  } catch (error) {
    console.error('Ocorreu um erro durante a configuração do banco de dados:', error);
  } finally {
    // 5. Garante que a conexão seja fechada no final
    if (db) {
      await db.end();
      console.log('Conexão com o banco de dados fechada.');
    }
  }
}

setupDatabase();