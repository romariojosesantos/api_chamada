// Migração: impede, no próprio banco, que um aluno tenha mais de uma
// matrícula ATIVA (status='matriculado', data_fim IS NULL) pro mesmo
// dia_semana+horario — o que já causou pelo menos um bug real (ver
// backend/matriculas.js, POST '/': o "achar matrícula existente" usava um
// Map simples que descartava uma duplicata em silêncio, podendo aplicar o
// UPDATE na linha errada e dar a impressão de "salvou mas não mudou nada").
//
// MySQL não tem UNIQUE INDEX condicional (só "WHERE data_fim IS NULL") como
// o Postgres — o jeito equivalente aqui é uma coluna GERADA que só tem valor
// quando a matrícula está ativa (NULL quando encerrada), e colocar o UNIQUE
// nessa coluna: várias linhas com NULL convivem sem problema (matrículas
// encerradas, histórico), mas duas linhas ativas com o mesmo aluno+dia+
// horário+instituição batem de frente e o INSERT/UPDATE falha.
//
// Antes de criar o índice, resolve as duplicatas que já existem hoje (senão
// o CREATE UNIQUE INDEX falharia por dado já duplicado): mantém a matrícula
// mais recente (maior idmatricula) de cada grupo e encerra as outras
// (data_fim = CURDATE()) — mesma regra usada no fix de matriculas.js.
const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306
  });

  try {
    console.log('Conectado ao banco.');

    const [duplicatas] = await db.query(`
      SELECT id_instituicao, idaluno, dia_semana, horario, GROUP_CONCAT(idmatricula ORDER BY idmatricula) AS ids
      FROM matricula
      WHERE status = 'matriculado' AND data_fim IS NULL
      GROUP BY id_instituicao, idaluno, dia_semana, horario
      HAVING COUNT(*) > 1
    `);

    if (duplicatas.length === 0) {
      console.log('Nenhuma duplicata ativa encontrada.');
    } else {
      console.log(`${duplicatas.length} slot(s) com matrícula ativa duplicada — resolvendo (mantendo a mais recente de cada)...`);
      for (const grupo of duplicatas) {
        const ids = grupo.ids.split(',').map(Number);
        const maisRecente = Math.max(...ids);
        const paraEncerrar = ids.filter(id => id !== maisRecente);
        await db.query('UPDATE matricula SET data_fim = CURDATE() WHERE idmatricula IN (?)', [paraEncerrar]);
        console.log(`  aluno ${grupo.idaluno}, ${grupo.dia_semana} ${grupo.horario}: manteve #${maisRecente}, encerrou #${paraEncerrar.join(', #')}`);
      }
    }

    const [colunaExiste] = await db.query("SHOW COLUMNS FROM matricula LIKE 'slot_ativo'");
    if (colunaExiste.length === 0) {
      await db.query(`
        ALTER TABLE matricula ADD COLUMN slot_ativo VARCHAR(100)
          GENERATED ALWAYS AS (
            IF(status = 'matriculado' AND data_fim IS NULL, CONCAT(dia_semana, '|', horario), NULL)
          ) STORED
      `);
      console.log('Coluna gerada matricula.slot_ativo criada.');
    } else {
      console.log('matricula.slot_ativo já existia.');
    }

    const [indiceExiste] = await db.query("SHOW INDEX FROM matricula WHERE Key_name = 'uniq_matricula_slot_ativo'");
    if (indiceExiste.length === 0) {
      await db.query(`
        ALTER TABLE matricula ADD UNIQUE KEY uniq_matricula_slot_ativo (id_instituicao, idaluno, slot_ativo)
      `);
      console.log('Índice uniq_matricula_slot_ativo criado.');
    } else {
      console.log('Índice uniq_matricula_slot_ativo já existia.');
    }

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
