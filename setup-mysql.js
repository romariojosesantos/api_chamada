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

    // SEGURANÇA: O comando de DROP TABLE foi removido para evitar a perda de dados existentes.
    // O sistema agora apenas criará as tabelas caso elas ainda não existam.
    console.log('Verificando integridade das tabelas...');

    // 2. Define o SQL para criar as tabelas
    const createInstituicoesTable = `
      CREATE TABLE IF NOT EXISTS instituicoes (
        id INT PRIMARY KEY AUTO_INCREMENT,
        nome VARCHAR(255) NOT NULL
      ) ENGINE=InnoDB;
    `;

    const createUsuariosTable = `
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT PRIMARY KEY AUTO_INCREMENT,
        nome VARCHAR(150) NOT NULL,
        email VARCHAR(180) NOT NULL UNIQUE,
        senha_hash VARCHAR(255) NOT NULL,
        perfil VARCHAR(30) NOT NULL DEFAULT 'monitor',
        status VARCHAR(20) DEFAULT 'ativo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `;

    const createUsuarioInstituicoesTable = `
      CREATE TABLE IF NOT EXISTS usuario_instituicoes (
        id INT PRIMARY KEY AUTO_INCREMENT,
        id_usuario INT NOT NULL,
        id_instituicao INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_usuario) REFERENCES usuarios(id) ON DELETE CASCADE,
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id) ON DELETE CASCADE,
        UNIQUE KEY idx_usuario_instituicao (id_usuario, id_instituicao)
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
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id),
        UNIQUE KEY idx_prof_inst (nome, id_instituicao)
      ) ENGINE=InnoDB;
    `;

    const createAtividadesTable = `
      CREATE TABLE IF NOT EXISTS atividades (
        idatividades INT PRIMARY KEY AUTO_INCREMENT,
        nome VARCHAR(60) NOT NULL,
        idprofessor INT,
        exibir_no_resumo TINYINT(1) DEFAULT 1,
        id_instituicao INT NOT NULL,
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id),
        UNIQUE KEY idx_atv_inst (nome, id_instituicao)
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
        idaluno INT NOT NULL,
        idatividades INT NOT NULL,
        turno VARCHAR(45) NOT NULL DEFAULT '',
        horario VARCHAR(45) NOT NULL DEFAULT '',
        dia_semana VARCHAR(45) NOT NULL DEFAULT '',
        status VARCHAR(20) DEFAULT 'matriculado',
        id_instituicao INT NOT NULL,
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id),
        FOREIGN KEY (idaluno) REFERENCES alunos(id) ON DELETE CASCADE,
        FOREIGN KEY (idatividades) REFERENCES atividades(id) ON DELETE CASCADE,
        UNIQUE KEY idx_aluno_turno_dia_hora_inst (idaluno, turno, dia_semana, horario, id_instituicao)
      ) ENGINE=InnoDB;
    `;

    const createContatosEmergenciaTable = `
      CREATE TABLE IF NOT EXISTS contatos_emergencia (
        id INT PRIMARY KEY AUTO_INCREMENT,
        id_aluno INT NOT NULL,
        nome VARCHAR(255) NOT NULL,
        telefone VARCHAR(20) NOT NULL,
        parentesco VARCHAR(50) DEFAULT NULL,
        id_instituicao INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_aluno) REFERENCES alunos(id) ON DELETE CASCADE,
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id)
      ) ENGINE=InnoDB;
    `;

    const createDiasSemAulaTable = `
      CREATE TABLE IF NOT EXISTS dias_sem_aula (
        id INT PRIMARY KEY AUTO_INCREMENT,
        data DATE NOT NULL,
        motivo VARCHAR(255) DEFAULT NULL,
        id_instituicao INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by INT,
        UNIQUE KEY idx_data_instituicao (data, id_instituicao),
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id),
        FOREIGN KEY (created_by) REFERENCES usuarios(id)
      ) ENGINE=InnoDB;
    `;

    // 3. Executa as queries em sequência
    await db.query(createInstituicoesTable);
    console.log('Tabela "instituicoes" pronta.');

    await db.query(createUsuariosTable);
    console.log('Tabela "usuarios" pronta.');

    await db.query(createUsuarioInstituicoesTable);
    console.log('Tabela "usuario_instituicoes" pronta.');

    try {
      await db.query("ALTER TABLE usuarios ADD COLUMN perfil VARCHAR(30) NOT NULL DEFAULT 'monitor'");
      console.log('Coluna "perfil" adicionada em usuarios.');
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }

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

    await db.query(createContatosEmergenciaTable);
    console.log('Tabela "contatos_emergencia" pronta.');

    await db.query(createDiasSemAulaTable);
    console.log('Tabela "dias_sem_aula" pronta.');

    // Adiciona colunas novas se ainda não existirem (idempotente)
    const alterColumns = [
      { sql: "ALTER TABLE alunos ADD COLUMN acompanhamento VARCHAR(50) DEFAULT NULL", name: 'acompanhamento' },
      { sql: "ALTER TABLE alunos ADD COLUMN ponto VARCHAR(150) DEFAULT NULL", name: 'ponto' },
    ];
    for (const col of alterColumns) {
      try {
        await db.query(col.sql);
        console.log(`Coluna "${col.name}" adicionada à tabela alunos.`);
      } catch (e) {
        if (e.code === 'ER_DUP_FIELDNAME') {
          console.log(`Coluna "${col.name}" já existe.`);
        } else {
          console.warn(`Aviso ao adicionar coluna "${col.name}":`, e.message);
        }
      }
    }

    // Índices de performance — criados com IF NOT EXISTS via tratamento de erro
    const indexes = [
      // presenca: consultas por data e por instituição são as mais frequentes
      { sql: 'CREATE INDEX idx_presenca_data ON presenca (data)', name: 'idx_presenca_data' },
      { sql: 'CREATE INDEX idx_presenca_inst_data ON presenca (id_instituicao, data)', name: 'idx_presenca_inst_data' },
      { sql: 'CREATE INDEX idx_presenca_aluno_data ON presenca (aluno_id, data)', name: 'idx_presenca_aluno_data' },
      // alunos: filtros por instituição e status
      { sql: 'CREATE INDEX idx_alunos_inst_status ON alunos (id_instituicao, status)', name: 'idx_alunos_inst_status' },
      // matricula: join com alunos e filtro por dia_semana
      { sql: 'CREATE INDEX idx_matricula_dia_inst ON matricula (dia_semana, id_instituicao, status)', name: 'idx_matricula_dia_inst' },
      { sql: 'CREATE INDEX idx_matricula_aluno ON matricula (idaluno)', name: 'idx_matricula_aluno' },
    ];
    for (const idx of indexes) {
      try {
        await db.query(idx.sql);
        console.log(`Índice "${idx.name}" criado.`);
      } catch (e) {
        if (e.code === 'ER_DUP_KEYNAME') {
          console.log(`Índice "${idx.name}" já existe.`);
        } else {
          console.warn(`Aviso ao criar índice "${idx.name}":`, e.message);
        }
      }
    }
    console.log('Índices de performance verificados.');

    // 4. Dados de teste - apenas em desenvolvimento se ENABLE_TEST_DATA=true
    const enableTestData = process.env.ENABLE_TEST_DATA === 'true';
    
    if (enableTestData) {
      console.log('Inserindo dados de teste (ENABLE_TEST_DATA=true)...');
      
      // 4.1 Insere ou recupera uma instituição de teste para evitar duplicatas e erros
      const [instRows] = await db.query('SELECT id FROM instituicoes WHERE nome = ? LIMIT 1', ['Instituição Padrão']);
      let instId;
      if (instRows.length > 0) {
        instId = instRows[0].id;
        console.log('Instituição "Instituição Padrão" já existe. ID:', instId);
      } else {
        const [instResult] = await db.query('INSERT INTO instituicoes (nome) VALUES (?)', ['Instituição Padrão']);
        instId = instResult.insertId;
        console.log('Instituição "Instituição Padrão" criada com sucesso.');
      }

      // 4.2 Insere Professor e Atividade de teste para que a Grade funcione corretamente
      const [profRows] = await db.query('SELECT id FROM professores WHERE nome = ? AND id_instituicao = ?', ['Professor de Teste', instId]);
      let profId;
      if (profRows.length > 0) {
        profId = profRows[0].id;
      } else {
        const [profResult] = await db.query('INSERT INTO professores (nome, id_instituicao) VALUES (?, ?)', ['Professor de Teste', instId]);
        profId = profResult.insertId;
      }

      const [atvRows] = await db.query('SELECT idatividades FROM atividades WHERE nome = ? AND id_instituicao = ?', ['Atividade Padrão', instId]);
      let atvId;
      if (atvRows.length > 0) {
        atvId = atvRows[0].idatividades;
      } else {
        const [atvResult] = await db.query('INSERT INTO atividades (nome, idprofessor, id_instituicao) VALUES (?, ?, ?)', ['Atividade Padrão', profId, instId]);
        atvId = atvResult.insertId;
      }

      // 4.3 Sincronização de alunos de teste: atualiza se já existir (pelo nome + inst), ou cria se for novo.
      const insertAlunosSQL = `
        INSERT INTO alunos (nome, telefone, turno, transporte, id_instituicao) 
        VALUES ? 
        ON DUPLICATE KEY UPDATE 
          telefone = VALUES(telefone), 
          turno = VALUES(turno), 
          transporte = VALUES(transporte)
      `;
      const alunosValues = [
        ['Ana Silva', '123456789', 'Manhã', 'Onibus Branco', instId],
        ['Bruno Costa', '987654321', 'Tarde', 'Onibus Amarelo', instId]
      ];

      await db.query(insertAlunosSQL, [alunosValues]);
      console.log('Dados iniciais de alunos sincronizados.');

      // 4.4 Insere matrículas de teste APENAS para os alunos padrão (para não sujar dados reais)
      const [alunosRows] = await db.query('SELECT id FROM alunos WHERE nome IN (?, ?) AND id_instituicao = ?', ['Ana Silva', 'Bruno Costa', instId]);
      if (alunosRows.length > 0) {
        const matriculasValues = alunosRows.map(aluno => [
          aluno.id, 
          atvId, // Usa o ID da atividade real criada acima
          aluno.id % 2 === 0 ? 'Tarde' : 'Manhã',
          '08:00',
          'Segunda,Terça,Quarta,Quinta,Sexta', 
          instId
        ]);
        await db.query('INSERT IGNORE INTO matricula (idaluno, idatividades, turno, horario, dia_semana, id_instituicao) VALUES ?', [matriculasValues]);
        console.log('Matrículas de teste criadas.');
      }
    } else {
      console.log('Pulando inserção de dados de teste (defina ENABLE_TEST_DATA=true para habilitar).');
    }

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