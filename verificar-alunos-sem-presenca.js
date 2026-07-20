const pool = require('./db');

async function verificarAlunosSemPresenca() {
  try {
    console.log('Buscando alunos ativos que NÃO têm nenhuma presença registrada...');
    
    // Query para encontrar alunos ativos com matrícula que não têm registros na tabela presenca
    const [rows] = await pool.query(`
      SELECT DISTINCT 
        a.id, 
        a.nome, 
        a.turno, 
        a.id_instituicao, 
        i.nome AS nome_instituicao,
        COUNT(p.id) AS total_presencas
      FROM alunos a
      JOIN instituicoes i ON a.id_instituicao = i.id
      LEFT JOIN matricula m ON a.id = m.idaluno AND m.status = 'matriculado'
      LEFT JOIN presenca p ON a.id = p.aluno_id
      WHERE a.status = 'ativo'
        AND m.idaluno IS NOT NULL  -- Tem matrícula ativa
      GROUP BY a.id, a.nome, a.turno, a.id_instituicao, i.nome
      HAVING total_presencas = 0  -- NÃO TEM NENHUMA PRESENÇA
      ORDER BY a.nome ASC
    `);

    if (rows.length === 0) {
      console.log('Todos os alunos ativos com matrícula possuem pelo menos uma presença registrada.');
    } else {
      console.log(`\n${rows.length} aluno(s) ativo(s) com matrícula mas SEM NENHUMA presença registrada:\n`);
      console.table(rows);
      
      // Agrupar por turno
      const porTurno = {};
      rows.forEach(aluno => {
        const turno = aluno.turno || 'SEM TURNO';
        if (!porTurno[turno]) porTurno[turno] = [];
        porTurno[turno].push(aluno.nome);
      });

      console.log('\n--- Resumo por turno ---');
      Object.entries(porTurno).forEach(([turno, nomes]) => {
        console.log(`\n${turno} (${nomes.length}):`);
        nomes.forEach(nome => console.log(`  - ${nome}`));
      });

      // Agrupar por instituição
      const porInstituicao = {};
      rows.forEach(aluno => {
        const inst = aluno.nome_instituicao;
        if (!porInstituicao[inst]) porInstituicao[inst] = 0;
        porInstituicao[inst]++;
      });

      console.log('\n--- Resumo por instituição ---');
      Object.entries(porInstituicao).forEach(([inst, count]) => {
        console.log(`${inst}: ${count} aluno(s)`);
      });
    }
  } catch (err) {
    console.error('Erro ao verificar alunos sem presença:', err);
  } finally {
    await pool.end();
  }
}

verificarAlunosSemPresenca();
