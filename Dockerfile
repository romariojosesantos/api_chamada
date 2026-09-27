# API em container (ver o repositório infra/ para subir junto com banco,
# fotos e frontend). A configuração vem das variáveis de ambiente, não de .env.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependências primeiro: a camada fica em cache enquanto o package.json não mudar.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Pasta das fotos (volume): criada aqui para já nascer com dono "node".
RUN mkdir -p /data/fotos && chown node:node /data/fotos

USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/api/auth/has-master > /dev/null || exit 1

CMD ["node", "server.js"]
