FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./

# No deps today, but keep it future-proof.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]

