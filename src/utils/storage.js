// Armazenamento das fotos de aluno — nunca no MySQL. Dois modos:
//
//  - Cloudflare R2 (produção na Vercel, que não tem disco persistente). API
//    compatível com S3 e sem custo de banda de saída, importante porque a foto
//    é baixada toda vez que alguém abre a Chamada. Variáveis:
//      R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME,
//      R2_PUBLIC_URL (domínio público do bucket, sem barra no final)
//
//  - Disco (Docker, ver infra/): grava numa pasta que o nginx publica. Variáveis:
//      FOTOS_DIR (pasta, ex.: /data/fotos) e FOTOS_PUBLIC_URL (ex.: http://localhost:8080/fotos)
//    Tem prioridade sobre o R2 quando FOTOS_DIR está definida.
const fs = require('fs/promises');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const FOTOS_DIR = process.env.FOTOS_DIR ? path.resolve(process.env.FOTOS_DIR) : null;
const emDisco = !!(FOTOS_DIR && process.env.FOTOS_PUBLIC_URL);

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = emDisco ? process.env.FOTOS_PUBLIC_URL : process.env.R2_PUBLIC_URL;

const r2Configurado = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  R2_BUCKET_NAME &&
  PUBLIC_URL
);
const configurado = emDisco || r2Configurado;

const client =
  !emDisco && r2Configurado
    ? new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

// Caminho no disco para a `key`, sem deixar escapar da pasta de fotos.
function caminhoNoDisco(key) {
  const destino = path.resolve(FOTOS_DIR, key);
  if (!destino.startsWith(FOTOS_DIR + path.sep))
    throw new Error(`Caminho de foto inválido: ${key}`);
  return destino;
}

// Grava a foto (já validada e comprimida pelo chamador) e devolve a URL
// pública, que é a salva em alunos.foto_url. A `key` inclui instituição +
// aluno + timestamp ("alunos/3/1234/1700000000.jpg"): nunca colide nem
// sobrescreve uma foto antiga (a antiga é apagada à parte, ver removerFoto).
async function enviarFoto(key, buffer, contentType) {
  if (!configurado) {
    throw new Error(
      'Armazenamento de fotos não configurado (faltam variáveis FOTOS_* ou R2_* no .env).',
    );
  }
  if (emDisco) {
    const destino = caminhoNoDisco(key);
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.writeFile(destino, buffer);
  } else {
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }
  return `${PUBLIC_URL}/${key}`;
}

// Apaga a foto antiga ao trocar, a partir da URL salva no banco. Silencioso em
// erro: uma falha aqui não pode impedir a troca, só deixa um arquivo órfão.
async function removerFoto(url) {
  if (!configurado || !url || !url.startsWith(`${PUBLIC_URL}/`)) return;
  const key = url.slice(PUBLIC_URL.length + 1);
  try {
    if (emDisco) await fs.unlink(caminhoNoDisco(key));
    else await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  } catch (err) {
    console.error('Erro ao remover foto antiga:', err.message);
  }
}

module.exports = { enviarFoto, removerFoto, configurado };
