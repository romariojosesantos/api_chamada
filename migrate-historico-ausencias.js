const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrateHistoricoAusencias() {
  let pool;
  try {
    // Conecta ao banco de dados
    pool = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT || 3306
    });
    console.log('Conectado ao banco de dados.');

    // 1. Buscar todas as instituições
    console.log('\nBuscando instituições...');
    const [instituicoes] = await pool.query(`SELECT id, nome FROM instituicoes`);
    console.log(`Encontradas ${instituicoes.length} instituições.`);

    const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    let totalAusenciasInseridas = 0;

    // 2. Para cada instituição
    for (const inst of instituicoes) {
      const instId = inst.id;
      const instNome = inst.nome;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processando instituição: ${instNome} (ID: ${instId})`);
      console.log('='.repeat(60));

      // 3. Buscar todas as datas únicas com presença para esta instituição
      const [datas] = await pool.query(
        `SELECT DISTINCT DATE(data) as data FROM presenca WHERE id_instituicao = ? ORDER BY data ASC`,
        [instId]
      );
      console.log(`Encontradas ${datas.length} datas com registros para esta instituição.`);

      // 4. Para cada data
      for (let i = 0; i < datas.length; i++) {
        const row = datas[i];
        const data = row.data;
        const diaDaSemana = dias[new Date(`${data}T12:00:00`).getDay()];

        console.log(`\n[${i + 1}/${datas.length}] Processando data: ${data} (${diaDaSemana})`);

        // 5. Buscar alunos esperados na data para esta instituição (matricula ativa)
        const [esperados] = await pool.query(
          `SELECT DISTINCT a.id
           FROM alunos a
           JOIN matricula m ON a.id = m.idaluno
           WHERE TRIM(m.dia_semana) = ?
             AND TRIM(LOWER(m.status)) = 'matriculado'
             AND m.data_fim IS NULL
             AND a.id_instituicao = ?
             AND a.status = 'ativo'`,
          [diaDaSemana, instId]
        );

        if (esperados.length === 0) {
          console.log(`  Nenhum aluno esperado para esta data nesta instituição.`);
          continue;
        }

        console.log(`  ${esperados.length} alunos esperados encontrados.`);

        // 6. Buscar alunos que já têm registro na data para esta instituição
        const [comRegistro] = await pool.query(
          `SELECT DISTINCT aluno_id FROM presenca WHERE data = ? AND id_instituicao = ?`,
          [data, instId]
        );

        const idsComRegistro = new Set(comRegistro.map(r => r.aluno_id));
        const ausentes = esperados
          .filter(e => !idsComRegistro.has(e.id))
          .map(e => [e.id, data, 'ausente', null, instId]);

        if (ausentes.length > 0) {
          await pool.query(
            `INSERT INTO presenca (aluno_id, data, status, observacao, id_instituicao) VALUES ?`,
            [ausentes]
          );
          totalAusenciasInseridas += ausentes.length;
          console.log(`  ${ausentes.length} ausências inseridas.`);
        } else {
          console.log(`  Todos os alunos já têm registro.`);
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`Migração concluída com sucesso!`);
    console.log(`Total de ausências inseridas: ${totalAusenciasInseridas}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Erro durante a migração:', error);
    process.exit(1);
  } finally {
    if (pool) await pool.end();
  }
}

// Executar a migração
migrateHistoricoAusencias();
