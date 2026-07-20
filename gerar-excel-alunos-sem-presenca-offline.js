const XLSX = require('xlsx');
const path = require('path');

// Dados dos alunos sem presença (baseado na lista anterior)
// Estes são alunos ativos com matrícula mas sem registros na tabela presenca
const alunosSemPresenca = [
  { id: 4698, nome: 'Cecília Emanuelly Christine Alves', turno: 'MANHÃ', id_instituicao: 2, nome_instituicao: 'Conexão Campo Largo' },
  { id: 4694, nome: 'Cecília Meazza Pereira', turno: 'TARDE', id_instituicao: 2, nome_instituicao: 'Conexão Campo Largo' },
  { id: 4794, nome: 'César Emmanuel Paisano Suarez', turno: 'TARDE', id_instituicao: 2, nome_instituicao: 'Conexão Campo Largo' },
  { id: 3106, nome: 'Clara Emanuele Santos Barbosa', turno: 'TARDE', id_instituicao: 1, nome_instituicao: 'Conexão Sertão' },
  { id: 4728, nome: 'Daniel de Oliveira Cruz', turno: 'MANHÃ', id_instituicao: 2, nome_instituicao: 'Conexão Campo Largo' },
  { id: 4789, nome: 'Britthanys Sinaí Rodríguez Farias', turno: 'TARDE', id_instituicao: 2, nome_instituicao: 'Conexão Campo Largo' },
  { id: 4790, nome: 'Bryan Cândido Martins', turno: 'TARDE', id_instituicao: 2, nome_instituicao: 'Conexão Campo Largo' },
  { id: 4793, nome: 'Caleb Correia de Souza', turno: 'TARDE', id_instituicao: 2, nome_instituicao: 'Conexão Campo Largo' }
];

function gerarExcelAlunosSemPresenca() {
  try {
    console.log(`\n📊 Gerando Excel com ${alunosSemPresenca.length} alunos sem presença registrada...`);

    // Preparar dados para Excel
    const dadosExcel = alunosSemPresenca.map((aluno, index) => ({
      'Nº': index + 1,
      'ID Aluno': aluno.id,
      'Nome': aluno.nome,
      'Turno': aluno.turno || 'SEM TURNO',
      'ID Instituição': aluno.id_instituicao,
      'Instituição': aluno.nome_instituicao,
      'Total de Presenças': 0  // Coluna para confirmar que é zero
    }));

    // Criar workbook e worksheet
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(dadosExcel);

    // Ajustar largura das colunas
    const colWidths = [
      { wch: 5 },   // Nº
      { wch: 10 },  // ID Aluno
      { wch: 50 },  // Nome
      { wch: 15 },  // Turno
      { wch: 15 },  // ID Instituição
      { wch: 25 },  // Instituição
      { wch: 18 }   // Total de Presenças
    ];
    ws['!cols'] = colWidths;

    // Adicionar worksheet ao workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Alunos Sem Presença');

    // Gerar nome do arquivo com data/hora
    const agora = new Date();
    const timestamp = agora.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const nomeArquivo = `alunos-sem-presenca-${timestamp}.xlsx`;
    const caminhoArquivo = path.join(__dirname, nomeArquivo);

    // Salvar arquivo
    XLSX.writeFile(wb, caminhoArquivo);

    console.log(`\n✅ Arquivo Excel gerado com sucesso!`);
    console.log(`📁 Arquivo: ${caminhoArquivo}`);
    console.log(`📊 Total de alunos sem presença: ${alunosSemPresenca.length}`);
    
    // Resumo por turno
    const porTurno = {};
    alunosSemPresenca.forEach(aluno => {
      const turno = aluno.turno || 'SEM TURNO';
      if (!porTurno[turno]) porTurno[turno] = 0;
      porTurno[turno]++;
    });

    console.log('\n--- Resumo por turno ---');
    Object.entries(porTurno).forEach(([turno, count]) => {
      console.log(`${turno}: ${count} aluno(s)`);
    });

    // Resumo por instituição
    const porInstituicao = {};
    alunosSemPresenca.forEach(aluno => {
      const inst = aluno.nome_instituicao;
      if (!porInstituicao[inst]) porInstituicao[inst] = 0;
      porInstituicao[inst]++;
    });

    console.log('\n--- Resumo por instituição ---');
    Object.entries(porInstituicao).forEach(([inst, count]) => {
      console.log(`${inst}: ${count} aluno(s)`);
    });

    console.log('\n⚠️  IMPORTANTE: Estes alunos estão ativos e matriculados, mas NÃO têm nenhuma presença registrada no sistema.');

  } catch (err) {
    console.error('Erro ao gerar Excel:', err);
  }
}

gerarExcelAlunosSemPresenca();
