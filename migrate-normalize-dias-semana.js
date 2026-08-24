const mysql = require('mysql2/promise');
require('dotenv').config();

async function normalizeDiasSemana() {
  let db;
  try {
    db = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT || 3306
    });
    console.log('Conectado ao banco de dados para normalizar dias_semana.');

    // 1. Criar tabela auxiliar de dias da semana
    const createDiasSemanaTable = `
      CREATE TABLE IF NOT EXISTS dias_semana (
        id INT PRIMARY KEY AUTO_INCREMENT,
        nome VARCHAR(20) NOT NULL UNIQUE,
        ordem INT NOT NULL
      ) ENGINE=InnoDB;
    `;
    await db.query(createDiasSemanaTable);
    console.log('Tabela dias_semana criada/verificada.');

    // 2. Popular dias da semana se estiver vazia
    const [diasRows] = await db.query('SELECT COUNT(*) as count FROM dias_semana');
    if (diasRows[0].count === 0) {
      const dias = [
        ['Segunda', 1],
        ['Terça', 2],
        ['Quarta', 3],
        ['Quinta', 4],
        ['Sexta', 5],
        ['Sábado', 6],
        ['Domingo', 7]
      ];
      await db.query('INSERT INTO dias_semana (nome, ordem) VALUES ?', [dias]);
      console.log('Dias da semana populados.');
    }

    // 3. Criar tabela de relacionamento matricula_dias
    const createMatriculaDiasTable = `
      CREATE TABLE IF NOT EXISTS matricula_dias (
        id INT PRIMARY KEY AUTO_INCREMENT,
        id_matricula INT NOT NULL,
        id_dia_semana INT NOT NULL,
        FOREIGN KEY (id_matricula) REFERENCES matricula(idmatricula) ON DELETE CASCADE,
        FOREIGN KEY (id_dia_semana) REFERENCES dias_semana(id) ON DELETE CASCADE,
        UNIQUE KEY idx_matricula_dia (id_matricula, id_dia_semana)
      ) ENGINE=InnoDB;
    `;
    await db.query(createMatriculaDiasTable);
    console.log('Tabela matricula_dias criada/verificada.');

    // 4. Migrar dados existentes de matricula.dia_semana para matricula_dias
    const [matriculas] = await db.query(`
      SELECT idmatricula, dia_semana
      FROM matricula
      WHERE dia_semana IS NOT NULL AND dia_semana != ''
    `);

    let migrados = 0;
    for (const matricula of matriculas) {
      // Parse dias separados por vírgula
      const dias = matricula.dia_semana.split(',').map(d => d.trim());

      for (const diaNome of dias) {
        // Buscar ID do dia
        const [diaRows] = await db.query(
          'SELECT id FROM dias_semana WHERE nome = ?',
          [diaNome]
        );

        if (diaRows.length > 0) {
          const diaId = diaRows[0].id;

          // Inserir relacionamento se não existir
          try {
            await db.query(
              'INSERT IGNORE INTO matricula_dias (id_matricula, id_dia_semana) VALUES (?, ?)',
              [matricula.idmatricula, diaId]
            );
            migrados++;
          } catch (e) {
            if (e.code !== 'ER_DUP_ENTRY') {
              console.warn(`Aviso ao migrar dia ${diaNome} para matricula ${matricula.idmatricula}:`, e.message);
            }
          }
        }
      }
    }
    console.log(`✅ ${migrados} relacionamentos de dias migrados.`);

    // 5. Adicionar coluna de controle para saber se a migração foi feita
    try {
      await db.query('ALTER TABLE matricula ADD COLUMN dias_migrados TINYINT(1) DEFAULT 0');
      await db.query('UPDATE matricula SET dias_migrados = 1 WHERE dia_semana IS NOT NULL AND dia_semana != ""');
      console.log('Coluna de controle dias_migrados adicionada.');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') {
        console.warn('Aviso ao adicionar coluna dias_migrados:', e.message);
      }
    }

    console.log('\n✅ Normalização de dias_semana concluída com sucesso!');
    console.log('ℹ️  A tabela matricula_dias agora contém os relacionamentos normalizados.');
    console.log('ℹ️  A coluna dia_semana em matricula pode ser removida após validação.');
  } catch (error) {
    console.error('❌ Erro ao normalizar dias_semana:', error);
    throw error;
  } finally {
    if (db) {
      await db.end();
      console.log('Conexão com o banco de dados fechada.');
    }
  }
}

normalizeDiasSemana();
