const mysql = require('mysql2/promise');

async function setupDatabase() {
  let db;
  try {
    // 1. Conecta ao banco de dados
    db = await mysql.createConnection('mysql://romario_novo:RomarioSantos2025@31.97.83.209:3306/chamada_conexao');
    console.log('Conectado com sucesso ao banco de dados MySQL.');

    // 2. Define o SQL para criar as tabelas
    const createAlunosTable = `
      CREATE TABLE IF NOT EXISTS alunos (
        id INT PRIMARY KEY AUTO_INCREMENT,
        nome VARCHAR(255) NOT NULL,
        telefone VARCHAR(20),
        turno VARCHAR(50),
        transporte VARCHAR(100)
      ) ENGINE=InnoDB;
    `;

    const createPresencaTable = `
      CREATE TABLE IF NOT EXISTS presenca (
        id INT PRIMARY KEY AUTO_INCREMENT,
        aluno_id INT NOT NULL,
        data DATE NOT NULL,
        status VARCHAR(20) NOT NULL,
        FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
        UNIQUE KEY idx_aluno_data (aluno_id, data)
      ) ENGINE=InnoDB;
    `;

    const createChamadaConexaoTable = `
      CREATE TABLE IF NOT EXISTS chamada_conexao (
        id INT PRIMARY KEY AUTO_INCREMENT,
        evento VARCHAR(255) NOT NULL,
        detalhes TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        status VARCHAR(20) DEFAULT 'ativo'
      ) ENGINE=InnoDB;
    `;
    // 3. Executa as queries em sequência
    await db.query(createAlunosTable);
    console.log('Tabela "alunos" pronta.');

    await db.query(createPresencaTable);
    console.log('Tabela "presenca" pronta.');

    await db.query(createChamadaConexaoTable);
    console.log('Tabela "chamada_conexao" pronta.');

    await db.query(createMatriculaTable);
    console.log('Tabela "matricula" pronta.');

    // 4. Popula a tabela de alunos com dados iniciais
    const alunos = [
      { nome: 'Ana Silva', telefone: '123456789', turno: 'Manhã', transporte: 'Onibus Branco' },
      { nome: 'Bruno Costa', telefone: '987654321', turno: 'Tarde', transporte: 'Onibus Amarelo'},
      { nome: 'Carlos de Souza', telefone: '555555555', turno: 'Manhã', transporte: 'Onibus Branco'},
      { nome: 'Daniela Martins', telefone: '111111111', turno: 'Tarde', transporte: 'Onibus Amarelo'},
      { nome: 'Eduardo Ferreira', telefone: '999999999', turno: 'Manhã', transporte: 'Onibus Amarelo'},
      { nome: 'Fernanda Lima', telefone: '777777777', turno: 'Tarde', transporte: 'Onibus Branco'},
      { nome: 'Gabriel Ribeiro', telefone: '333333333', turno: 'Manhã', transporte: 'Onibus Branco'},
    ];

    // Desativa temporariamente a verificação de chaves estrangeiras para poder limpar as tabelas
    await db.query('SET FOREIGN_KEY_CHECKS=0;');

    // Limpa as tabelas antes de inserir para evitar duplicatas (ordem: filho, depois pai)
    await db.query('TRUNCATE TABLE presenca');
    await db.query('TRUNCATE TABLE matricula');
    await db.query('TRUNCATE TABLE alunos');
    console.log('Tabelas "alunos", "presenca" e "matricula" limpas.');

    const insertAlunosSQL = 'INSERT INTO alunos (nome, telefone, turno, transporte) VALUES ?';
    const alunosValues = alunos.map(a => [a.nome, a.telefone, a.turno, a.transporte]);

    const [result] = await db.query(insertAlunosSQL, [alunosValues]);
    console.log(`${result.affectedRows} alunos foram inseridos com sucesso.`);

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