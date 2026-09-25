// Relatório de Ponto em PDF, no papel timbrado do Instituto Novas Histórias —
// usado pela visão agregada de Pontos (coordenador/master), sempre pra UM
// educador por vez (ver SecaoGestor em frontend/src/Pontos.js: o botão só
// libera com um educador específico selecionado no filtro, igual ao modelo
// de folha de ponto tradicional — "um relatório = um prestador").
//
// Gerado com PDFKit (desenho manual, sem depender de Chromium/headless) —
// cada página é montada "na mão": barra lateral + cabeçalho com logo, caixa
// de identificação, caixa de KPIs, tabela agrupada por dia (com subtotal) e
// rodapé com o site do Instituto. Isso é só um controle interno complementar
// (mesma ressalva de backend/pontos.js) — não é o ponto oficial de CLT.
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, 'assets', 'logo-instituto.png');

// Fonte própria (Lato, licença OFL — livre pra embutir) em vez das 14 fontes
// padrão do PDFKit: Helvetica no PDF cai pra uma fonte genérica do leitor,
// sem hinting bom em telas — a Lato vem embutida no arquivo, sempre nítida e
// com o mesmo desenho em qualquer visualizador.
const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const F_REGULAR = 'Lato';
const F_BOLD = 'Lato-Bold';
const F_ITALIC = 'Lato-Italic';

const COR_AMBAR = '#C9971C';
const COR_TEXTO = '#1F2937';
const COR_TEXTO_CLARO = '#6B7280';
const COR_FUNDO_CLARO = '#F5EEE1';
const COR_FUNDO_ALT = '#FAFAFA';
const COR_BARRA_TOTAL = '#33302B';
const COR_BORDA = '#E5DFD3';

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function formatarDataBR(dataStr) {
  const [ano, mes, dia] = String(dataStr).split('-');
  return `${dia}/${mes}/${ano}`;
}

function rotuloPeriodo(dataInicio, dataFim) {
  const [anoI, mesI] = dataInicio.split('-');
  const [anoF, mesF] = dataFim.split('-');
  if (anoI === anoF && mesI === mesF) {
    return `${MESES[Number(mesI) - 1]}/${anoI}`;
  }
  return `${formatarDataBR(dataInicio)} a ${formatarDataBR(dataFim)}`;
}

// Duração em segundos entre duas colunas "YYYY-MM-DDTHH:MM:SS" já em horário
// de Brasília (mesmo formato usado em toda a tela de Pontos) — 0 se a saída
// ainda não foi registrada.
function duracaoSegundos(entrada, saida) {
  if (!entrada || !saida) return 0;
  const seg = (Date.parse(saida) - Date.parse(entrada)) / 1000;
  return seg > 0 ? Math.round(seg) : 0;
}

function formatarDuracao(totalSegundos) {
  const h = Math.floor(totalSegundos / 3600);
  const m = Math.floor((totalSegundos % 3600) / 60);
  const s = Math.floor(totalSegundos % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatarHora(iso) {
  return iso ? iso.slice(11, 19) : '—';
}

// 1cm exatos (72pt/polegada ÷ 2.54) — a barra lateral pedida pro papel
// timbrado, na cor da logo.
const LARGURA_BARRA = 28.35;
// Conteúdo começa depois da barra + um respiro — nunca cola nela.
const MARGEM_ESQUERDA = 55;
const MARGEM_DIREITA = 555; // borda direita do conteúdo (A4 = 595.28pt de largura)

const COLS = {
  data: { x: MARGEM_ESQUERDA, w: 65 },
  atividade: { x: MARGEM_ESQUERDA + 65, w: 230 },
  entrada: { x: 350, w: 60 },
  saida: { x: 410, w: 60 },
  horas: { x: 470, w: 85 },
};
const LARGURA_TABELA = COLS.horas.x + COLS.horas.w - COLS.data.x;

// Monta e envia o PDF direto no `res` (a rota já seta os headers de
// content-type/disposition antes de chamar isso). `rows` no mesmo formato
// devolvido por GET /api/pontos (um professor só, já filtrado pela rota).
function gerarRelatorioPontoPDF({ res, instituicaoNome, professorNome, professorEmail, dataInicio, dataFim, rows }) {
  // Margem inferior menor que a superior/laterais de propósito: o rodapé
  // (linha do site, y=808) fica LOGO abaixo do limite padrão de 40pt — sem
  // isso, o próprio PDFKit acha que o texto do rodapé não coube na página e
  // insere uma página em branco sozinho antes de continuar (paginação
  // automática dele, disparada em QUALQUER `.text()`, mesmo com y explícito).
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 20, left: MARGEM_ESQUERDA, right: 40 } });
  doc.registerFont(F_REGULAR, path.join(FONT_DIR, 'Lato-Regular.ttf'));
  doc.registerFont(F_BOLD, path.join(FONT_DIR, 'Lato-Bold.ttf'));
  doc.registerFont(F_ITALIC, path.join(FONT_DIR, 'Lato-Italic.ttf'));
  doc.pipe(res);

  const rotuloTopo = `Relatório de Ponto · ${rotuloPeriodo(dataInicio, dataFim)}`;
  let numeroPagina = 1;

  function desenharCabecalhoRodape() {
    // Barra vertical de 1cm à esquerda, na cor da logo — repetida em toda
    // página (papel timbrado de verdade, não só na primeira folha).
    doc.rect(0, 0, LARGURA_BARRA, doc.page.height).fill(COR_AMBAR);

    // Cabeçalho: logo + nome do Instituto à esquerda, "Relatório de Ponto ·
    // mês/ano" + número da página à direita.
    try {
      doc.image(LOGO_PATH, MARGEM_ESQUERDA, 36, { width: 34, height: 34 });
    } catch (e) {
      // Sem a imagem (ex.: ambiente sem o arquivo) não trava o relatório —
      // só sai sem a logo.
    }
    doc.fillColor(COR_TEXTO).font(F_BOLD).fontSize(12).text('Instituto', MARGEM_ESQUERDA + 42, 38);
    doc.fillColor(COR_AMBAR).font(F_ITALIC).fontSize(12).text('novas histórias', MARGEM_ESQUERDA + 42, 53);

    doc.fillColor(COR_TEXTO_CLARO).font(F_REGULAR).fontSize(8)
      .text(rotuloTopo, 0, 38, { align: 'right', width: MARGEM_DIREITA });
    doc.text(`Página ${numeroPagina}`, 0, 50, { align: 'right', width: MARGEM_DIREITA });

    // Rodapé: site à esquerda, assinatura de marca à direita — mesma linha
    // em todas as páginas (papel timbrado).
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
    // Página nova só acontece no meio da tabela (título/info/KPIs já ficaram
    // pra trás) — sempre repete o cabeçalho das colunas antes de continuar.
    desenharCabecalhoTabela();
  }

  // Garante espaço pro que vem a seguir (altura `h`) antes do rodapé (~795pt)
  // — se não couber, pula de página já desenhando cabeçalho/rodapé de novo.
  function garantirEspaco(h) {
    if (doc.y + h > 790) novaPagina();
  }

  desenharCabecalhoRodape();
  doc.y = 90;

  // --- Título + subtítulo ---
  doc.fillColor(COR_TEXTO).font(F_BOLD).fontSize(21)
    .text('RELATÓRIO DE PONTO', MARGEM_ESQUERDA, doc.y, { align: 'center', width: LARGURA_TABELA, characterSpacing: 0.4 });
  doc.moveDown(0.2);
  doc.fillColor(COR_TEXTO_CLARO).font(F_REGULAR).fontSize(10)
    .text(`${instituicaoNome} · Período de ${formatarDataBR(dataInicio)} a ${formatarDataBR(dataFim)}`, MARGEM_ESQUERDA, doc.y, { align: 'center', width: LARGURA_TABELA });
  doc.moveDown(1);

  // --- Caixa PRESTADOR / E-MAIL / PROJETO ---
  const yInfo = doc.y;
  const alturaInfo = 46;
  doc.roundedRect(MARGEM_ESQUERDA, yInfo, LARGURA_TABELA, alturaInfo, 6).fillAndStroke('#FFFFFF', COR_BORDA);
  const colsInfo = [
    { label: 'PRESTADOR', valor: professorNome, x: MARGEM_ESQUERDA + 14, w: 220 },
    { label: 'E-MAIL', valor: professorEmail || '—', x: MARGEM_ESQUERDA + 250, w: 155 },
    { label: 'PROJETO', valor: instituicaoNome, x: MARGEM_ESQUERDA + 415, w: 85 },
  ];
  colsInfo.forEach(c => {
    doc.fillColor(COR_TEXTO_CLARO).font(F_BOLD).fontSize(7).text(c.label, c.x, yInfo + 10, { width: c.w, characterSpacing: 0.3 });
    doc.fillColor(COR_TEXTO).font(F_REGULAR).fontSize(10).text(c.valor, c.x, yInfo + 22, { width: c.w, ellipsis: true });
  });
  doc.y = yInfo + alturaInfo + 14;

  // --- KPIs (calculados aqui, direto dos registros do período) ---
  const totalSegundos = rows.reduce((soma, r) => soma + duracaoSegundos(r.hora_entrada, r.hora_saida), 0);
  const diasTrabalhados = new Set(rows.map(r => r.data)).size;
  const registros = rows.length;
  const mediaSegundosPorDia = diasTrabalhados > 0 ? Math.round(totalSegundos / diasTrabalhados) : 0;

  const yKpi = doc.y;
  const alturaKpi = 50;
  doc.roundedRect(MARGEM_ESQUERDA, yKpi, LARGURA_TABELA, alturaKpi, 6).fillAndStroke('#FFFFFF', COR_BORDA);
  const larguraKpi = LARGURA_TABELA / 4;
  const kpis = [
    { label: 'TOTAL DE HORAS', valor: formatarDuracao(totalSegundos) },
    { label: 'DIAS TRABALHADOS', valor: String(diasTrabalhados) },
    { label: 'REGISTROS', valor: String(registros) },
    { label: 'MÉDIA POR DIA', valor: formatarDuracao(mediaSegundosPorDia) },
  ];
  kpis.forEach((k, i) => {
    const x = MARGEM_ESQUERDA + i * larguraKpi;
    if (i > 0) doc.moveTo(x, yKpi + 8).lineTo(x, yKpi + alturaKpi - 8).strokeColor(COR_BORDA).lineWidth(1).stroke();
    doc.fillColor(COR_TEXTO_CLARO).font(F_BOLD).fontSize(7).text(k.label, x, yKpi + 12, { width: larguraKpi, align: 'center', characterSpacing: 0.3 });
    doc.fillColor(COR_AMBAR).font(F_BOLD).fontSize(16).text(k.valor, x, yKpi + 24, { width: larguraKpi, align: 'center' });
  });
  doc.y = yKpi + alturaKpi + 16;

  // --- Cabeçalho da tabela (repetido no topo de cada página com linhas) ---
  function desenharCabecalhoTabela() {
    const y = doc.y;
    doc.rect(COLS.data.x, y, LARGURA_TABELA, 20).fill(COR_FUNDO_CLARO);
    doc.fillColor(COR_TEXTO_CLARO).font(F_BOLD).fontSize(8);
    doc.text('Data', COLS.data.x + 8, y + 6);
    doc.text('Turma / Atividade', COLS.atividade.x + 4, y + 6);
    doc.text('Entrada', COLS.entrada.x, y + 6, { width: COLS.entrada.w, align: 'center' });
    doc.text('Saída', COLS.saida.x, y + 6, { width: COLS.saida.w, align: 'center' });
    doc.text('Horas', COLS.horas.x, y + 6, { width: COLS.horas.w - 8, align: 'right' });
    doc.y = y + 20;
  }
  desenharCabecalhoTabela();

  // --- Linhas, agrupadas por dia (mesma ordem cronológica de uma folha de
  // ponto: mais antigo primeiro) ---
  const porDia = new Map();
  rows.forEach(r => {
    if (!porDia.has(r.data)) porDia.set(r.data, []);
    porDia.get(r.data).push(r);
  });
  const dias = [...porDia.keys()].sort();

  dias.forEach((data, indiceDia) => {
    const linhasDoDia = porDia.get(data);
    const corFundoGrupo = indiceDia % 2 === 0 ? '#FFFFFF' : COR_FUNDO_ALT;

    linhasDoDia.forEach((r, indiceLinha) => {
      garantirEspaco(18);
      const y = doc.y;
      doc.rect(COLS.data.x, y, LARGURA_TABELA, 18).fill(corFundoGrupo);

      if (indiceLinha === 0) {
        doc.fillColor(COR_TEXTO).font(F_BOLD).fontSize(8).text(formatarDataBR(data), COLS.data.x + 8, y + 4);
      }
      doc.fillColor(COR_TEXTO).font(F_REGULAR).fontSize(8);
      doc.text(r.nome_turma || '—', COLS.atividade.x + 4, y + 4, { width: COLS.atividade.w - 8, ellipsis: true });
      doc.text(formatarHora(r.hora_entrada), COLS.entrada.x, y + 4, { width: COLS.entrada.w, align: 'center' });
      doc.text(formatarHora(r.hora_saida), COLS.saida.x, y + 4, { width: COLS.saida.w, align: 'center' });
      doc.text(formatarDuracao(duracaoSegundos(r.hora_entrada, r.hora_saida)), COLS.horas.x, y + 4, { width: COLS.horas.w - 8, align: 'right' });
      doc.y = y + 18;
    });

    // Subtotal do dia
    garantirEspaco(20);
    const ySub = doc.y;
    const subtotalSegundos = linhasDoDia.reduce((s, r) => s + duracaoSegundos(r.hora_entrada, r.hora_saida), 0);
    doc.rect(COLS.data.x, ySub, LARGURA_TABELA, 20).fill(COR_FUNDO_CLARO);
    doc.fillColor(COR_TEXTO_CLARO).font(F_ITALIC).fontSize(8)
      .text('Subtotal do dia', COLS.data.x, ySub + 6, { width: COLS.saida.x + COLS.saida.w - COLS.data.x, align: 'right' });
    doc.fillColor(COR_TEXTO).font(F_BOLD).fontSize(8)
      .text(formatarDuracao(subtotalSegundos), COLS.horas.x, ySub + 6, { width: COLS.horas.w - 8, align: 'right' });
    doc.y = ySub + 20;
  });

  // --- Barra final: TOTAL DO PERÍODO ---
  garantirEspaco(24);
  const yTotal = doc.y;
  doc.rect(COLS.data.x, yTotal, LARGURA_TABELA, 24).fill(COR_BARRA_TOTAL);
  doc.fillColor('#FFFFFF').font(F_BOLD).fontSize(9)
    .text('TOTAL DO PERÍODO', COLS.data.x + 10, yTotal + 7, { characterSpacing: 0.3 });
  doc.text(formatarDuracao(totalSegundos), COLS.horas.x, yTotal + 7, { width: COLS.horas.w - 10, align: 'right' });
  doc.y = yTotal + 24;

  // --- Assinatura do prestador ---
  garantirEspaco(70);
  const yAssinatura = doc.y + 40;
  const xLinha = MARGEM_ESQUERDA + (LARGURA_TABELA - 220) / 2;
  doc.moveTo(xLinha, yAssinatura).lineTo(xLinha + 220, yAssinatura).strokeColor(COR_TEXTO_CLARO).lineWidth(1).stroke();
  doc.fillColor(COR_TEXTO).font(F_REGULAR).fontSize(9)
    .text(professorNome, xLinha, yAssinatura + 6, { width: 220, align: 'center' });
  doc.fillColor(COR_TEXTO_CLARO).font(F_REGULAR).fontSize(8)
    .text('Prestador', xLinha, yAssinatura + 18, { width: 220, align: 'center' });

  doc.end();
}

module.exports = { gerarRelatorioPontoPDF };
