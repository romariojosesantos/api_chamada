// Armazenamento de arquivos (hoje só foto de aluno) no Cloudflare R2 — nunca
// no MySQL (bloat) nem em disco local (o backend roda como função serverless
// na Vercel, ver vercel.json: sem disco persistente entre execuções). R2 tem
// API compatível com S3 (por isso o SDK da AWS funciona normal), sem cobrar
// banda de saída — importante porque a foto é baixada toda vez que alguém
// abre a tela de Chamada.
//
// Variáveis de ambiente necessárias (ver .env.example):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME,
//   R2_PUBLIC_URL (domínio público do bucket, sem barra no final)
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const configurado = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_URL);

const client = configurado ? new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
}) : null;

// Envia um buffer (já validado/comprimido pelo chamador) pra uma `key` dentro
// do bucket e devolve a URL pública final (a que vai salva em
// alunos.foto_url). `key` inclui o caminho completo, ex.:
// "alunos/3/1234567890.jpg" — instituição + aluno + timestamp, pra nunca
// colidir entre instituições nem sobrescrever sem querer uma foto antiga
// (troca de foto sempre gera uma key nova; a antiga é apagada à parte, ver
// removerFoto).
async function enviarFoto(key, buffer, contentType) {
  if (!configurado) {
    throw new Error('Armazenamento de fotos não configurado (faltam variáveis R2_* no .env).');
  }
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

// Apaga a foto antiga ao trocar — recebe a URL salva no banco e extrai a key
// de volta (tudo depois de R2_PUBLIC_URL/). Silencioso em erro: uma falha aqui
// não pode impedir a troca da foto nova, só deixa um arquivo órfão no bucket.
async function removerFoto(url) {
  if (!configurado || !url || !url.startsWith(R2_PUBLIC_URL)) return;
  const key = url.slice(R2_PUBLIC_URL.length + 1);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  } catch (err) {
    console.error('Erro ao remover foto antiga do R2:', err.message);
  }
}

module.exports = { enviarFoto, removerFoto, configurado };
