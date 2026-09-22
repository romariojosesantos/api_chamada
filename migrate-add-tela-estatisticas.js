// Migração: "/estatisticas-comparativas" vira uma tela configurável na tela
// de Permissões (antes era acesso fixo no código pra master/coordenador — ver
// backend/estatisticas-comparativas.js e frontend/src/App.js/Layout.jsx).
// Telas são allow-list (só quem tem uma linha em permissoes_perfil enxerga),
// então sem isso o coordenador perderia o acesso que já tinha assim que essa
// mudança fosse pro ar — concede o acesso padrão em todas as instituições
// existentes, preservando o comportamento de hoje (master sempre vê tudo,
// não precisa de linha nenhuma).
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

    const [instituicoes] = await db.query('SELECT id FROM instituicoes');
    let inseridos = 0;
    for (const inst of instituicoes) {
      const [result] = await db.query(
        'INSERT IGNORE INTO permissoes_perfil (id_instituicao, perfil, tela) VALUES (?, ?, ?)',
        [inst.id, 'coordenador', '/estatisticas-comparativas']
      );
      inseridos += result.affectedRows;
    }
    console.log(`Acesso padrão à tela /estatisticas-comparativas concedido a coordenador: ${inseridos} linha(s) nova(s) em permissoes_perfil (${instituicoes.length} instituição(ões)).`);

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
