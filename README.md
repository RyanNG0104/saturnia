# SaturnIA

Um chat de IA com um olho feito de partículas: a pupila acompanha o seu cursor, ele pisca, fica inquieto enquanto pensa e pulsa enquanto responde. Em volta, um anel como o de Saturno.

🔗 **Acesse:** https://ryanng0104.github.io/saturnia/

## Como funciona

```
Navegador (GitHub Pages)  ──POST /chat──▶  Cloudflare Worker  ──▶  Claude (Anthropic)
        ◀──── resposta em tempo real (Server-Sent Events) ────
```

- **Site** (`index.html`, `css/`, `js/`): HTML, CSS e JavaScript puros, sem build. O olho é desenhado num `<canvas>` (`js/eye.js`).
- **Servidor** (`worker/`): um Cloudflare Worker que guarda a chave da API em segredo e repassa a conversa para o modelo `claude-opus-5-5`, usando o SDK oficial `@anthropic-ai/sdk`.

### Proteções do servidor

- Só aceita pedidos vindos dos endereços em `ALLOWED_ORIGINS` (`worker/wrangler.toml`)
- Limite de 15 mensagens por minuto por IP
- Limite de tamanho das mensagens e do histórico
- Se o modelo recusar uma pergunta por segurança, a API tenta automaticamente num modelo alternativo (`fallbacks: "default"`)

## Ligando a IA (uma vez só)

Você precisa de:
1. Uma **chave da API da Anthropic**: crie em https://console.anthropic.com → *API Keys*. O uso é pago por consumo; defina um limite de gastos em *Billing → Limits*.
2. Uma **conta grátis na Cloudflare**: https://dash.cloudflare.com/sign-up

Depois, no terminal:

```bash
cd worker
npm install
npx wrangler login                          # abre o navegador para entrar na Cloudflare
npx wrangler secret put ANTHROPIC_API_KEY   # cole a chave quando pedir (ela não aparece na tela)
npx wrangler deploy                         # publica e mostra o endereço do servidor
```

O `deploy` mostra um endereço como `https://saturnia.SEU-SUBDOMINIO.workers.dev`. Coloque-o em `js/config.js`, terminando em `/chat`:

```js
window.SATURNIA_CONFIG = {
  apiUrl: 'https://saturnia.SEU-SUBDOMINIO.workers.dev/chat',
};
```

Faça commit e push, e a SaturnIA está no ar.

## Rodando localmente

```bash
# servidor
cd worker
echo ANTHROPIC_API_KEY=sua-chave > .dev.vars   # este arquivo é ignorado pelo git
npx wrangler dev                                # http://localhost:8787

# site: sirva a raiz do projeto em http://localhost:5500
npx serve -l 5500 .
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
    ├── src/index.js  ← servidor (Cloudflare Worker)
    ├── wrangler.toml
    └── package.json
```

---

Criado por [Ryan Moreira](https://ryanng0104.github.io/portfolio/).
