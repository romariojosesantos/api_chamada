const mysql = require('mysql2/promise');
require('dotenv').config();

async function normalizePrimaryKeys() {
  let db;
  try {
    db = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT || 3306
    });
    console.log('Conectado ao banco de dados para normalizar chaves primárias.');

    // Helper para verificar se coluna existe
    const columnExists = async (table, column) => {
      const [cols] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
      );
      return cols.length > 0;
    };

    // Helper para verificar se índice existe
    const indexExists = async (indexName, tableName) => {
      const [indexes] = await db.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [tableName, indexName]);
      return indexes.length > 0;
    };

    // 1. Normalizar tabela atividades: idatividades -> id
    if (await columnExists('atividades', 'idatividades')) {
      console.log('Normalizando PK de atividades (idatividades -> id)...');
      
      // Drop foreign key se existir
      try {
        await db.query('ALTER TABLE matricula DROP FOREIGN KEY matricula_ibfk_3');
        console.log('FK matricula_ibfk_3 removida.');
      } catch (e) {
        if (e.code !== 'ER_CANT_DROP_FIELD_OR_KEY') console.warn('Aviso ao remover FK:', e.message);
      }

      // Renomear coluna
      await db.query('ALTER TABLE atividades CHANGE COLUMN idatividades id INT AUTO_INCREMENT PRIMARY KEY');
      console.log('PK de atividades normalizada para "id".');

      // Recriar FK
      await db.query(`
        ALTER TABLE matricula 
        ADD CONSTRAINT fk_matricula_atividade 
        FOREIGN KEY (idatividades) REFERENCES atividades(id) ON DELETE CASCADE
      `);
      console.log('FK matricula -> atividades recriada.');
    } else {
      console.log('Tabela atividades já tem PK normalizada.');
    }

    // 2. Normalizar tabela matricula: idmatricula -> id
    if (await columnExists('matricula', 'idmatricula')) {
      console.log('Normalizando PK de matricula (idmatricula -> id)...');
      
      // Drop foreign keys se existirem
      const foreignKeys = ['matricula_ibfk_1', 'matricula_ibfk_2', 'matricula_ibfk_3', 'fk_matricula_atividade'];
      for (const fk of foreignKeys) {
        try {
          await db.query(`ALTER TABLE matricula DROP FOREIGN KEY ${fk}`);
          console.log(`FK ${fk} removida.`);
        } catch (e) {
          if (e.code !== 'ER_CANT_DROP_FIELD_OR_KEY') console.warn(`Aviso ao remover FK ${fk}:`, e.message);
        }
      }

      // Renomear coluna
      await db.query('ALTER TABLE matricula CHANGE COLUMN idmatricula id INT AUTO_INCREMENT PRIMARY KEY');
      console.log('PK de matricula normalizada para "id".');

      // Recriar FKs
      await db.query(`
        ALTER TABLE matricula 
        ADD CONSTRAINT fk_matricula_aluno 
        FOREIGN KEY (idaluno) REFERENCES alunos(id) ON DELETE CASCADE
      `);
      console.log('FK matricula -> alunos recriada.');

      await db.query(`
        ALTER TABLE matricula 
        ADD CONSTRAINT fk_matricula_instituicao 
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id)
      `);
      console.log('FK matricula -> instituicoes recriada.');

      await db.query(`
        ALTER TABLE matricula 
        ADD CONSTRAINT fk_matricula_atividade 
        FOREIGN KEY (idatividades) REFERENCES atividades(id) ON DELETE CASCADE
      `);
      console.log('FK matricula -> atividades recriada.');
    } else {
      console.log('Tabela matricula já tem PK normalizada.');
    }

    // 3. Normalizar coluna idatividades em matricula para id_atividade
    if (await columnExists('matricula', 'idatividades')) {
      console.log('Normalizando coluna idatividades em matricula para id_atividade...');
      
      // Drop FK temporariamente
      try {
        await db.query('ALTER TABLE matricula DROP FOREIGN KEY fk_matricula_atividade');
      } catch (e) {
        if (e.code !== 'ER_CANT_DROP_FIELD_OR_KEY') console.warn('Aviso ao remover FK:', e.message);
      }

      await db.query('ALTER TABLE matricula CHANGE COLUMN idatividades id_atividade INT');
      console.log('Coluna idatividades renomeada para id_atividade.');

      // Recriar FK
      await db.query(`
        ALTER TABLE matricula 
        ADD CONSTRAINT fk_matricula_atividade 
        FOREIGN KEY (id_atividade) REFERENCES atividades(id) ON DELETE CASCADE
      `);
      console.log('FK matricula -> atividades recriada com novo nome de coluna.');
    }

    console.log('✅ Normalização de chaves primárias concluída com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao normalizar chaves primárias:', error);
    throw error;
  } finally {
    if (db) {
      await db.end();
      console.log('Conexão com o banco de dados fechada.');
    }
  }
}

normalizePrimaryKeys();
