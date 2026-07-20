const mysql = require('mysql2/promise');

const dbConfig = {
  host: '31.97.83.209',
  port: 3306,
  user: 'romario_novo',
  password: 'RomarioSantos2025',
  database: 'chamada_conexao',
  timezone: 'America/Sao_Paulo'
};

async function diagnosticarPresencas() {
  let pool;
  try {
    pool = mysql.createPool(dbConfig);

    const data = '2026-07-17';
    const instituicaoId = 1; // Conexão Sertão (ajuste se necessário)
    const dias = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const diaDaSemana = dias[new Date(`${data}T12:00:00`).getDay()];

    console.log(`Diagnóstico para ${data} (${diaDaSemana}) - Instituição ${instituicaoId}`);
    console.log('=' .repeat(80));

    // 1. Total de presenças na tabela para esse dia
    const [totalPresencas] = await pool.query(
      `SELECT status, COUNT(*) as total
       FROM presenca
       WHERE id_instituicao = ? AND DATE(data) = ?
       GROUP BY status`,
      [instituicaoId, data]
    );
    console.log('\n1. Total de registros na tabela presenca:');
    console.table(totalPresencas);

    // 2. Presenças que o relatório conta (com matricula ativa no dia)
    const [contadas] = await pool.query(
      `SELECT COUNT(DISTINCT a.id) as total
       FROM alunos a
       JOIN matricula m ON a.id = m.idaluno 
         AND TRIM(m.dia_semana) = ? 
         AND m.status = 'matriculado'
         AND m.data_fim IS NULL
       LEFT JOIN presenca p ON a.id = p.aluno_id 
         AND DATE(p.data) = ? 
         AND p.id_instituicao = a.id_instituicao
       WHERE a.id_instituicao = ? 
         AND a.status = 'ativo'
         AND p.status = 'presente'`,
      [diaDaSemana, data, instituicaoId]
    );
    console.log('\n2. Presenças que o relatório conta (status=presente + matrícula ativa no dia):');
    console.log(contadas[0].total);

    // 3. Presenças NÃO contadas e motivo
    const [naoContadas] = await pool.query(
      `SELECT p.id, p.aluno_id, a.nome, a.status as status_aluno, a.turno, p.status, p.observacao,
              m.idmatricula, m.dia_semana, m.status as status_matricula, m.data_fim,
              CASE 
                WHEN a.status != 'ativo' THEN 'Aluno inativo'
                WHEN m.idmatricula IS NULL THEN 'Sem matrícula'
                WHEN m.status != 'matriculado' THEN CONCAT('Matrícula ', m.status)
                WHEN m.data_fim IS NOT NULL THEN 'Matrícula encerrada (data_fim preenchida)'
                WHEN TRIM(m.dia_semana) != ? THEN CONCAT('Matrícula é no dia ', m.dia_semana, ', não ', ?)
                WHEN p.status != 'presente' THEN CONCAT('Status da presença: ', p.status)
                ELSE 'Contada'
              END as motivo
       FROM presenca p
       JOIN alunos a ON p.aluno_id = a.id
       LEFT JOIN matricula m ON a.id = m.idaluno 
         AND (TRIM(m.dia_semana) = ? OR m.idmatricula IS NOT NULL)
       WHERE p.id_instituicao = ? 
         AND DATE(p.data) = ?
         AND p.status = 'presente'`,
      [diaDaSemana, diaDaSemana, diaDaSemana, instituicaoId, data]
    );
    console.log('\n3. Presenças de status=presente que o relatório NÃO conta:');
    const naoContadasFiltradas = naoContadas.filter(r => r.motivo !== 'Contada');
    console.log(`Total não contadas: ${naoContadasFiltradas.length}`);
    if (naoContadasFiltradas.length > 0) {
      console.table(naoContadasFiltradas);
    }

    // 4. Resumo por motivo
    const porMotivo = {};
    naoContadasFiltradas.forEach(r => {
      porMotivo[r.motivo] = (porMotivo[r.motivo] || 0) + 1;
    });
    console.log('\n4. Resumo por motivo:');
    console.table(porMotivo);

  } catch (err) {
    console.error('Erro no diagnóstico:', err);
  } finally {
    if (pool) await pool.end();
  }
}

diagnosticarPresencas();
