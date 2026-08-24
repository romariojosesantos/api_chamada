const mysql = require('mysql2/promise');
require('dotenv').config();

async function addMissingIndexes() {
  let db;
  try {
    db = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT || 3306
    });
    console.log('Conectado ao banco de dados para adicionar índices faltantes.');

    const createIndexIfNotExists = async (indexName, tableName, columns) => {
      const [indexes] = await db.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [tableName, indexName]);
      if (indexes.length === 0) {
        await db.query(`CREATE INDEX ${indexName} ON ?? (${columns})`, [tableName]);
        console.log(`✅ Índice ${indexName} criado em ${tableName}.`);
      } else {
        console.log(`ℹ️  Índice ${indexName} já existe em ${tableName}.`);
      }
    };

    // Índices para otimizar queries comuns
    console.log('\n📊 Adicionando índices de performance...');

    // atividades: filtros por instituição e professor
    await createIndexIfNotExists('idx_atividades_inst', 'atividades', 'id_instituicao');
    await createIndexIfNotExists('idx_atividades_prof', 'atividades', 'idprofessor');

    // professores: filtros por instituição
    await createIndexIfNotExists('idx_professores_inst', 'professores', 'id_instituicao');

    // usuarios: filtros por email e status
    await createIndexIfNotExists('idx_usuarios_email', 'usuarios', 'email');
    await createIndexIfNotExists('idx_usuarios_status', 'usuarios', 'status');

    // usuario_instituicoes: joins frequentes
    await createIndexIfNotExists('idx_usuario_inst_usuario', 'usuario_instituicoes', 'id_usuario');
    await createIndexIfNotExists('idx_usuario_inst_instituicao', 'usuario_instituicoes', 'id_instituicao');

    // contatos_emergencia: filtros por aluno e instituição
    await createIndexIfNotExists('idx_contatos_aluno', 'contatos_emergencia', 'id_aluno');
    await createIndexIfNotExists('idx_contatos_inst', 'contatos_emergencia', 'id_instituicao');

    // dias_sem_aula: filtros por data e instituição
    await createIndexIfNotExists('idx_dias_sem_aula_data', 'dias_sem_aula', 'data');
    await createIndexIfNotExists('idx_dias_sem_aula_inst', 'dias_sem_aula', 'id_instituicao');

    // matricula: filtros por status e turno (além dos já existentes)
    await createIndexIfNotExists('idx_matricula_status', 'matricula', 'status');
    await createIndexIfNotExists('idx_matricula_turno', 'matricula', 'turno');

    // alunos: filtros por turma e transporte
    await createIndexIfNotExists('idx_alunos_turma', 'alunos', 'turma');
    await createIndexIfNotExists('idx_alunos_transporte', 'alunos', 'transporte');

    // chamada_conexao: filtros por evento e timestamp
    await createIndexIfNotExists('idx_chamada_conexao_evento', 'chamada_conexao', 'evento');
    await createIndexIfNotExists('idx_chamada_conexao_timestamp', 'chamada_conexao', 'timestamp');

    console.log('\n✅ Todos os índices faltantes foram verificados/criados com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao criar índices:', error);
    throw error;
  } finally {
    if (db) {
      await db.end();
      console.log('Conexão com o banco de dados fechada.');
    }
  }
}

addMissingIndexes();
