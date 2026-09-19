// Migração: coluna `alunos.criado_em` — quando o registro do aluno nasceu de
// verdade no banco (auditoria), diferente de `data_cadastro` (data de
// primeira matrícula na instituição, um dado de negócio que pode inclusive
// ser corrigido manualmente). Dali pra frente, todo INSERT novo em alunos.js
// já grava isso sozinho via agoraBrasil() (ver POST '/' e o upsert em massa).
//
// O problema é o passado: quem já estava cadastrado antes dessa coluna
// existir não tem essa data registrada em lugar nenhum — não dá pra
// "descobrir" a hora exata de criação de um registro que nunca guardou isso.
// Em vez de inventar uma data única pra todo mundo (ex.: a data em que essa
// migração rodou, que mentiria pra qualquer análise futura), backfill em 3
// camadas, da fonte mais confiável pra menos:
//
//   1) `data_cadastro`, onde existir — é um dado de negócio real (varia
//      registro a registro, tem histórico até 2019), não um artefato de
//      migração. Ver alunos.js: fica de fora do ON DUPLICATE KEY UPDATE do
//      reimport de planilha desde sempre, exatamente pra preservar esse
//      valor histórico.
//   2) Pra quem não tem `data_cadastro`: a data da presença mais antiga
//      registrada (`MIN(presenca.data)`) — não é a data de criação de
//      verdade, só uma prova de que o aluno já existia até aquele dia. Serve
//      como um PISO, não uma data exata.
//   3) Quem não tem nem uma coisa nem outra: fica NULL mesmo. É a resposta
//      honesta — não existe nenhum sinal no banco pra esse aluno.
//
// IMPORTANTE: NÃO usar `matricula.data_inicio` como fonte aqui. Essa coluna
// foi adicionada via migrate-add-indexes.js com `DEFAULT (CURDATE())`, então
// pra matrículas que já existiam quando aquela migração rodou, o valor
// gravado é a data DA MIGRAÇÃO, não a data real de início — usar isso pra
// reconstruir `criado_em` importaria uma precisão falsa.
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

    const [colunas] = await db.query("SHOW COLUMNS FROM alunos LIKE 'criado_em'");
    if (colunas.length === 0) {
      // Sem DEFAULT CURRENT_TIMESTAMP de propósito: o backfill abaixo decide o
      // valor de cada linha existente (3 camadas); deixar o MySQL escolher um
      // default automático repetiria o mesmo erro do `matricula.data_inicio`
      // (todo mundo carimbado com "agora"). Novas linhas já vêm com o valor
      // certo porque alunos.js sempre passa agoraBrasil() explicitamente.
      await db.query('ALTER TABLE alunos ADD COLUMN criado_em DATETIME NULL AFTER data_cadastro');
      console.log('Coluna alunos.criado_em criada.');
    } else {
      console.log('Coluna alunos.criado_em já existia.');
    }

    // Camada 1: data_cadastro (fonte mais confiável, dado de negócio real).
    const [camada1] = await db.query(`
      UPDATE alunos
      SET criado_em = data_cadastro
      WHERE criado_em IS NULL AND data_cadastro IS NOT NULL
    `);
    console.log(`Camada 1 (data_cadastro): ${camada1.affectedRows} aluno(s) preenchido(s).`);

    // Camada 2: primeira presença registrada, só pra quem sobrou sem nada na
    // camada 1. É um piso ("existia até aqui"), não a data real de criação.
    const [camada2] = await db.query(`
      UPDATE alunos a
      SET criado_em = (SELECT MIN(p.data) FROM presenca p WHERE p.aluno_id = a.id)
      WHERE a.criado_em IS NULL
        AND EXISTS (SELECT 1 FROM presenca p WHERE p.aluno_id = a.id)
    `);
    console.log(`Camada 2 (1ª presença, piso aproximado): ${camada2.affectedRows} aluno(s) preenchido(s).`);

    const [[{ semSinal }]] = await db.query('SELECT COUNT(*) as semSinal FROM alunos WHERE criado_em IS NULL');
    console.log(`Camada 3 (sem sinal nenhum, ficou NULL): ${semSinal} aluno(s).`);

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
