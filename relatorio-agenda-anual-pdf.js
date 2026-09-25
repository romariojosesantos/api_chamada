// Calendário anual em PDF, no estilo dos calendários de parede/mesa de
// escritório: os 12 meses cabem numa ÚNICA página A4 (grade 4x3), com cor
// sólida (não translúcida) por tipo de evento e números em negrito pra
// imprimir nítido mesmo pequeno. Depois vem a legenda, em página(s)
// separadas, agrupada por mês, explicando cada dia marcado.
//
// Mesmo padrão de papel timbrado (logo + fonte Lato com fallback) de
// backend/relatorio-ponto-pdf.js.
//
// Junta duas fontes de dados independentes (ver comentário no topo de
// agenda-eventos.js): `dias_sem_aula` (feriado/recesso, lógica sensível de
// chamada/frequência, só LIDA aqui) e `agenda_eventos` (institucional/área/
// atividade, só informativo). As cores de área abaixo espelham
// frontend/src/utils/areas.js (AREAS) — mantidas em sincronia manualmente,
// já que o backend não compartilha módulo com o frontend.
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, 'assets', 'logo-instituto.png');
const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const F_REGULAR = 'Lato';
const F_BOLD = 'Lato-Bold';
const F_ITALIC = 'Lato-Italic';

const COR_AMBAR = '#C9971C';
const COR_TEXTO = '#1F2937';
const COR_TEXTO_CLARO = '#6B7280';
const COR_BORDA = '#E5DFD3';
const COR_DOMINGO = '#DC2626';
const COR_FIM_DE_SEMANA_BG = '#F3F4F6';
const COR_ZEBRA = '#FAFAF7';

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const DIAS_SEMANA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

// Cor por tipo de marcação — vermelho pra dia sem aula/feriado (mesmo tom do
// calendário da tela, ver DiasSemAula.js), tom escuro neutro pra institucional
// e a paleta de área espelhada de utils/areas.js. Cada tipo tem também uma
// variante CLARA (pra fundo de célula sólido, sem opacidade — ver comentário
// mais abaixo sobre por que abandonamos fillOpacity) e ESCURA (pra pill de
// tipo na legenda).
const CORES = {
  feriado: { solida: '#DC2626', clara: '#FEE2E2', escura: '#991B1B' },
  institucional: { solida: '#334155', clara: '#E2E8F0', escura: '#1E293B' },
  educacional: { solida: '#2563EB', clara: '#DBEAFE', escura: '#1D4ED8' },
  esportivo: { solida: '#16A34A', clara: '#DCFCE7', escura: '#15803D' },
  cultural: { solida: '#9333EA', clara: '#F3E8FF', escura: '#7E22CE' },
  tecnologico: { solida: '#EA580C', clara: '#FFEDD5', escura: '#C2410C' },
  capelania: { solida: '#DB2777', clara: '#FCE7F3', escura: '#BE185D' },
};
const LABEL_AREA = {
  educacional: 'Educação por Princípios',
  esportivo: 'Esporte',
  cultural: 'Arte e Cultura',
  tecnologico: 'Educação Profissional',
  capelania: 'Capelania',
};

// Chave de CORES pro evento — 'feriado'/'institucional' ou o value da área.
function chaveDoEvento(evento) {
  if (evento.origem === 'dia_sem_aula') return 'feriado';
  if (evento.tipo === 'institucional') return 'institucional';
  return evento.area || 'institucional';
}
function corDoEvento(evento) {
  return CORES[chaveDoEvento(evento)] || CORES.institucional;
}

function rotuloTipo(evento) {
  if (evento.origem === 'dia_sem_aula') return 'Dia sem aula';
  if (evento.tipo === 'institucional') return 'Institucional';
  if (evento.tipo === 'atividade') return `Atividade · ${evento.nome_atividade || '—'}`;
  return `Área · ${LABEL_AREA[evento.area] || evento.area}`;
}

function formatarDataBR(dataStr) {
  const [ano, mes, dia] = String(dataStr).split('-');
  return `${dia}/${mes}/${ano}`;
}

// Formato compacto da faixa de datas da legenda — "15 a 17/06/2026" em vez de
// "15/06/2026 a 17/06/2026" repetindo mês/ano. Sem isso, uma faixa de vários
// dias (recesso, torneio) ficava larga demais pra coluna e o PDFKit quebrava
// em 2 linhas, invadindo a linha do evento seguinte (a altura da linha da
// legenda é fixa).
function formatarPeriodo(dataInicio, dataFim) {
  if (dataInicio === dataFim) return formatarDataBR(dataInicio);
  const [ai, mi, di] = dataInicio.split('-');
  const [af, mf, df] = dataFim.split('-');
  if (ai === af && mi === mf) return `${di} a ${df}/${mi}/${ai}`;
  if (ai === af) return `${di}/${mi} a ${df}/${mf}/${ai}`;
  return `${formatarDataBR(dataInicio)} a ${formatarDataBR(dataFim)}`;
}

// Marcação "Fim de semana" (ver POST /marcar-fins-de-semana em
// dias-sem-aula.js) é auto-gerada em massa — ~104 linhas/ano se a instituição
// usar aquele botão. Sábado/domingo já saem sombreados no calendário de
// qualquer jeito (convenção universal de calendário impresso, ver
// ehFimDeSemana), então tratar essas linhas como "evento de verdade" só
// poluiria a grade (com um vermelho ligado o ano inteiro) e inundaria a
// legenda com uma linha por fim de semana. Feriados e recessos de verdade
// (qualquer outro motivo) continuam tratados normalmente.
function ehMarcacaoDeFimDeSemana(motivo) {
  return String(motivo || '').trim().toLowerCase() === 'fim de semana';
}

// Todas as datas "YYYY-MM-DD" entre início e fim (inclusive), em UTC explícito
// — mesma convenção de backend/dias-sem-aula.js, pra nunca deslizar um dia
// dependendo do fuso do processo.
function datasNoIntervalo(dataInicio, dataFim) {
  const [ai, mi, di] = dataInicio.split('-').map(Number);
  const [af, mf, df] = dataFim.split('-').map(Number);
  const atual = new Date(Date.UTC(ai, mi - 1, di));
  const fim = new Date(Date.UTC(af, mf - 1, df));
  const datas = [];
  while (atual <= fim) {
    datas.push(atual.toISOString().split('T')[0]);
    atual.setUTCDate(atual.getUTCDate() + 1);
  }
  return datas;
}

// Dia seguinte a "YYYY-MM-DD", em UTC explícito (mesma convenção do resto do
// arquivo).
function proximoDia(dataStr) {
  const [a, m, d] = dataStr.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().split('T')[0];
}

// Agrupa dias_sem_aula consecutivos com o MESMO motivo numa única faixa (ex.:
// 15 linhas diárias de "Recesso de Julho" viram uma linha "01/07 a 15/07" na
// legenda, em vez de 15 linhas repetidas) — `marcar-periodo` grava uma linha
// por dia, então sem isso a legenda de um recesso de 2 semanas ficaria
// enorme. Espera `rows` já ordenado por data crescente.
function agruparDiasConsecutivos(rows) {
  const grupos = [];
  for (const row of rows) {
    const anterior = grupos[grupos.length - 1];
    if (anterior && anterior.motivo === row.motivo && proximoDia(anterior.data_fim) === row.data) {
      anterior.data_fim = row.data;
    } else {
      grupos.push({ data_inicio: row.data, data_fim: row.data, motivo: row.motivo });
    }
  }
  return grupos;
}

const LARGURA_BARRA = 28.35;
const MARGEM_ESQUERDA = 55;
const MARGEM_DIREITA = 555;
const LARGURA_CONTEUDO = MARGEM_DIREITA - MARGEM_ESQUERDA;

// Monta e envia o PDF direto no `res` (a rota já seta os headers antes de
// chamar isso). `diasSemAula` = linhas de dias_sem_aula (data, motivo);
// `eventos` = linhas de agenda_eventos (tipo, titulo, area, data_inicio,
// data_fim, nome_atividade), ambas já filtradas pro ano pedido.
function gerarRelatorioAgendaAnualPDF({ res, instituicaoNome, ano, diasSemAula, eventos }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 20, left: MARGEM_ESQUERDA, right: 40 } });
  doc.registerFont(F_REGULAR, path.join(FONT_DIR, 'Lato-Regular.ttf'));
  doc.registerFont(F_BOLD, path.join(FONT_DIR, 'Lato-Bold.ttf'));
  doc.registerFont(F_ITALIC, path.join(FONT_DIR, 'Lato-Italic.ttf'));
  try {
    doc.font(F_REGULAR);
  } catch (e) {
    console.error('Fonte Lato indisponível, usando Helvetica como fallback:', e.message);
    doc.registerFont(F_REGULAR, 'Helvetica');
    doc.registerFont(F_BOLD, 'Helvetica-Bold');
    doc.registerFont(F_ITALIC, 'Helvetica-Oblique');
  }
  doc.pipe(res);

  let numeroPagina = 1;

  function desenharCabecalhoRodape() {
    doc.rect(0, 0, LARGURA_BARRA, doc.page.height).fill(COR_AMBAR);
    try {
      doc.image(LOGO_PATH, MARGEM_ESQUERDA, 36, { width: 34, height: 34 });
    } catch (e) {
      // Sem logo não trava o relatório.
    }
    doc.fillColor(COR_TEXTO).font(F_BOLD).fontSize(12).text('Instituto', MARGEM_ESQUERDA + 42, 38);
    doc.fillColor(COR_AMBAR).font(F_ITALIC).fontSize(12).text('novas histórias', MARGEM_ESQUERDA + 42, 53);

    doc.fillColor(COR_TEXTO_CLARO).font(F_REGULAR).fontSize(8)
      .text(`Calendário Anual · ${ano}`, 0, 38, { align: 'right', width: MARGEM_DIREITA });
    doc.text(`Página ${numeroPagina}`, 0, 50, { align: 'right', width: MARGEM_DIREITA });

    const yRodape = 800;
    doc.moveTo(MARGEM_ESQUERDA, yRodape).lineTo(MARGEM_DIREITA, yRodape).strokeColor(COR_AMBAR).lineWidth(1.5).stroke();
    doc.fillColor(COR_TEXTO).font(F_BOLD).fontSize(9)
      .text('institutonovashistorias.com.br', MARGEM_ESQUERDA, yRodape + 8);
    doc.fillColor(COR_AMBAR).font(F_ITALIC).fontSize(9)
      .text('Nós confiamos em Deus', 0, yRodape + 8, { align: 'right', width: MARGEM_DIREITA });
  }

  function novaPagina() {
    doc.addPage();
    numeroPagina += 1;
    desenharCabecalhoRodape();
    doc.y = 90;
  }

  // --- Prepara os dados: tira "fim de semana" do meio (ver comentário da
  // função), monta o mapa dia -> eventos (pra grade) e a legenda agrupada. ---
  const diasSemAulaReais = diasSemAula.filter(d => !ehMarcacaoDeFimDeSemana(d.motivo));

  const eventosPorDia = new Map();
  function registrarDia(dataStr, evento) {
    if (!eventosPorDia.has(dataStr)) eventosPorDia.set(dataStr, []);
    eventosPorDia.get(dataStr).push(evento);
  }
  diasSemAulaReais.forEach(d => registrarDia(d.data, { origem: 'dia_sem_aula', titulo: d.motivo || 'Dia sem aula' }));
  eventos.forEach(e => {
    datasNoIntervalo(e.data_inicio, e.data_fim).forEach(dataStr => {
      registrarDia(dataStr, { origem: 'agenda', tipo: e.tipo, titulo: e.titulo, area: e.area, nome_atividade: e.nome_atividade });
    });
  });

  const ehFimDeSemana = (diaSemana) => diaSemana === 0 || diaSemana === 6;

  // --- Desenha um mês em miniatura dentro de (x, y, largura, altura) ---
  function desenharMes(mes, x, y, largura, altura) {
    const ALTURA_CABECALHO = 15;
    doc.roundedRect(x, y, largura, altura, 3).fillAndStroke('#FFFFFF', COR_BORDA);
    doc.rect(x, y, largura, ALTURA_CABECALHO).fill(COR_AMBAR);
    doc.fillColor('#FFFFFF').font(F_BOLD).fontSize(8.5)
      .text(MESES[mes].toUpperCase(), x, y + 4, { width: largura, align: 'center', characterSpacing: 0.5 });

    const yWeek = y + ALTURA_CABECALHO + 3;
    const larguraCel = largura / 7;
    DIAS_SEMANA.forEach((d, i) => {
      doc.fillColor(i === 0 ? COR_DOMINGO : COR_TEXTO_CLARO).font(F_BOLD).fontSize(6.5)
        .text(d, x + i * larguraCel, yWeek, { width: larguraCel, align: 'center' });
    });

    const primeiroDia = new Date(Date.UTC(ano, mes, 1));
    const diasNoMes = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    const inicioSemana = primeiroDia.getUTCDay();

    const yGrid = yWeek + 10;
    const alturaLinha = (y + altura - 3 - yGrid) / 6;
    for (let dia = 1; dia <= diasNoMes; dia++) {
      const posicao = inicioSemana + dia - 1;
      const linha = Math.floor(posicao / 7);
      const coluna = posicao % 7;
      const cx = x + coluna * larguraCel;
      const cy = yGrid + linha * alturaLinha;
      const diaSemana = (inicioSemana + dia - 1) % 7;
      const dataStr = `${ano}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
      const eventosDoDia = eventosPorDia.get(dataStr) || [];

      // Fundo sólido (nunca translúcido — fillOpacity imprime "lavado" e
      // inconsistente entre visualizadores/impressoras): cinza claro se for
      // só fim de semana comum, ou a cor CLARA do primeiro evento do dia se
      // houver um marcado (feriado/institucional/área tem prioridade visual
      // sobre o cinza de fim de semana).
      if (eventosDoDia.length > 0) {
        const cor = corDoEvento(eventosDoDia[0]);
        doc.roundedRect(cx + 1, cy - 1, larguraCel - 2, alturaLinha - 2, 1.5).fill(cor.clara);
      } else if (ehFimDeSemana(diaSemana)) {
        doc.roundedRect(cx + 1, cy - 1, larguraCel - 2, alturaLinha - 2, 1.5).fill(COR_FIM_DE_SEMANA_BG);
      }

      // Negrito em vez de regular: traço mais grosso imprime muito mais
      // nítido num tamanho pequeno feito esse (a versão anterior usava peso
      // regular a 7pt e ficava fraca/borrada no papel).
      doc.fillColor(diaSemana === 0 ? COR_DOMINGO : COR_TEXTO).font(F_BOLD).fontSize(7)
        .text(String(dia), cx, cy + 2, { width: larguraCel, align: 'center' });

      // Até 3 pontinhos coloridos (um por evento do dia) — sinaliza "tem mais
      // de um tipo aqui" sem virar poluição visual; a legenda traz o detalhe.
      const pontos = eventosDoDia.slice(0, 3);
      if (pontos.length > 0) {
        const larguraPontos = pontos.length * 6;
        const xPontos = cx + (larguraCel - larguraPontos) / 2 + 3;
        pontos.forEach((ev, i) => {
          doc.circle(xPontos + i * 6, cy + alturaLinha - 4, 1.8).fill(corDoEvento(ev).solida);
        });
      }
    }
  }

  // --- Página 1: o ano inteiro numa grade 4 colunas x 3 linhas ---
  desenharCabecalhoRodape();
  doc.y = 90;
  doc.fillColor(COR_TEXTO).font(F_BOLD).fontSize(19)
    .text(`CALENDÁRIO ${ano}`, MARGEM_ESQUERDA, doc.y, { align: 'center', width: LARGURA_CONTEUDO, characterSpacing: 0.5 });
  doc.moveDown(0.15);
  doc.fillColor(COR_TEXTO_CLARO).font(F_ITALIC).fontSize(9.5)
    .text(instituicaoNome, MARGEM_ESQUERDA, doc.y, { align: 'center', width: LARGURA_CONTEUDO });
  doc.moveDown(0.6);

  const COLS = 4, ROWS = 3, GAP_X = 10, GAP_Y = 12;
  const Y_LEGENDA_CORES = 758;
  const yTopoGrade = doc.y + 4;
  const larguraMes = (LARGURA_CONTEUDO - (COLS - 1) * GAP_X) / COLS;
  const alturaMes = (Y_LEGENDA_CORES - 10 - yTopoGrade - (ROWS - 1) * GAP_Y) / ROWS;

  for (let mes = 0; mes < 12; mes++) {
    const col = mes % COLS;
    const lin = Math.floor(mes / COLS);
    const x = MARGEM_ESQUERDA + col * (larguraMes + GAP_X);
    const y = yTopoGrade + lin * (alturaMes + GAP_Y);
    desenharMes(mes, x, y, larguraMes, alturaMes);
  }

  // --- Tira de legenda de cores, no rodapé da própria página do ano ---
  const itensLegendaCores = [
    { label: 'Dia sem aula', cor: CORES.feriado.solida },
    { label: 'Institucional', cor: CORES.institucional.solida },
    ...Object.entries(LABEL_AREA).map(([area, label]) => ({ label, cor: CORES[area].solida })),
  ];
  const larguraItemLegenda = LARGURA_CONTEUDO / itensLegendaCores.length;
  doc.font(F_REGULAR).fontSize(7.5);
  itensLegendaCores.forEach((item, i) => {
    const x = MARGEM_ESQUERDA + i * larguraItemLegenda;
    doc.circle(x + 5, Y_LEGENDA_CORES + 5, 3.5).fill(item.cor);
    doc.fillColor(COR_TEXTO_CLARO).text(item.label, x + 12, Y_LEGENDA_CORES + 1, { width: larguraItemLegenda - 14, ellipsis: true });
  });

  // --- Legenda cronológica (páginas seguintes): explica cada dia marcado,
  // agrupada por mês pra ficar fácil de folhear. ---
  novaPagina();
  doc.fillColor(COR_TEXTO).font(F_BOLD).fontSize(16)
    .text('LEGENDA DOS EVENTOS', MARGEM_ESQUERDA, doc.y, { width: LARGURA_CONTEUDO, characterSpacing: 0.3 });
  doc.fillColor(COR_TEXTO_CLARO).font(F_REGULAR).fontSize(9)
    .text('O que cada dia marcado no calendário representa', MARGEM_ESQUERDA, doc.y + 2, { width: LARGURA_CONTEUDO });
  doc.moveDown(1.4);

  const linhasLegenda = [
    ...agruparDiasConsecutivos(diasSemAulaReais.map(d => ({ data: d.data, motivo: d.motivo || 'Dia sem aula' })))
      .map(g => ({ origem: 'dia_sem_aula', data_inicio: g.data_inicio, data_fim: g.data_fim, titulo: g.motivo })),
    ...eventos.map(e => ({ ...e, origem: 'agenda' })),
  ].sort((a, b) => a.data_inicio.localeCompare(b.data_inicio));

  function garantirEspaco(h) {
    if (doc.y + h > 790) novaPagina();
  }

  if (linhasLegenda.length === 0) {
    doc.fillColor(COR_TEXTO_CLARO).font(F_ITALIC).fontSize(10).text('Nenhum evento cadastrado neste ano.', MARGEM_ESQUERDA, doc.y);
  }

  function desenharCabecalhoMes(mesDoItem) {
    const y = doc.y;
    doc.roundedRect(MARGEM_ESQUERDA, y, LARGURA_CONTEUDO, 18, 3).fill(COR_AMBAR);
    doc.fillColor('#FFFFFF').font(F_BOLD).fontSize(9.5)
      .text(MESES[mesDoItem].toUpperCase(), MARGEM_ESQUERDA + 10, y + 4, { characterSpacing: 0.4 });
    doc.y = y + 24;
  }

  let mesAtualAberto = -1;
  let indiceZebra = 0;
  linhasLegenda.forEach(item => {
    const mesDoItem = Number(item.data_inicio.split('-')[1]) - 1;

    if (mesDoItem !== mesAtualAberto) {
      garantirEspaco(26);
      mesAtualAberto = mesDoItem;
      indiceZebra = 0;
      desenharCabecalhoMes(mesDoItem);
    }

    // Se o grupo do mês atravessa a quebra de página, repete o cabeçalho no
    // topo da página nova — sem isso, uma linha "órfã" (ex.: só "Natal") cai
    // sozinha numa página em branco, sem dizer de qual mês é.
    const paginaAntes = numeroPagina;
    garantirEspaco(22);
    if (numeroPagina !== paginaAntes) {
      indiceZebra = 0;
      desenharCabecalhoMes(mesDoItem);
    }
    const y = doc.y;
    const cor = corDoEvento(item);
    if (indiceZebra % 2 === 1) doc.rect(MARGEM_ESQUERDA, y, LARGURA_CONTEUDO, 20).fill(COR_ZEBRA);
    indiceZebra += 1;

    // Barra de destaque à esquerda na cor do evento — mesma linguagem visual
    // do ponto colorido na grade do ano.
    doc.rect(MARGEM_ESQUERDA, y + 2, 3, 16).fill(cor.solida);

    const periodo = formatarPeriodo(item.data_inicio, item.data_fim);

    doc.fillColor(COR_TEXTO).font(F_BOLD).fontSize(9).text(periodo, MARGEM_ESQUERDA + 12, y + 5, { width: 118, lineBreak: false });
    doc.fillColor(COR_TEXTO).font(F_REGULAR).fontSize(9.5).text(item.titulo, MARGEM_ESQUERDA + 132, y + 5, { width: 210, ellipsis: true });

    const rotulo = rotuloTipo(item);
    // `widthOfString` mede com a fonte/tamanho ATUAIS do doc (não aceita
    // font/size por parâmetro) — por isso o `.font().fontSize()` vem ANTES da
    // medição, não só antes do `.text()`.
    doc.font(F_BOLD).fontSize(7.5);
    const larguraPill = Math.min(155, doc.widthOfString(rotulo) + 16);
    const xPill = MARGEM_DIREITA - larguraPill;
    doc.roundedRect(xPill, y + 3, larguraPill, 14, 7).fill(cor.clara);
    doc.fillColor(cor.escura).text(rotulo, xPill, y + 6.5, { width: larguraPill, align: 'center', ellipsis: true });

    doc.y = y + 20;
  });

  doc.end();
}

module.exports = { gerarRelatorioAgendaAnualPDF };
