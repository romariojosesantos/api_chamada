// Migração: coluna `presenca.periodo` ('manha'/'tarde'/'noite') — até agora
// a tabela `presenca` guardava só UM registro por aluno+dia (chave única
// aluno_id+id_instituicao+data), sem nenhuma distinção de turno/turma. Isso
// fazia um aluno marcado presente de manhã aparecer automaticamente como
// "presente" também no ensaio da noite (mesmo registro, mesma linha) — não
// tinha como saber se ele realmente foi à noite ou não.
//
// A partir de agora a chave única passa a incluir `periodo`, permitindo até
// 3 registros por aluno no mesmo dia (um por período) — chamadas feitas daqui
// pra frente sempre gravam o período certo (ver backend/presenca.js).
//
// PREENCHIMENTO RETROATIVO (histórico já existente) — 3 grupos, do mais
// seguro pro mais arriscado:
//   1. Aluno cujo `turno` cadastrado é Manhã ou Tarde: marca esse período —
//      sem ambiguidade nenhuma nesse caso.
//   2. Aluno que só TEM matrícula de turno Noite, nunca teve de dia: marca
//      'noite' — também sem ambiguidade (só existe uma coisa que ele podia
//      ter feito).
//   3. Aluno que teve matrícula de turno Noite E de dia (Manhã/Tarde) em
//      algum momento — matrícula dupla de verdade: NÃO preenche. Não tem
//      como saber, olhando pra trás, se aquele "presente" era do turno do
//      dia ou do ensaio da noite — melhor deixar em branco (NULL) do que
//      inventar um valor que pode estar errado.
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

    const [colunas] = await db.query("SHOW COLUMNS FROM presenca LIKE 'periodo'");
    if (colunas.length === 0) {
      await db.query("ALTER TABLE presenca ADD COLUMN periodo ENUM('manha','tarde','noite') NULL AFTER status");
      console.log('Coluna presenca.periodo criada.');
    } else {
      console.log('Coluna presenca.periodo já existia.');
    }

    const [indices] = await db.query("SHOW INDEX FROM presenca WHERE Key_name = 'idx_aluno_inst_data_periodo'");
    if (indices.length === 0) {
      // Cria o índice novo ANTES de apagar o antigo: `idx_aluno_inst_data`
      // sustenta as FKs de aluno_id e id_instituicao (presenca_ibfk_1/2), e o
      // MySQL recusa apagar um índice enquanto for o único suporte de uma FK
      // — como o índice novo começa pelas mesmas colunas, ele assume esse
      // papel assim que existir, liberando o antigo pra ser removido.
      await db.query('ALTER TABLE presenca ADD UNIQUE INDEX idx_aluno_inst_data_periodo (aluno_id, id_instituicao, data, periodo)');
      await db.query('ALTER TABLE presenca DROP INDEX idx_aluno_inst_data');
      console.log('Chave única atualizada pra incluir periodo.');
    } else {
      console.log('Chave única já incluía periodo.');
    }

    // Grupo 1: turno Manhã ou Tarde — sem ambiguidade.
    const [g1] = await db.query(`
      UPDATE presenca p
      JOIN alunos a ON a.id = p.aluno_id
      SET p.periodo = CASE
        WHEN LOWER(a.turno) LIKE '%manh%' THEN 'manha'
        WHEN LOWER(a.turno) LIKE '%tard%' THEN 'tarde'
        ELSE NULL
      END
      WHERE p.periodo IS NULL
        AND (LOWER(a.turno) LIKE '%manh%' OR LOWER(a.turno) LIKE '%tard%')
        AND p.aluno_id NOT IN (
          SELECT DISTINCT idaluno FROM matricula WHERE turno = 'Noite'
        )
    `);
    console.log(`Grupo 1 (turno de dia, sem ambiguidade): ${g1.affectedRows} registro(s) preenchido(s).`);

    // Grupo 2: só teve matrícula de turno Noite, nunca de dia — sem ambiguidade.
    const [g2] = await db.query(`
      UPDATE presenca p
      SET p.periodo = 'noite'
      WHERE p.periodo IS NULL
        AND p.aluno_id IN (SELECT DISTINCT idaluno FROM matricula WHERE turno = 'Noite')
        AND p.aluno_id NOT IN (SELECT DISTINCT idaluno FROM matricula WHERE turno IN ('Manhã', 'Tarde'))
    `);
    console.log(`Grupo 2 (só noite, sem ambiguidade): ${g2.affectedRows} registro(s) preenchido(s).`);

    const [restantes] = await db.query('SELECT COUNT(*) as qtd FROM presenca WHERE periodo IS NULL');
    console.log(`Restam ${restantes[0].qtd} registro(s) sem período (matrícula dupla dia+noite — ambíguo, deixado em branco de propósito).`);

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
