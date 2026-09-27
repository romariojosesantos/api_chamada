// E-mails do login (via Resend). Sem RESEND_API_KEY, só avisa no log.
const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const REMETENTE = process.env.RESEND_FROM_EMAIL || 'Atos On <onboarding@resend.dev>';
const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === 'production'
    ? 'https://controle-de-presenca-ten.vercel.app'
    : 'http://localhost:3000');

const configurado = () => resend !== null;

// O link abre uma tela de confirmação no front (não aprova com um GET): leitores
// de e-mail que pré-carregam links não podem aprovar ninguém sozinhos.
async function avisarNovoCadastro(destinatarios, { nome, email, perfil }, tokenAprovacao) {
  const link = `${FRONTEND_URL}/aprovar-cadastro/${tokenAprovacao}`;
  await resend.emails.send({
    from: REMETENTE,
    to: destinatarios,
    subject: 'Novo cadastro aguardando aprovação — Atos On',
    html: `<p>Um novo cadastro está aguardando sua aprovação:</p>
      <p><b>Nome:</b> ${nome}<br><b>E-mail:</b> ${email}<br><b>Perfil:</b> ${perfil}</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;">Ver e aprovar cadastro</a></p>
      <p>Ou copie e cole este link no navegador: ${link}</p>`,
  });
}

async function enviarCodigoRedefinicao(email, nome, codigo) {
  await resend.emails.send({
    from: REMETENTE,
    to: email,
    subject: 'Código para redefinir sua senha — Atos On',
    html: `<p>Olá, ${nome}.</p><p>Seu código de verificação é:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px;">${codigo}</p><p>Ele expira em 15 minutos. Se você não pediu essa redefinição, ignore este e-mail.</p>`,
  });
}

module.exports = { configurado, avisarNovoCadastro, enviarCodigoRedefinicao };
