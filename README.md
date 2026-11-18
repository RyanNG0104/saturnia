# SaturnIA

Um chat de IA com um olho feito de partículas: a pupila acompanha o seu cursor, ele pisca, fica inquieto enquanto pensa e pulsa enquanto responde. Em volta, um anel como o de Saturno.

🔗 **Acesse:** https://ryanng0104.github.io/saturnia/

**100% gratuita:** roda no plano grátis do GitHub Pages e da Cloudflare, sem cartão e sem chave de API.

## Como funciona

```
Navegador (GitHub Pages)  ──POST /chat──▶  Cloudflare Worker  ──▶  Workers AI (Llama 3.3 70B)
        ◀──── resposta em tempo real (Server-Sent Events) ────
```

- **Site** (`index.html`, `css/`, `js/`): HTML, CSS e JavaScript puros, sem build. O olho é desenhado num `<canvas>` (`js/eye.js`).
- **Servidor** (`worker/`): um Cloudflare Worker que roda o modelo Llama 3.3 70B no **Workers AI**, a IA da própria Cloudflare, dentro da cota diária gratuita.

### Proteções do servidor

- Só aceita pedidos vindos dos endereços em `ALLOWED_ORIGINS` (`worker/wrangler.toml`)
- Limite de 15 mensagens por minuto por IP
- Limite de tamanho das mensagens e do histórico
- Quando a cota gratuita do dia acaba, o chat avisa e volta a funcionar no dia seguinte, sem cobrança

## Ligando a IA (uma vez só)

Você só precisa de uma **conta grátis na Cloudflare**: https://dash.cloudflare.com/sign-up (confirme o e-mail).

Depois, no terminal:

```bash
cd worker
npm install
npx wrangler login      # abre o navegador para entrar na Cloudflare
npx wrangler deploy     # publica e mostra o endereço do servidor
```

O `deploy` mostra um endereço como `https://saturnia.SEU-SUBDOMINIO.workers.dev`. Coloque-o em `js/config.js`, terminando em `/chat`:

```js
window.SATURNIA_CONFIG = {
  apiUrl: 'https://saturnia.SEU-SUBDOMINIO.workers.dev/chat',
};
```

Faça commit e push, e a SaturnIA está no ar.

### Trocando o modelo

O modelo fica em `MODEL`, no `worker/wrangler.toml`. Para ver os disponíveis: `npx wrangler ai models`.

## Rodando localmente

```bash
cd worker
npx wrangler dev        # http://localhost:8787 (usa o Workers AI da sua conta)

# em outro terminal, na raiz do projeto:
npx serve -l 5500 .     # http://localhost:5500
```

Em `js/config.js`, use `http://localhost:8787/chat` enquanto testa.

## Estrutura

```
saturnia/
├── index.html
├── css/style.css
├── js/
│   ├── config.js     ← endereço do servidor
│   ├── eye.js        ← o olho de partículas
│   ├── markdown.js   ← formatação segura das respostas
│   └── app.js        ← lógica do chat
├── assets/favicon.svg
└── worker/
    ├── src/index.js  ← servidor (Cloudflare Worker + Workers AI)
    ├── wrangler.toml
    └── package.json
```

---

Criado por [Ryan Moreira](https://ryanng0104.github.io/portfolio/).
