// Migração: adiciona `professores.nome_completo` — nome LEGAL completo do
// educador, usado só em documentos formais (Relatório de Ponto em PDF, ver
// backend/relatorio-ponto-pdf.js). Fica separado do `nome` de sempre de
// propósito: `nome` continua sendo o nome curto/casual usado em todo o resto
// do sistema (dropdown de Pontos, coluna "Educador" em Turmas/Grade, etc.) —
// trocar o `nome` pelo completo vazaria pra essas telas todas. Opcional e
// nulo até o coordenador preencher; quando vazio, o relatório cai de volta
// pro `nome` curto (ver COALESCE em backend/pontos.js).
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
    const [colunas] = await db.query("SHOW COLUMNS FROM professores LIKE 'nome_completo'");
    if (colunas.length > 0) {
      console.log('Migração já aplicada (professores.nome_completo já existe). Nada a fazer.');
      return;
    }

    await db.query('ALTER TABLE professores ADD COLUMN nome_completo VARCHAR(150) NULL AFTER nome');
    console.log('Coluna professores.nome_completo criada.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
