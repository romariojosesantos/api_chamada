// Migração: cria `justificativas_falta` — lista de motivos de falta
// (dropdown do botão "Adicionar justificativa" na Chamada, ver
// frontend/src/Components/AttendanceList.jsx), agora editável por
// instituição em vez de um array fixo no código. O texto escolhido é
// copiado como string livre pra `presenca.observacao` (sem FK) — apagar uma
// justificativa daqui não afeta registros de presença já lançados.
//
// Seed: toda instituição recebe as 7 opções que já existiam fixas no código
// (pra não sumir nada do que já estava em uso), MAS a instituição 1 recebe,
// de propósito, só as 4 que o usuário pediu especificamente pra ela agora
// (Saúde, Estudos, Viagem, Não justificadas) — substituindo as antigas.
const mysql = require('mysql2/promise');
require('dotenv').config();

const JUSTIFICATIVAS_PADRAO = [
  'Doente - Passando mal',
  'Estudos - Prova, trabalhos escolares, evento na escola',
  'Viagem - Viagem',
  'Transporte - Sem transporte no município',
  'Consulta médica - Consulta médica',
  'Impontualidade - Acordou atrasado, perdeu o transporte',
  'Sem justificativa - O responsável não retornou na chamada',
];

// Pedido explícito do usuário pra instituição 1: só essas 4, "Não
// justificadas" = tentaram contato com os pais/responsáveis e não teve
// resposta.
const JUSTIFICATIVAS_INSTITUICAO_1 = ['Saúde', 'Estudos', 'Viagem', 'Não justificadas'];

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306
  });

  try {
    console.log('Conectado ao banco. Criando tabela justificativas_falta...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS justificativas_falta (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_instituicao INT NOT NULL,
        texto VARCHAR(150) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_justificativa (id_instituicao, texto)
      )
    `);
    console.log('Tabela justificativas_falta criada (ou já existia).');

    const [instituicoes] = await db.query('SELECT id FROM instituicoes');
    for (const { id } of instituicoes) {
      const textos = id === 1 ? JUSTIFICATIVAS_INSTITUICAO_1 : JUSTIFICATIVAS_PADRAO;
      const values = textos.map(texto => [id, texto]);
      await db.query(
        'INSERT IGNORE INTO justificativas_falta (id_instituicao, texto) VALUES ?',
        [values]
      );
    }
    console.log(`Seed concluído para ${instituicoes.length} instituição(ões).`);

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
